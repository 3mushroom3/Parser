const db = require('../services/db');

module.exports = (req, res, next) => {
  const key = req.headers['x-api-key'];
  if (!key) return res.status(401).json({ error: 'Требуется заголовок X-API-Key' });

  const row = db.prepare('SELECT * FROM api_keys WHERE key = ? AND active = 1').get(key);
  if (!row) return res.status(401).json({ error: 'Недействительный API-ключ' });

  db.prepare('UPDATE api_keys SET lastUsedAt = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
  req.apiKey = row;
  next();
};
