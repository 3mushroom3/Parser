const jwt = require('jsonwebtoken');
const JWT_SECRET = require('../config/jwtSecret');
const db = require('../services/db');

module.exports = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }

  try {
    const payload = jwt.verify(authHeader.slice(7), JWT_SECRET);
    req.user = payload;

    // Проверяем sessionId: если пользователь вошёл с другого устройства,
    // его sessionId в БД изменился и этот токен больше не действителен.
    if (payload.sessionId) {
      const row = db.prepare('SELECT sessionId FROM users WHERE id = ?').get(payload.id);
      if (!row || row.sessionId !== payload.sessionId) {
        return res.status(401).json({
          error: 'Сессия завершена: выполнен вход с другого устройства',
          code: 'SESSION_INVALIDATED'
        });
      }
    }

    next();
  } catch {
    return res.status(401).json({ error: 'Токен недействителен или истёк' });
  }
};
