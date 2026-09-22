const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../services/db');
const crypto = require('crypto');
const _secret = require('../config/jwtSecret');
const { sendVerificationCode, isConfigured: mailerConfigured } = require('../services/mailer');

const MIN_PASSWORD_LEN = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;

function issueSession(res, user) {
  const sessionId = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE users SET sessionId = ? WHERE id = ?').run(sessionId, user.id);
  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, sessionId },
    _secret,
    { expiresIn: '24h' }
  );
  res.json({ token, user: { username: user.username, email: user.email || '', role: user.role, crmEnabled: !!user.crmEnabled } });
}

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

  // username здесь может быть и логином, и email — новые аккаунты входят по
  // почте, старые (заведённые до этой фичи) — по логину, как раньше.
  const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(username, username);

  // Always run bcrypt to prevent timing attacks (even if user not found)
  const hash = user ? user.password : '$2a$10$invalidhashtopreventtimingattack000000000000000';
  const valid = bcrypt.compareSync(password, hash);

  if (!user || !valid) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }

  // Аккаунты без email (старые, до этой фичи) проверку пропускают — им
  // подтверждать нечего. Новые аккаунты обязаны сначала подтвердить почту.
  if (user.email && !user.emailVerified) {
    return res.status(403).json({ error: 'EMAIL_NOT_VERIFIED', email: user.email });
  }

  // Новая сессия вытесняет все предыдущие (защита от одновременного использования
  // одного аккаунта с нескольких устройств)
  issueSession(res, user);
});

function genCode() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }

function issueAndSendCode(userId, email) {
  const code = genCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();
  db.prepare('DELETE FROM email_codes WHERE email = ?').run(email);
  db.prepare('INSERT INTO email_codes (userId, email, code, expiresAt) VALUES (?, ?, ?, ?)').run(userId, email, code, expiresAt);
  return sendVerificationCode(email, code);
}

// Регистрация по email вместо логина/пароля без проверки — код подтверждения
// на почту через Unisender Go (services/mailer.js), без стороннего
// платного flash-call сервиса, который используют конкуренты для телефона.
router.post('/register', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Слишком много попыток. Подождите 15 минут.' });
  }
  if (!mailerConfigured()) {
    return res.status(503).json({ error: 'Регистрация временно недоступна: не настроена отправка почты' });
  }

  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email и пароль обязательны' });
  }
  const normEmail = String(email).trim().toLowerCase();
  if (typeof email !== 'string' || normEmail.length > 254 || !EMAIL_RE.test(normEmail)) {
    return res.status(400).json({ error: 'Некорректный email' });
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LEN) {
    return res.status(400).json({ error: `Пароль должен быть не короче ${MIN_PASSWORD_LEN} символов` });
  }

  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(normEmail);
  if (existing && existing.emailVerified) {
    // Общее сообщение — чтобы нельзя было перебором узнать, какие email уже заняты
    return res.status(400).json({ error: 'Не удалось зарегистрироваться. Попробуйте другой email.' });
  }

  try {
    const passwordHash = bcrypt.hashSync(password, 12);
    let userId;
    if (existing) {
      // Уже начатая, но не подтверждённая регистрация — обновляем пароль и код
      db.prepare('UPDATE users SET password = ? WHERE id = ?').run(passwordHash, existing.id);
      userId = existing.id;
    } else {
      const info = db.prepare('INSERT INTO users (username, email, password) VALUES (?, ?, ?)')
        .run(normEmail, normEmail, passwordHash);
      userId = info.lastInsertRowid;
    }
    await issueAndSendCode(userId, normEmail);
    res.status(201).json({ email: normEmail, message: 'Код отправлен на почту' });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT') {
      return res.status(400).json({ error: 'Не удалось зарегистрироваться. Попробуйте другой email.' });
    }
    console.error('[auth] register:', err.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.post('/confirm-email', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Слишком много попыток. Подождите 15 минут.' });
  }

  const { email, code } = req.body || {};
  if (!email || !code) return res.status(400).json({ error: 'Email и код обязательны' });
  const normEmail = String(email).trim().toLowerCase();

  const row = db.prepare('SELECT * FROM email_codes WHERE email = ? ORDER BY id DESC LIMIT 1').get(normEmail);
  if (!row || new Date(row.expiresAt).getTime() < Date.now()) {
    return res.status(400).json({ error: 'Код истёк. Запросите новый.' });
  }
  if (row.attempts >= MAX_CODE_ATTEMPTS) {
    return res.status(429).json({ error: 'Слишком много попыток. Запросите новый код.' });
  }
  if (String(code).trim() !== row.code) {
    db.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    return res.status(400).json({ error: 'Неверный код' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.userId);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  db.prepare('UPDATE users SET emailVerified = 1 WHERE id = ?').run(user.id);
  db.prepare('DELETE FROM email_codes WHERE email = ?').run(normEmail);
  issueSession(res, { ...user, emailVerified: 1 });
});

router.post('/resend-code', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Слишком много попыток. Подождите 15 минут.' });
  }
  if (!mailerConfigured()) {
    return res.status(503).json({ error: 'Отправка почты временно недоступна' });
  }

  const { email } = req.body || {};
  const normEmail = String(email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normEmail);
  // Отвечаем одинаково независимо от того, нашёлся пользователь или нет —
  // чтобы нельзя было перебором проверить, какие email зарегистрированы
  if (user && !user.emailVerified) {
    try { await issueAndSendCode(user.id, normEmail); } catch (e) { console.error('[auth] resend-code:', e.message); }
  }
  res.json({ ok: true, message: 'Если email зарегистрирован, код отправлен повторно' });
});

router.get('/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT id, username, email, role, subscriptionUntil, subscriptionPlan, created_at, crmEnabled FROM users WHERE id = ?').get(req.user.id);
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

module.exports = router;
