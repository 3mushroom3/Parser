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
 * Сводка для раздела «Главная»: топ регионов из уже посчитанного справочника
 * geo_places (declCount там обновляет разметка НП). Кэш на те же 5 минут, что
 * у статистики. Динамика деклараций — отдельно, в /dynamics (обновляется чаще).
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

    const data = { topRegions };
    homeCache = { data, computedAt: Date.now() };
    res.json(data);
  } catch (err) {
    next(err);
  }
});

/**
 * «Динамика деклараций» на главной: поданные декларации по дню регистрации
 * (за 30 дней, с разбивкой по типу) и по месяцам (24 месяца — текущий год и
 * прошлый для сравнения). Считаются ВСЕ декларации, а не только действующие:
 * декларация на зерно живёт около года, и фильтр по статусу превращал всё
 * старше года в мнимый провал. Живой парсер доливает текущий месяц каждые
 * 30 минут, фронтенд опрашивает раз в минуту — отсюда кэш на минуту.
 * Все запросы идут по индексу regDate (помесячный — только по индексу), это
 * десятки миллисекунд, поэтому без worker-потока.
 */
const DYN_CACHE_TTL_MS = 60 * 1000;
let dynCache = null;

// regDate — дата регистрации в ФСА, т.е. по Москве; «сегодня» считаем так же,
// иначе с 00:00 до 03:00 МСК сервер в UTC показывал бы вчерашний день.
const mskDate = (d = new Date()) => new Date(d.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);

router.get('/dynamics', auth, (req, res, next) => {
  try {
    if (dynCache && Date.now() - dynCache.computedAt < DYN_CACHE_TTL_MS) return res.json(dynCache.data);

    const today = mskDate();
    const [y, m, d] = today.split('-').map(Number);
    const daysFrom = mskDate(new Date(Date.now() - 29 * 86400 * 1000));
    const monthsFrom = `${y - 2}-${String(m).padStart(2, '0')}-01`;

    const days = db.prepare(`
      SELECT regDate AS date, COUNT(*) AS total,
        SUM(farmerType IN ('farmer', 'farmer_trader')) AS farmer,
        SUM(farmerType = 'trader') AS trader
      FROM declarations
      WHERE regDate >= ? AND regDate <= ?
      GROUP BY regDate ORDER BY regDate
    `).all(daysFrom, today);

    const months = db.prepare(`
      SELECT substr(regDate, 1, 7) AS ym, COUNT(*) AS total
      FROM declarations
      WHERE regDate >= ? AND regDate <= ?
      GROUP BY ym ORDER BY ym
    `).all(monthsFrom, today);

    // Тот же отрезок месяца год назад — для честного сравнения «с начала месяца».
    const lastYearMtd = db.prepare(
      'SELECT COUNT(*) AS n FROM declarations WHERE regDate >= ? AND regDate <= ?'
    ).get(`${y - 1}-${String(m).padStart(2, '0')}-01`, `${y - 1}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`).n;

    const { lastUpdated } = db.prepare('SELECT MAX(updatedAt) AS lastUpdated FROM declarations').get();
    const parser = db.prepare('SELECT state, time FROM status WHERE id = 1').get() || null;

    const data = { today, days, months, lastYearMtd, lastUpdated, parser, computedAt: new Date().toISOString() };
    dynCache = { data, computedAt: Date.now() };
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
