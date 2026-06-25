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

// Свои обращения — любой пользователь
router.get('/mine', auth, (req, res) => {
  const items = db.prepare('SELECT * FROM feedback WHERE userId = ? ORDER BY createdAt DESC').all(req.user.id);
  res.json(items);
});

// Все обращения — только админ
router.get('/', auth, requireAdmin, (req, res) => {
  const items = db.prepare('SELECT * FROM feedback ORDER BY createdAt DESC').all();
  res.json(items);
});

router.patch('/:id', auth, requireAdmin, (req, res) => {
  const { status } = req.body || {};
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Недопустимый статус' });
  db.prepare('UPDATE feedback SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ ok: true });
});

router.delete('/:id', auth, requireAdmin, (req, res) => {
  const item = db.prepare('SELECT * FROM feedback WHERE id = ?').get(req.params.id);
  if (item?.imagePath) {
    const filePath = path.join(uploadDir, path.basename(item.imagePath));
    fs.unlink(filePath, () => {});
  }
  db.prepare('DELETE FROM feedback WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
