const express = require('express');
const router = express.Router();
const db = require('../services/db');
const auth = require('../middleware/auth');

router.get('/folders', auth, (req, res) => {
  const folders = db.prepare('SELECT * FROM folders').all();
  const folderItems = db.prepare('SELECT * FROM folder_items').all();

  const foldersWithItems = folders.map(f => ({
    ...f,
    items: folderItems.filter(i => i.folderId === f.id)
  }));

  res.json(foldersWithItems);
});

router.post('/folders', auth, (req, res) => {
  const { name, parentId } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name обязателен' });

  const id = Date.now().toString();
  db.prepare('INSERT INTO folders (id, name, parentId) VALUES (?, ?, ?)').run(id, name.trim(), parentId || null);

  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
  res.status(201).json({ ...folder, items: [] });
});

router.delete('/folders/:id', auth, (req, res) => {
  db.prepare('DELETE FROM folders WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/folders/:id/items', auth, (req, res) => {
  const { type, value, label } = req.body || {};
  if (!type || !value) return res.status(400).json({ error: 'type и value обязательны' });

  const existing = db.prepare('SELECT id FROM folder_items WHERE folderId = ? AND type = ? AND value = ?').get(req.params.id, type, value);

  if (!existing) {
    db.prepare('INSERT INTO folder_items (folderId, type, value, label) VALUES (?, ?, ?, ?)').run(
      req.params.id, type, value, label || null
    );
  }

  res.json({ ok: true });
});

router.delete('/folders/:id/items', auth, (req, res) => {
  const { type, value } = req.body || {};
  db.prepare('DELETE FROM folder_items WHERE folderId = ? AND type = ? AND value = ?').run(req.params.id, type, value);
  res.json({ ok: true });
});

module.exports = router;
