const express = require('express');
const router = express.Router();
const path = require('path');
const { Worker } = require('worker_threads');
const db = require('../services/db');
const auth = require('../middleware/auth');
const requireAdmin = require('../middleware/requireAdmin');

// This will be set by server.js
let runParserFn = null;
let apiClientRef  = null;

router.setRunParser = (fn) => { runParserFn = fn; };
router.setApiClient = (client) => { apiClientRef = client; };

router.get('/status', (req, res) => {
  const status = db.prepare('SELECT * FROM status WHERE id = 1').get();
  const { totalRecords } = db.prepare('SELECT COUNT(*) as totalRecords FROM declarations').get();
  const { lastUpdated } = db.prepare('SELECT MAX(updatedAt) as lastUpdated FROM declarations').get();

  res.json({
    ...(status || { state: 'idle', message: 'Ожидание', time: null }),
    totalRecords,
    lastUpdated
  });
});

// 8 агрегатов (COUNT(DISTINCT CASE/COALESCE...), GROUP BY) по всей таблице —
// на 4.9M строк синхронно это отнимало у event loop десятки секунд разом,
// блокируя заодно и все остальные запросы. Считаем в отдельном потоке
// (см. workers/statsQueryWorker.js — там же и комментарий про
// farmer_trader/trader_farmer) и кэшируем на 5 минут: у эндпоинта нет
// параметров, поэтому кэш всего один, без сигнатур фильтров.
const STATS_CACHE_TTL_MS = 5 * 60 * 1000;
const STATS_WORKER_PATH = path.join(__dirname, '../workers/statsQueryWorker.js');
let statsCache = null; // { stats, computedAt }
let statsComputing = null; // Promise, чтобы не считать параллельно на конкурентные запросы

function computeStats() {
  return new Promise((resolve, reject) => {
    const worker = new Worker(STATS_WORKER_PATH);
    worker.once('message', (msg) => {
      worker.terminate();
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg.stats);
    });
    worker.once('error', (err) => {
      worker.terminate();
      reject(err);
    });
  });
}

let homeCache = null; // { data, computedAt }

/**
 * Сводка для раздела «Главная». Оба запроса дешёвые: регионы берутся из уже
 * посчитанного справочника geo_places (declCount там обновляет разметка НП),
 * помесячная динамика — группировка по первым семи символам даты (regDate
 * хранится в ISO, «2025-05-13»). Ответ кешируется на те же 5 минут, что и
 * статистика: страница открывается часто, а числа меняются раз в сутки.
 */
router.get('/home', auth, (req, res, next) => {
  try {
    if (homeCache && Date.now() - homeCache.computedAt < STATS_CACHE_TTL_MS) {
      return res.json(homeCache.data);
    }
    const topRegions = db.prepare(`
      SELECT region, SUM(declCount) AS count
      FROM geo_places
      WHERE region IS NOT NULL AND region != '' AND declCount > 0
      GROUP BY region ORDER BY count DESC LIMIT 6
    `).all();

    const from = new Date();
    from.setMonth(from.getMonth() - 11);
    const fromYm = from.toISOString().slice(0, 7) + '-01';
    const monthly = db.prepare(`
      SELECT substr(regDate, 1, 7) AS ym, COUNT(*) AS count
      FROM declarations
      WHERE status = 'active' AND regDate >= ?
      GROUP BY ym ORDER BY ym
    `).all(fromYm);

    const data = { topRegions, monthly };
    homeCache = { data, computedAt: Date.now() };
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get('/stats', async (req, res, next) => {
  try {
    if (statsCache && Date.now() - statsCache.computedAt < STATS_CACHE_TTL_MS) {
      return res.json(statsCache.stats);
    }
    if (!statsComputing) {
      statsComputing = computeStats()
        .then(stats => { statsCache = { stats, computedAt: Date.now() }; return stats; })
        .finally(() => { statsComputing = null; });
    }
    res.json(await statsComputing);
  } catch (err) {
    next(err);
  }
});

router.post('/parse', auth, requireAdmin, (req, res) => {
  if (runParserFn) {
    runParserFn();
    res.json({ ok: true, message: 'Запущен' });
  } else {
    res.status(500).json({ error: 'Parser not initialized' });
  }
});

// POST /api/settoken — установить FSA JWT вручную (без перезапуска сервера)
router.post('/settoken', auth, requireAdmin, (req, res) => {
  const { token } = req.body || {};
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return res.status(400).json({ error: 'Передайте поле token с валидным JWT' });
  }
  if (!apiClientRef) return res.status(503).json({ error: 'apiClient не инициализирован' });
  const ok = apiClientRef.setManualToken(token.trim());
  if (!ok) return res.status(400).json({ error: 'Токен не прошёл проверку формата JWT' });
  res.json({ ok: true, message: 'FSA токен установлен вручную' });
});

// DELETE /api/settoken — сбросить ручной токен (вернуться к авто-логину)
router.delete('/settoken', auth, requireAdmin, (req, res) => {
  if (!apiClientRef) return res.status(503).json({ error: 'apiClient не инициализирован' });
  apiClientRef.clearManualToken();
  apiClientRef.invalidateToken();
  res.json({ ok: true, message: 'Ручной токен сброшен, следующий парсинг выполнит авто-логин' });
});

module.exports = router;
