const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../services/db');

const JWT_SECRET = process.env.JWT_SECRET || 'your-very-secure-secret-change-it';

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    req.user = jwt.verify(authHeader.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

router.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: '24h' }
  );

  res.json({ token, user: { username: user.username, role: user.role } });
});

router.post('/register', (req, res) => {
  // Simple registration for demo, should be protected or removed in production
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const hashedPassword = bcrypt.hashSync(password, 10);

  try {
    const info = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(username, hashedPassword);
    res.status(201).json({ id: info.lastInsertRowid, username });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT') {
      return res.status(400).json({ error: 'Username already exists' });
    }
    res.status(500).json({ error: 'Database error' });
  }
});

router.get('/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT id, username, role, subscriptionUntil, subscriptionPlan, tgChatId, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

router.put('/password', authMiddleware, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword и newPassword обязательны' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Новый пароль должен быть не короче 6 символов' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user || !bcrypt.compareSync(currentPassword, user.password)) {
    return res.status(401).json({ error: 'Неверный текущий пароль' });
  }
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), req.user.id);
  res.json({ ok: true });
});

router.put('/telegram', authMiddleware, (req, res) => {
  const { tgChatId } = req.body || {};
  db.prepare('UPDATE users SET tgChatId = ? WHERE id = ?').run(tgChatId ? String(tgChatId).trim() : null, req.user.id);
  res.json({ ok: true });
});

module.exports = router;
