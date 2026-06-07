const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../services/db');
const auth = require('../middleware/auth');
const yukassa = require('../services/yukassa');

// Планы подписки (цены в рублях, дни)
const PLANS = {
  month1:  { label: '1 месяц',   days: 30,  price: Number(process.env.PLAN_1M_PRICE)  || 990  },
  month3:  { label: '3 месяца',  days: 90,  price: Number(process.env.PLAN_3M_PRICE)  || 2490 },
  month12: { label: '12 месяцев',days: 365, price: Number(process.env.PLAN_12M_PRICE) || 7990 },
};

// GET /api/payment/plans — список тарифов (публичный)
router.get('/plans', (req, res) => {
  res.json(Object.entries(PLANS).map(([id, p]) => ({ id, ...p })));
});

// GET /api/payment/subscription — статус подписки текущего пользователя
router.get('/subscription', auth, (req, res) => {
  const user = db.prepare('SELECT subscriptionUntil, subscriptionPlan, role FROM users WHERE id = ?').get(req.user.id);
  const active = user.role === 'admin' || (user.subscriptionUntil && new Date(user.subscriptionUntil) > new Date());
  res.json({
    active,
    subscriptionUntil: user.subscriptionUntil || null,
    subscriptionPlan: user.subscriptionPlan || null,
    isAdmin: user.role === 'admin',
  });
});

// POST /api/payment/create — создать платёж ЮКасса
router.post('/create', auth, async (req, res) => {
  const { planId } = req.body;
  const plan = PLANS[planId];
  if (!plan) return res.status(400).json({ error: 'Неверный тарифный план' });

  if (!yukassa.isConfigured()) {
    return res.status(503).json({ error: 'Платёжная система не настроена. Обратитесь к администратору.' });
  }

  const paymentId = crypto.randomUUID();
  const baseUrl = process.env.APP_URL || 'http://localhost:3001';
  const returnUrl = `${baseUrl}/?payment_id=${paymentId}`;

  try {
    const yPayment = await yukassa.createPayment({
      amount: plan.price,
      description: `Подписка «${plan.label}» — Реестр производителей ТР ТС 015`,
      returnUrl,
      metadata: { paymentId, userId: req.user.id, planId },
    });

    db.prepare(`
      INSERT INTO payments (id, userId, amount, plan, status, provider, providerPaymentId)
      VALUES (?, ?, ?, ?, 'pending', 'yukassa', ?)
    `).run(paymentId, req.user.id, plan.price, planId, yPayment.id);

    res.json({ paymentUrl: yPayment.confirmation.confirmation_url, paymentId });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка создания платежа: ' + err.message });
  }
});

// GET /api/payment/check/:paymentId — проверить статус платежа (вызывается после редиректа)
router.get('/check/:paymentId', auth, async (req, res) => {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ? AND userId = ?').get(req.params.paymentId, req.user.id);
  if (!payment) return res.status(404).json({ error: 'Платёж не найден' });

  if (payment.status === 'succeeded') {
    return res.json({ status: 'succeeded' });
  }

  if (!yukassa.isConfigured()) {
    return res.json({ status: payment.status });
  }

  try {
    const yPayment = await yukassa.getPayment(payment.providerPaymentId);
    if (yPayment.status === 'succeeded' && payment.status !== 'succeeded') {
      activateSubscription(req.user.id, payment.plan, payment.id);
    } else if (yPayment.status === 'canceled') {
      db.prepare("UPDATE payments SET status='canceled', updatedAt=CURRENT_TIMESTAMP WHERE id=?").run(payment.id);
    }
    res.json({ status: yPayment.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/payment/webhook — вебхук от ЮКасса (настроить в личном кабинете ЮКасса)
router.post('/webhook', express.json(), (req, res) => {
  const event = req.body;
  if (!event || event.type !== 'payment.succeeded') return res.sendStatus(200);

  const meta = event.object?.metadata;
  if (!meta?.paymentId || !meta?.userId || !meta?.planId) return res.sendStatus(200);

  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(meta.paymentId);
  if (payment && payment.status !== 'succeeded') {
    activateSubscription(Number(meta.userId), meta.planId, meta.paymentId);
  }
  res.sendStatus(200);
});

function activateSubscription(userId, planId, paymentId) {
  const plan = PLANS[planId];
  if (!plan) return;

  const user = db.prepare('SELECT subscriptionUntil FROM users WHERE id = ?').get(userId);
  const base = user?.subscriptionUntil && new Date(user.subscriptionUntil) > new Date()
    ? new Date(user.subscriptionUntil)
    : new Date();

  base.setDate(base.getDate() + plan.days);
  const newUntil = base.toISOString();

  db.prepare('UPDATE users SET subscriptionUntil=?, subscriptionPlan=? WHERE id=?')
    .run(newUntil, planId, userId);
  db.prepare("UPDATE payments SET status='succeeded', updatedAt=CURRENT_TIMESTAMP WHERE id=?")
    .run(paymentId);
}

module.exports = router;
