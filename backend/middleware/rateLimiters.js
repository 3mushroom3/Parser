/**
 * Защита от массового скрейпинга базы авторизованным (но скриптовым) клиентом.
 * Ключ — userId (а не IP): несколько сотрудников за одним офисным NAT не должны
 * мешать друг другу, а скрипт с одним аккаунтом — должен упираться в лимит.
 */
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

// Все маршруты, использующие эти лимитеры, идут после auth-middleware, так что
// req.user всегда задан — IP-фоллбэк практически недостижим, но express-rate-limit
// требует IPv6-safe хелпер для валидации конфигурации в любом случае.
function keyByUser(req) {
  return req.user?.id ? `u${req.user.id}` : ipKeyGenerator(req.ip);
}

function handler(label) {
  return (req, res) => {
    console.warn(`[RATE-LIMIT] ${label}: userId=${req.user?.id || '?'} ip=${req.ip} ${req.method} ${req.originalUrl}`);
    res.status(429).json({ error: 'Слишком много запросов. Попробуйте позже.' });
  };
}

// Просмотр/листинг реестра — щедрый лимит на обычное пользование (клики, пагинация),
// но режет скриптовый перебор страниц на высокой скорости.
const dataReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 90,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUser,
  handler: handler('data-read'),
});

// Полная выгрузка базы (CSV) — самый эффективный вектор скрейпинга: один запрос
// вместо тысяч страниц. Лимит жёсткий — обычному пользователю чаще пары раз в час
// экспорт не нужен.
const exportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByUser,
  handler: handler('export'),
});

module.exports = { dataReadLimiter, exportLimiter };
