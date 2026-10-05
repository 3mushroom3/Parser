/**
 * Обращения коллег: описание проблемы + опциональный скриншот.
 * Любой авторизованный пользователь может отправить, видит только свои;
 * админ видит и обрабатывает все.
 */
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../services/db');
const auth = require('../middleware/auth');
const requireAdmin = require('../middleware/requireAdmin');

// Рядом с БД (backend/data/), а не в корневом data/ — на проде PM2 запускает
// процесс с cwd=backend, и DB_PATH (./data/...) резолвится именно туда.
const uploadDir = path.join(__dirname, '..', 'data', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').slice(0, 10) || '.png';
    cb(null, `fb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/^image\//.test(file.mimetype)) return cb(new Error('Допускаются только изображения'));
    cb(null, true);
  },
});

const STATUSES = ['new', 'in_progress', 'resolved'];

router.post('/', auth, (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Ошибка загрузки файла' });

    const { title, description } = req.body || {};
    if (!title || !title.trim()) return res.status(400).json({ error: 'Заголовок обязателен' });

    const imagePath = req.file ? '/uploads/' + req.file.filename : null;
    const info = db.prepare(
      'INSERT INTO feedback (userId, username, title, description, imagePath) VALUES (?, ?, ?, ?, ?)'
    ).run(req.user.id, req.user.username || '', title.trim().slice(0, 200), (description || '').slice(0, 3000), imagePath);

    const item = db.prepare('SELECT * FROM feedback WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(item);
  });
});

// Список обращений с превью последнего сообщения и числом непрочитанных
// для той стороны, что смотрит (пользователь — ответы админа, админ — сообщения
// пользователя; новое обращение, которое админ ещё не открывал, тоже считается).
const LIST_SQL = `
  SELECT f.*,
    (SELECT text FROM feedback_messages m WHERE m.feedbackId = f.id ORDER BY m.id DESC LIMIT 1) AS lastText,
    (SELECT fromAdmin FROM feedback_messages m WHERE m.feedbackId = f.id ORDER BY m.id DESC LIMIT 1) AS lastFromAdmin,
    CASE WHEN @admin THEN
      (SELECT COUNT(*) FROM feedback_messages m WHERE m.feedbackId = f.id AND m.fromAdmin = 0 AND m.id > COALESCE(f.adminReadMsgId, 0))
      + (f.adminReadMsgId IS NULL)
    ELSE
      (SELECT COUNT(*) FROM feedback_messages m WHERE m.feedbackId = f.id AND m.fromAdmin = 1 AND m.id > COALESCE(f.userReadMsgId, 0))
    END AS unread
  FROM feedback f
  WHERE @admin OR f.userId = @userId
  ORDER BY COALESCE(f.lastMessageAt, f.createdAt) DESC
`;
const listFor = user => db.prepare(LIST_SQL).all({ admin: user.role === 'admin' ? 1 : 0, userId: user.id });

// Свои обращения — любой пользователь
router.get('/mine', auth, (req, res) => {
  res.json(listFor({ ...req.user, role: 'user' }));
});

// Все обращения — только админ
router.get('/', auth, requireAdmin, (req, res) => {
  res.json(listFor(req.user));
});

// Сколько непрочитанного — для значка у «Поддержки» в меню
router.get('/unread', auth, (req, res) => {
  const total = listFor(req.user).reduce((s, f) => s + (f.unread || 0), 0);
  res.json({ unread: total });
});

function ticketFor(req) {
  const item = db.prepare('SELECT * FROM feedback WHERE id = ?').get(req.params.id);
  if (!item) return null;
  if (req.user.role !== 'admin' && item.userId !== req.user.id) return null;
  return item;
}

// Переписка по обращению; заодно отмечаем её прочитанной для смотрящего
router.get('/:id/messages', auth, (req, res) => {
  const item = ticketFor(req);
  if (!item) return res.status(404).json({ error: 'Обращение не найдено' });
  const messages = db.prepare('SELECT id, fromAdmin, text, imagePath, createdAt FROM feedback_messages WHERE feedbackId = ? ORDER BY id').all(item.id);
  const lastId = messages.length ? messages[messages.length - 1].id : 0;
  if (req.user.role === 'admin') db.prepare('UPDATE feedback SET adminReadMsgId = ? WHERE id = ?').run(lastId, item.id);
  else db.prepare('UPDATE feedback SET userReadMsgId = ? WHERE id = ?').run(lastId, item.id);
  res.json({ ticket: item, messages });
});

router.post('/:id/messages', auth, (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Ошибка загрузки файла' });
    const item = ticketFor(req);
    if (!item) return res.status(404).json({ error: 'Обращение не найдено' });
    const text = String((req.body || {}).text || '').trim().slice(0, 3000);
    if (!text && !req.file) return res.status(400).json({ error: 'Пустое сообщение' });

    const fromAdmin = req.user.role === 'admin' && item.userId !== req.user.id ? 1 : 0;
    const imagePath = req.file ? '/uploads/' + req.file.filename : null;
    const info = db.prepare('INSERT INTO feedback_messages (feedbackId, userId, fromAdmin, text, imagePath) VALUES (?, ?, ?, ?, ?)')
      .run(item.id, req.user.id, fromAdmin, text, imagePath);
    // Ответ админа берёт обращение в работу; новое сообщение пользователя
    // в решённом обращении открывает его заново.
    const status = fromAdmin && item.status === 'new' ? 'in_progress'
      : !fromAdmin && item.status === 'resolved' ? 'new' : item.status;
    db.prepare(`UPDATE feedback SET lastMessageAt = CURRENT_TIMESTAMP, status = ?, ${fromAdmin ? 'adminReadMsgId' : 'userReadMsgId'} = ? WHERE id = ?`)
      .run(status, info.lastInsertRowid, item.id);
    const msg = db.prepare('SELECT id, fromAdmin, text, imagePath, createdAt FROM feedback_messages WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ message: msg, status });
  });
});

router.patch('/:id', auth, requireAdmin, (req, res) => {
  const { status } = req.body || {};
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Недопустимый статус' });
  db.prepare('UPDATE feedback SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ ok: true });
});

router.delete('/:id', auth, requireAdmin, (req, res) => {
  const item = db.prepare('SELECT * FROM feedback WHERE id = ?').get(req.params.id);
  const images = [item?.imagePath, ...db.prepare('SELECT imagePath FROM feedback_messages WHERE feedbackId = ?')
    .all(req.params.id).map(m => m.imagePath)].filter(Boolean);
  images.forEach(p => fs.unlink(path.join(uploadDir, path.basename(p)), () => {}));
  db.prepare('DELETE FROM feedback_messages WHERE feedbackId = ?').run(req.params.id);
  db.prepare('DELETE FROM feedback WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
