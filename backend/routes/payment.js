const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../services/db');
const auth = require('../middleware/auth');
const yukassa = require('../services/yukassa');

// Планы подписки (цены в рублях, дни)
const PLANS = {
  ind_month1:  { label: 'Индивидуальный 1 месяц',   days: 30,  price: Number(process.env.PLAN_IND_1M)  || 1000, type: 'individual', maxUsers: 1 },
  month3:      { label: 'Индивидуальный 3 месяца',   days: 90,  price: Number(process.env.PLAN_3M_PRICE)  || 2490, type: 'individual', maxUsers: 1 },
  month12:     { label: 'Индивидуальный 12 месяцев', days: 365, price: Number(process.env.PLAN_12M_PRICE) || 7990, type: 'individual', maxUsers: 1 },
  group_year:  { label: 'Корпоративный 12 месяцев',  days: 365, price: Number(process.env.PLAN_GROUP_YEAR) || 30000, type: 'group', maxUsers: 5,
                 description: 'До 5 пользователей в компании' },
};

// GET /api/payment/plans — список тарифов (публичный)
router.get('/plans', (req, res) => {
  res.json(Object.entries(PLANS).map(([id, p]) => ({ id, ...p })));
});

// GET /api/payment/subscription — статус подписки текущего пользователя
router.get('/subscription', auth, (req, res) => {
  const user = db.prepare('SELECT subscriptionUntil, subscriptionPlan, role, groupId FROM users WHERE id = ?').get(req.user.id);
  const now = new Date();
  let active = user.role === 'admin' || (user.subscriptionUntil && new Date(user.subscriptionUntil) > now);
  let groupInfo = null;

  if (!active && user.groupId) {
    const group = db.prepare('SELECT * FROM group_subscriptions WHERE id = ?').get(user.groupId);
    if (group && group.subscriptionUntil && new Date(group.subscriptionUntil) > now) {
      active = true;
      groupInfo = { name: group.name, until: group.subscriptionUntil, maxUsers: group.maxUsers };
    }
  }

  res.json({
    active,
    subscriptionUntil: user.subscriptionUntil || null,
    subscriptionPlan: user.subscriptionPlan || null,
    isAdmin: user.role === 'admin',
    group: groupInfo,
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
//
// Тело вебхука не подписано и не аутентифицировано — это публичный
// неавторизованный эндпоинт. НЕЛЬЗЯ активировать подписку по одним лишь
// данным из POST-тела: любой может создать платёж через /create, узнать
// свой paymentId, и затем подделать вебхук с "succeeded", получив подписку
// бесплатно. Поэтому статус всегда перепроверяется напрямую у ЮКассы по
// нашим серверным ключам — подделать ответ ЮКассы атакующий не может.
router.post('/webhook', express.json(), async (req, res) => {
  const event = req.body;
  if (!event || event.type !== 'payment.succeeded') return res.sendStatus(200);

  const yPaymentId = event.object?.id;
  const meta = event.object?.metadata;
  if (!yPaymentId || !meta?.paymentId || !meta?.userId || !meta?.planId) return res.sendStatus(200);

  const payment = db.prepare('SELECT * FROM payments WHERE id = ? AND providerPaymentId = ?').get(meta.paymentId, yPaymentId);
  if (!payment || payment.status === 'succeeded') return res.sendStatus(200);

  if (!yukassa.isConfigured()) return res.sendStatus(200);

  try {
    const verified = await yukassa.getPayment(yPaymentId);
    if (verified.status === 'succeeded' && Number(verified.amount?.value) === Number(payment.amount)) {
      activateSubscription(Number(meta.userId), meta.planId, meta.paymentId);
    } else {
      console.warn(`[payment webhook] статус/сумма не подтверждены ЮКассой для ${yPaymentId}: status=${verified.status}`);
    }
  } catch (err) {
    console.error('[payment webhook] ошибка проверки платежа:', err.message);
  }
  res.sendStatus(200);
});

function activateSubscription(userId, planId, paymentId) {
  const plan = PLANS[planId];
  if (!plan) return;

  const user = db.prepare('SELECT subscriptionUntil FROM users WHERE id = ?').get(userId);
  const base = user?.subscriptionUntil && new Date(user.subscriptionUntil) > new Date()
    ? new Date(user.subscriptionUntil) : new Date();
  base.setDate(base.getDate() + plan.days);
  const newUntil = base.toISOString();

  if (plan.type === 'group') {
    // Создаём групповую подписку и назначаем владельца
    const groupId = crypto.randomUUID();
    db.prepare('INSERT INTO group_subscriptions (id, name, ownerId, maxUsers, subscriptionUntil, subscriptionPlan) VALUES (?,?,?,?,?,?)')
      .run(groupId, `Группа пользователя #${userId}`, userId, plan.maxUsers, newUntil, planId);
    db.prepare('UPDATE users SET subscriptionUntil=?, subscriptionPlan=?, groupId=? WHERE id=?')
      .run(newUntil, planId, groupId, userId);
  } else {
    db.prepare('UPDATE users SET subscriptionUntil=?, subscriptionPlan=? WHERE id=?')
      .run(newUntil, planId, userId);
  }

  db.prepare("UPDATE payments SET status='succeeded', updatedAt=CURRENT_TIMESTAMP WHERE id=?")
    .run(paymentId);
}

module.exports = router;
