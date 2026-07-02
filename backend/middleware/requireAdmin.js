const db = require('../services/db');

// Проверяем роль из БД, а не из JWT — это важно: JWT выдаётся при входе
// и содержит роль на момент логина. Если роль изменили позже через админку,
// старый токен всё равно будет иметь role:'user' и блокировать доступ.
// Запрос в БД дешёвый (поиск по PRIMARY KEY) и гарантирует актуальную роль.
module.exports = function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Не авторизован' });

  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.user.id);
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ error: 'Требуются права администратора' });
  }
  next();
};
