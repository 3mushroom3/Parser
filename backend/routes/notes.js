const express = require('express');
const router = express.Router();
const db = require('../services/db');
const auth = require('../middleware/auth');

router.get('/', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM notes WHERE userId = ? ORDER BY updatedAt DESC').all(req.user.id);
  res.json(rows.map(n => ({ ...n, links: JSON.parse(n.links || '[]') })));
});

router.post('/', auth, (req, res) => {
  const { title, content, links, notifyTime } = req.body || {};
  if (!title || typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'Заголовок обязателен' });
  }
  const linksStr = JSON.stringify(Array.isArray(links) ? links.slice(0, 20) : []);
  const time = notifyTime && /^\d{2}:\d{2}$/.test(notifyTime) ? notifyTime : null;
  const info = db.prepare(
    'INSERT INTO notes (userId, title, content, links, notifyTime) VALUES (?, ?, ?, ?, ?)'
  ).run(req.user.id, title.trim().slice(0, 200), (content || '').slice(0, 5000), linksStr, time);
  const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ ...note, links: JSON.parse(note.links || '[]') });
});

router.put('/:id', auth, (req, res) => {
  const note = db.prepare('SELECT * FROM notes WHERE id = ? AND userId = ?').get(req.params.id, req.user.id);
  if (!note) return res.status(404).json({ error: 'Не найдено' });

  const { title, content, links, notifyTime } = req.body || {};
  const newTitle = (typeof title === 'string' ? title.trim() : note.title).slice(0, 200) || note.title;
  const newContent = (typeof content === 'string' ? content : note.content).slice(0, 5000);
  const newLinks = JSON.stringify(Array.isArray(links) ? links.slice(0, 20) : JSON.parse(note.links || '[]'));
  const newTime = notifyTime === null ? null
    : (notifyTime && /^\d{2}:\d{2}$/.test(notifyTime) ? notifyTime : note.notifyTime);

  db.prepare('UPDATE notes SET title=?, content=?, links=?, notifyTime=?, notifySentDate=NULL, updatedAt=CURRENT_TIMESTAMP WHERE id=?')
    .run(newTitle, newContent, newLinks, newTime, note.id);
  const updated = db.prepare('SELECT * FROM notes WHERE id = ?').get(note.id);
  res.json({ ...updated, links: JSON.parse(updated.links || '[]') });
});

router.delete('/:id', auth, (req, res) => {
  const info = db.prepare('DELETE FROM notes WHERE id = ? AND userId = ?').run(req.params.id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Не найдено' });
  res.json({ ok: true });
});

module.exports = router;
