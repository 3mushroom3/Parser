const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../services/db');

const _secret = (() => {
  const s = process.env.JWT_SECRET;
  if (!s) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[SECURITY] КРИТИЧНО: JWT_SECRET не задан! Добавьте в .env: JWT_SECRET=<random-64-chars>');
    }
    return 'dev-only-insecure-secret-change-me';
  }
  return s;
})();

const MIN_PASSWORD_LEN = 8;

// Simple in-memory rate limiter for auth endpoints
const loginAttempts = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 15 * 60 * 1000; }
  entry.count++;
  loginAttempts.set(ip, entry);
  return entry.count > 10; // block after 10 attempts per 15 min
}
// Clean up old entries every hour
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of loginAttempts) if (now > e.resetAt) loginAttempts.delete(ip);
}, 3600000);

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    req.user = jwt.verify(authHeader.slice(7), _secret);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

router.post('/login', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Слишком много попыток. Подождите 15 минут.' });
  }

  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Логин и пароль обязательны' });
  }
  if (typeof username !== 'string' || username.length > 64) {
    return res.status(400).json({ error: 'Некорректный логин' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

  // Always run bcrypt to prevent timing attacks (even if user not found)
  const hash = user ? user.password : '$2a$10$invalidhashtopreventtimingattack000000000000000';
  const valid = bcrypt.compareSync(password, hash);

  if (!user || !valid) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    _secret,
    { expiresIn: '24h' }
  );

  res.json({ token, user: { username: user.username, role: user.role } });
});

router.post('/register', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Слишком много попыток. Подождите 15 минут.' });
  }

  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Логин и пароль обязательны' });
  }
  if (typeof username !== 'string' || username.length < 3 || username.length > 32) {
    return res.status(400).json({ error: 'Логин: от 3 до 32 символов' });
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(username)) {
    return res.status(400).json({ error: 'Логин: только латинские буквы, цифры, _, -, .' });
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LEN) {
    return res.status(400).json({ error: `Пароль должен быть не короче ${MIN_PASSWORD_LEN} символов` });
  }

  try {
    const info = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(
      username, bcrypt.hashSync(password, 12)
    );
    res.status(201).json({ id: info.lastInsertRowid, username });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT') {
      // Generic message to prevent username enumeration
      return res.status(400).json({ error: 'Не удалось зарегистрироваться. Попробуйте другой логин.' });
    }
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.get('/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT id, username, role, subscriptionUntil, subscriptionPlan, tgChatId, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  res.json(user);
});

router.put('/password', authMiddleware, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Текущий и новый пароль обязательны' });
  }
  if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LEN) {
    return res.status(400).json({ error: `Новый пароль: не короче ${MIN_PASSWORD_LEN} символов` });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user || !bcrypt.compareSync(currentPassword, user.password)) {
    return res.status(401).json({ error: 'Неверный текущий пароль' });
  }
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 12), req.user.id);
  res.json({ ok: true });
});

router.put('/telegram', authMiddleware, (req, res) => {
  const { tgChatId } = req.body || {};
  const sanitized = tgChatId ? String(tgChatId).trim().replace(/[^\d-]/g, '') : null;
  db.prepare('UPDATE users SET tgChatId = ? WHERE id = ?').run(sanitized || null, req.user.id);
  res.json({ ok: true });
});

module.exports = router;
