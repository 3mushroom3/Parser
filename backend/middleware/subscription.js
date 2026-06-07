const db = require('../services/db');

module.exports = function requireSubscription(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Требуется авторизация' });
  if (req.user.role === 'admin') return next();

  const user = db.prepare('SELECT subscriptionUntil FROM users WHERE id = ?').get(req.user.id);
  if (!user || !user.subscriptionUntil || new Date(user.subscriptionUntil) < new Date()) {
    return res.status(403).json({
      error: 'Подписка не активна или истекла',
      code: 'SUBSCRIPTION_REQUIRED',
      subscriptionUntil: user?.subscriptionUntil || null,
    });
  }
  next();
};
