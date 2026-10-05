const express = require('express');
const router = express.Router();
const db = require('../services/db');
const auth = require('../middleware/auth');

const STAGES = ['meeting', 'contract', 'documents', 'call', 'payment', 'shipment', 'check'];
const normStage = s => (STAGES.includes(s) ? s : '');

// Ссылка в заметке — либо на карточку внутри сервиса (компания по ИНН/названию
// или декларация по id), либо произвольный внешний адрес, который пользователь
// вписал сам. Адреса pub.fsa.gov.ru не принимаем никогда: сервис не должен
// уводить пользователя на первоисточник.
const isFsaUrl = u => /(^|\.|\/\/)fsa\.gov\.ru/i.test(String(u || ''));
function normLink(l) {
  if (!l || typeof l !== 'object') return null;
  const label = String(l.label || '').trim().slice(0, 200);
  if (l.kind === 'company' && (l.inn || label)) {
    return { kind: 'company', label, inn: String(l.inn || '').slice(0, 20) };
  }
  if (l.kind === 'decl' && l.id) {
    return { kind: 'decl', label, id: String(l.id).slice(0, 64) };
  }
  const url = String(l.url || '').trim().slice(0, 500);
  if (url && (isFsaUrl(url) || !/^https?:\/\//i.test(url))) return label ? { label } : null;
  if (!label && !url) return null;
  return url ? { label: label || url, url } : { label };
}
const normLinks = links => (Array.isArray(links) ? links.map(normLink).filter(Boolean).slice(0, 20) : []);

router.get('/', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM notes WHERE userId = ? ORDER BY updatedAt DESC').all(req.user.id);
  res.json(rows.map(n => ({ ...n, links: normLinks(JSON.parse(n.links || '[]')) })));
});

// notifyTime — ISO-строка (datetime-local с фронта); пустая строка/null снимает напоминание
const normNotifyTime = t => (t ? new Date(t).toISOString() : null);

router.post('/', auth, (req, res) => {
  const { title, content, links, stage, notifyTime } = req.body || {};
  if (!title || typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'Заголовок обязателен' });
  }
  const linksStr = JSON.stringify(normLinks(links));
  const info = db.prepare(
    'INSERT INTO notes (userId, title, content, links, stage, notifyTime) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(req.user.id, title.trim().slice(0, 200), (content || '').slice(0, 5000), linksStr, normStage(stage), normNotifyTime(notifyTime));
  const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ ...note, links: JSON.parse(note.links || '[]') });
});

router.put('/:id', auth, (req, res) => {
  const note = db.prepare('SELECT * FROM notes WHERE id = ? AND userId = ?').get(req.params.id, req.user.id);
  if (!note) return res.status(404).json({ error: 'Не найдено' });

  const { title, content, links, stage, notifyTime } = req.body || {};
  const newTitle = (typeof title === 'string' ? title.trim() : note.title).slice(0, 200) || note.title;
  const newContent = (typeof content === 'string' ? content : note.content).slice(0, 5000);
  const newLinks = JSON.stringify(normLinks(Array.isArray(links) ? links : JSON.parse(note.links || '[]')));
  const newStage = stage === undefined ? (note.stage || '') : normStage(stage);
  const newNotifyTime = notifyTime === undefined ? note.notifyTime : normNotifyTime(notifyTime);
  // Сдвинули время напоминания — снова разрешаем боту отправить его
  const notifySentDate = newNotifyTime !== note.notifyTime ? null : note.notifySentDate;

  db.prepare('UPDATE notes SET title=?, content=?, links=?, stage=?, notifyTime=?, notifySentDate=?, updatedAt=CURRENT_TIMESTAMP WHERE id=?')
    .run(newTitle, newContent, newLinks, newStage, newNotifyTime, notifySentDate, note.id);
  const updated = db.prepare('SELECT * FROM notes WHERE id = ?').get(note.id);
  res.json({ ...updated, links: JSON.parse(updated.links || '[]') });
});

router.post('/:id/link', auth, (req, res) => {
  const note = db.prepare('SELECT * FROM notes WHERE id = ? AND userId = ?').get(req.params.id, req.user.id);
  if (!note) return res.status(404).json({ error: 'Не найдено' });

  const link = normLink(req.body);
  if (!link) return res.status(400).json({ error: 'Нечего добавить' });

  const links = normLinks(JSON.parse(note.links || '[]'));
  // Та же компания/декларация второй раз не дублируется
  const same = l => (link.kind === 'company' && l.kind === 'company' && (l.inn || l.label) === (link.inn || link.label))
    || (link.kind === 'decl' && l.kind === 'decl' && l.id === link.id);
  if (!links.some(same)) links.push(link);

  db.prepare('UPDATE notes SET links=?, updatedAt=CURRENT_TIMESTAMP WHERE id=?')
    .run(JSON.stringify(links.slice(0, 20)), note.id);
  const updated = db.prepare('SELECT * FROM notes WHERE id = ?').get(note.id);
  res.json({ ...updated, links: JSON.parse(updated.links || '[]') });
});

router.delete('/:id', auth, (req, res) => {
  const info = db.prepare('DELETE FROM notes WHERE id = ? AND userId = ?').run(req.params.id, req.user.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Не найдено' });
  res.json({ ok: true });
});

module.exports = router;
