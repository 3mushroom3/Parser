const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../services/db');
const auth = require('../middleware/auth');

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Доступ только для администраторов' });
  }
  next();
}

// GET /api/admin/users — список пользователей
router.get('/users', auth, requireAdmin, (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.username, u.role, u.subscriptionUntil, u.subscriptionPlan, u.created_at,
      (SELECT COUNT(*) FROM payments WHERE userId = u.id AND status = 'succeeded') as paymentCount,
      (SELECT SUM(amount) FROM payments WHERE userId = u.id AND status = 'succeeded') as totalPaid
    FROM users u ORDER BY u.created_at DESC
  `).all();
  res.json(users);
});

// PUT /api/admin/users/:id/subscription — установить подписку вручную
router.put('/users/:id/subscription', auth, requireAdmin, (req, res) => {
  const { days, until, plan } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  let newUntil;
  if (until) {
    newUntil = new Date(until).toISOString();
  } else if (days) {
    const base = user.subscriptionUntil && new Date(user.subscriptionUntil) > new Date()
      ? new Date(user.subscriptionUntil)
      : new Date();
    base.setDate(base.getDate() + Number(days));
    newUntil = base.toISOString();
  } else {
    return res.status(400).json({ error: 'Укажите days или until' });
  }

  db.prepare('UPDATE users SET subscriptionUntil=?, subscriptionPlan=? WHERE id=?')
    .run(newUntil, plan || 'manual', req.params.id);
  res.json({ ok: true, subscriptionUntil: newUntil });
});

// DELETE /api/admin/users/:id/subscription — отозвать подписку
router.delete('/users/:id/subscription', auth, requireAdmin, (req, res) => {
  db.prepare('UPDATE users SET subscriptionUntil=NULL, subscriptionPlan=NULL WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// PUT /api/admin/users/:id/role — изменить роль
router.put('/users/:id/role', auth, requireAdmin, (req, res) => {
  const { role } = req.body;
  if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'Недопустимая роль' });
  db.prepare('UPDATE users SET role=? WHERE id=?').run(role, req.params.id);
  res.json({ ok: true });
});

// DELETE /api/admin/users/:id — удалить пользователя
router.delete('/users/:id', auth, requireAdmin, (req, res) => {
  if (Number(req.params.id) === req.user.id) {
    return res.status(400).json({ error: 'Нельзя удалить самого себя' });
  }
  db.prepare('DELETE FROM payments WHERE userId=?').run(req.params.id);
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// POST /api/admin/users/:id/password — сменить пароль пользователю
router.post('/users/:id/password', auth, requireAdmin, (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 4) return res.status(400).json({ error: 'Минимум 4 символа' });
  const hashed = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE users SET password=? WHERE id=?').run(hashed, req.params.id);
  res.json({ ok: true });
});

// GET /api/admin/payments — история платежей
router.get('/payments', auth, requireAdmin, (req, res) => {
  const payments = db.prepare(`
    SELECT p.*, u.username
    FROM payments p JOIN users u ON p.userId = u.id
    ORDER BY p.createdAt DESC LIMIT 200
  `).all();
  res.json(payments);
});

// GET /api/admin/stats — сводная статистика
router.get('/stats', auth, requireAdmin, (req, res) => {
  const totalUsers    = db.prepare("SELECT COUNT(*) as n FROM users WHERE role != 'admin'").get().n;
  const activeUsers   = db.prepare("SELECT COUNT(*) as n FROM users WHERE subscriptionUntil > CURRENT_TIMESTAMP").get().n;
  const totalRevenue  = db.prepare("SELECT COALESCE(SUM(amount),0) as n FROM payments WHERE status='succeeded'").get().n;
  const monthRevenue  = db.prepare("SELECT COALESCE(SUM(amount),0) as n FROM payments WHERE status='succeeded' AND createdAt >= date('now','-30 days')").get().n;
  res.json({ totalUsers, activeUsers, totalRevenue, monthRevenue });
});

module.exports = router;
