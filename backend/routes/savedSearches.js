const express = require('express');
const router = express.Router();
const db = require('../services/db');
const auth = require('../middleware/auth');

router.get('/', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM saved_searches WHERE userId = ? ORDER BY createdAt DESC').all(req.user.id);
  res.json(rows.map(r => ({ ...r, filterJson: JSON.parse(r.filterJson || '{}') })));
});

router.post('/', auth, (req, res) => {
  const { name, filter } = req.body || {};
  const info = db.prepare('INSERT INTO saved_searches (userId, name, filterJson, lastCheckedAt) VALUES (?, ?, ?, ?)')
    .run(req.user.id, (name || '').slice(0, 100), JSON.stringify(filter || {}), new Date().toISOString());
  res.status(201).json({ id: info.lastInsertRowid });
});

router.put('/:id/active', auth, (req, res) => {
  const { active } = req.body || {};
  const info = db.prepare('UPDATE saved_searches SET active=? WHERE id=? AND userId=?').run(active ? 1 : 0, req.params.id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Не найдено' });
  res.json({ ok: true });
});

router.delete('/:id', auth, (req, res) => {
  const info = db.prepare('DELETE FROM saved_searches WHERE id=? AND userId=?').run(req.params.id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Не найдено' });
  res.json({ ok: true });
});

module.exports = router;
