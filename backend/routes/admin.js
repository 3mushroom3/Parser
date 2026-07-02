const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../services/db');
const auth = require('../middleware/auth');
const multer = require('multer');
const { backfillMissingInn, findAmbiguousInnGroups, resolveAmbiguousGroup, dismissAmbiguousGroup } = require('../services/dedupe');
const { archiveOldDeclarations, ARCHIVE_AFTER_DAYS } = require('../services/archiver');
const { importXlsx } = require('../services/xlsImporter');

const xlsUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

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
  if (!password || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Минимум 8 символов' });
  }
  const hashed = bcrypt.hashSync(password, 12);
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

// GET /api/admin/api-keys — список ключей внешнего API
router.get('/api-keys', auth, requireAdmin, (req, res) => {
  const keys = db.prepare('SELECT id, key, label, active, createdAt, lastUsedAt FROM api_keys ORDER BY id DESC').all();
  res.json(keys);
});

// POST /api/admin/api-keys — создать новый ключ
router.post('/api-keys', auth, requireAdmin, (req, res) => {
  const { label } = req.body || {};
  const key = crypto.randomBytes(24).toString('hex');
  const info = db.prepare('INSERT INTO api_keys (key, label) VALUES (?, ?)').run(key, label || '');
  res.status(201).json({ id: info.lastInsertRowid, key, label: label || '', active: 1 });
});

// DELETE /api/admin/api-keys/:id — отозвать ключ
router.delete('/api-keys/:id', auth, requireAdmin, (req, res) => {
  db.prepare('UPDATE api_keys SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// POST /api/admin/dedupe-inn — проставить ИНН записям без него, если у того же
// имя+адрес есть ровно один известный ИНН (объединяет "размножившиеся" карточки)
router.post('/dedupe-inn', auth, requireAdmin, (req, res) => {
  const updated = backfillMissingInn();
  res.json({ ok: true, updated });
});

// GET /api/admin/dedupe-ambiguous — отчёт по группам имя+адрес с несколькими разными ИНН
router.get('/dedupe-ambiguous', auth, requireAdmin, (req, res) => {
  res.json(findAmbiguousInnGroups());
});

// POST /api/admin/dedupe-resolve — вручную выбрать правильный ИНН для спорной группы
router.post('/dedupe-resolve', auth, requireAdmin, (req, res) => {
  const { nameKey, addrKey, inn } = req.body || {};
  if (!nameKey || !inn) return res.status(400).json({ error: 'nameKey и inn обязательны' });
  const updated = resolveAmbiguousGroup(nameKey, addrKey || '', inn);
  res.json({ ok: true, updated });
});

// POST /api/admin/dedupe-dismiss — пометить спорную группу как "не дубль" (скрыть из отчёта)
router.post('/dedupe-dismiss', auth, requireAdmin, (req, res) => {
  const { nameKey, addrKey } = req.body || {};
  if (!nameKey) return res.status(400).json({ error: 'nameKey обязателен' });
  dismissAmbiguousGroup(nameKey, addrKey || '');
  res.json({ ok: true });
});

// POST /api/admin/archive-old — перевести в архив декларации старше года, помеченные ФСА как "действует"
router.post('/archive-old', auth, requireAdmin, (req, res) => {
  const updated = archiveOldDeclarations();
  res.json({ ok: true, updated, archiveAfterDays: ARCHIVE_AFTER_DAYS });
});

// POST /api/admin/reset-parser-checkpoint — забыть, до какого окна дошёл парсер,
// следующий прогон пересканирует историю с FSA_DATE_FROM заново
router.post('/reset-parser-checkpoint', auth, requireAdmin, (req, res) => {
  db.prepare('UPDATE status SET lastCompletedDate = NULL WHERE id = 1').run();
  res.json({ ok: true });
});

// ── Управление групповыми подписками ──────────────────────────────────────

// GET /api/admin/groups — список всех групп
router.get('/groups', auth, requireAdmin, (req, res) => {
  const groups = db.prepare(`
    SELECT g.*, u.username as ownerName,
      (SELECT COUNT(*) FROM users WHERE groupId = g.id) as memberCount
    FROM group_subscriptions g JOIN users u ON g.ownerId = u.id
    ORDER BY g.createdAt DESC
  `).all();
  const members = db.prepare('SELECT id, username, groupId FROM users WHERE groupId IS NOT NULL').all();
  res.json(groups.map(g => ({
    ...g,
    members: members.filter(m => m.groupId === g.id)
  })));
});

// POST /api/admin/groups — создать группу вручную (для ручного выставления счёта)
router.post('/groups', auth, requireAdmin, (req, res) => {
  const { name, ownerId, maxUsers = 5, days = 365 } = req.body || {};
  if (!name || !ownerId) return res.status(400).json({ error: 'name и ownerId обязательны' });
  const until = new Date();
  until.setDate(until.getDate() + days);
  const id = require('crypto').randomUUID();
  db.prepare('INSERT INTO group_subscriptions (id, name, ownerId, maxUsers, subscriptionUntil, subscriptionPlan) VALUES (?,?,?,?,?,?)')
    .run(id, name, ownerId, maxUsers, until.toISOString(), 'group_year');
  db.prepare('UPDATE users SET subscriptionUntil=?, subscriptionPlan=?, groupId=? WHERE id=?')
    .run(until.toISOString(), 'group_year', id, ownerId);
  res.status(201).json({ ok: true, id });
});

// POST /api/admin/groups/:id/members — добавить пользователя в группу
router.post('/groups/:id/members', auth, requireAdmin, (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId обязателен' });
  const group = db.prepare('SELECT * FROM group_subscriptions WHERE id = ?').get(req.params.id);
  if (!group) return res.status(404).json({ error: 'Группа не найдена' });
  const currentCount = db.prepare('SELECT COUNT(*) c FROM users WHERE groupId = ?').get(req.params.id).c;
  if (currentCount >= group.maxUsers) return res.status(400).json({ error: `Лимит группы: ${group.maxUsers} пользователей` });
  db.prepare('UPDATE users SET groupId = ? WHERE id = ?').run(req.params.id, userId);
  res.json({ ok: true });
});

// DELETE /api/admin/groups/:id/members/:userId — удалить пользователя из группы
router.delete('/groups/:id/members/:userId', auth, requireAdmin, (req, res) => {
  db.prepare('UPDATE users SET groupId = NULL WHERE id = ? AND groupId = ?').run(req.params.userId, req.params.id);
  res.json({ ok: true });
});

// POST /api/admin/import-xlsx — импорт производителей из XLS/XLSX-файла
router.post('/import-xlsx', auth, requireAdmin, (req, res) => {
  xlsUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Файл не передан' });
    try {
      const result = importXlsx(req.file.buffer, { skipExisting: req.body.skipExisting === '1' });
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

module.exports = router;
