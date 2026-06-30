const express = require('express');
const router = express.Router();
const db = require('../services/db');
const auth = require('../middleware/auth');

router.get('/', auth, (req, res) => {
  const uid = req.user.id;
  const folders = db.prepare('SELECT * FROM folders WHERE userId = ?').all(uid);
  const folderIds = folders.map(f => f.id);
  const folderItems = folderIds.length
    ? db.prepare(`SELECT * FROM folder_items WHERE folderId IN (${folderIds.map(() => '?').join(',')})`).all(...folderIds)
    : [];

  const foldersWithItems = folders.map(f => ({
    ...f,
    items: folderItems.filter(i => i.folderId === f.id)
  }));

  res.json(foldersWithItems);
});

router.post('/', auth, (req, res) => {
  const { name, parentId } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name обязателен' });

  const id = Date.now().toString();
  db.prepare('INSERT INTO folders (id, userId, name, parentId) VALUES (?, ?, ?, ?)').run(id, req.user.id, name.trim(), parentId || null);

  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
  res.status(201).json({ ...folder, items: [] });
});

router.delete('/:id', auth, (req, res) => {
  db.prepare('DELETE FROM folders WHERE id = ? AND userId = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

router.post('/:id/items', auth, (req, res) => {
  const { type, value, label } = req.body || {};
  if (!type || !value) return res.status(400).json({ error: 'type и value обязательны' });

  // проверяем что папка принадлежит этому пользователю
  const folder = db.prepare('SELECT id FROM folders WHERE id = ? AND userId = ?').get(req.params.id, req.user.id);
  if (!folder) return res.status(403).json({ error: 'Папка не найдена' });

  const existing = db.prepare('SELECT id FROM folder_items WHERE folderId = ? AND type = ? AND value = ?').get(req.params.id, type, value);
  if (!existing) {
    db.prepare('INSERT INTO folder_items (folderId, type, value, label) VALUES (?, ?, ?, ?)').run(
      req.params.id, type, value, label || null
    );
  }

  res.json({ ok: true });
});

router.delete('/:id/items', auth, (req, res) => {
  const { type, value } = req.body || {};
  const folder = db.prepare('SELECT id FROM folders WHERE id = ? AND userId = ?').get(req.params.id, req.user.id);
  if (!folder) return res.status(403).json({ error: 'Папка не найдена' });

  db.prepare('DELETE FROM folder_items WHERE folderId = ? AND type = ? AND value = ?').run(req.params.id, type, value);
  res.json({ ok: true });
});

module.exports = router;
