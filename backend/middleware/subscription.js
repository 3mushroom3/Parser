const db = require('../services/db');

module.exports = function requireSubscription(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Требуется авторизация' });
  if (req.user.role === 'admin') return next();

  const user = db.prepare('SELECT subscriptionUntil, groupId FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(401).json({ error: 'Пользователь не найден' });

  const now = new Date();

  // Индивидуальная подписка
  if (user.subscriptionUntil && new Date(user.subscriptionUntil) > now) return next();

  // Групповая подписка через компанию
  if (user.groupId) {
    const group = db.prepare('SELECT subscriptionUntil FROM group_subscriptions WHERE id = ?').get(user.groupId);
    if (group && group.subscriptionUntil && new Date(group.subscriptionUntil) > now) return next();
  }

  return res.status(403).json({
    error: 'Подписка не активна или истекла',
    code: 'SUBSCRIPTION_REQUIRED',
    subscriptionUntil: user.subscriptionUntil || null,
  });
};
