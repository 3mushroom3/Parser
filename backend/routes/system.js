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
 * у статистики. Объёмы для графика — отдельно, в /volumes.
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

// ── Объёмы по декларациям (график на главной) ────────────────────────────
// Данные — сводка volume_monthly (workers/volumeStatsWorker.js, раз в час).
const VOLUME_WORKER_PATH = path.join(__dirname, '../workers/volumeStatsWorker.js');
let volumeBuilding = null;
const volumeCache = new Map();

function rebuildVolumeStats() {
  if (volumeBuilding) return volumeBuilding;
  volumeBuilding = new Promise((resolve) => {
    const worker = new Worker(VOLUME_WORKER_PATH);
    worker.once('message', (msg) => {
      worker.terminate();
      volumeCache.clear();
      resolve(msg);
    });
    worker.once('error', (err) => resolve({ error: err.message }));
  }).finally(() => { volumeBuilding = null; });
  return volumeBuilding;
}
router.rebuildVolumeStats = rebuildVolumeStats;

router.get('/volumes', auth, (req, res, next) => {
  try {
    const region = String(req.query.region || '');
    const district = region ? String(req.query.district || '') : '';
    const crop = String(req.query.crop || '');
    const key = JSON.stringify([region, district, crop]);
    const hit = volumeCache.get(key);
    if (hit) return res.json(hit);

    const where = [], params = [];
    if (region) { where.push('region = ?'); params.push(region); }
    if (district) { where.push('district = ?'); params.push(district); }
    if (crop) { where.push('crop = ?'); params.push(crop); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    // Списки для фильтров считаем с учётом остальных условий, кроме своего
    const wExcept = (skip) => {
      const parts = [], ps = [];
      if (region && skip !== 'region') { parts.push('region = ?'); ps.push(region); }
      if (district && skip !== 'region' && skip !== 'district') { parts.push('district = ?'); ps.push(district); }
      if (crop && skip !== 'crop') { parts.push('crop = ?'); ps.push(crop); }
      return [parts.length ? 'WHERE ' + parts.join(' AND ') : '', ps];
    };

    const months = db.prepare(`SELECT ym, ROUND(SUM(tons)) tons, SUM(n) n, SUM(big) big FROM volume_monthly ${w} GROUP BY ym ORDER BY ym`).all(...params);
    const [wr, pr] = wExcept('region');
    const regions = db.prepare(`SELECT region v, ROUND(SUM(tons)) tons FROM volume_monthly ${wr ? wr + " AND region != ''" : "WHERE region != ''"} GROUP BY region ORDER BY tons DESC`).all(...pr);
    let districts = [];
    if (region) {
      const [wd, pd] = wExcept('district');
      districts = db.prepare(`SELECT district v, ROUND(SUM(tons)) tons FROM volume_monthly ${wd} ${wd ? 'AND' : 'WHERE'} district != '' GROUP BY district ORDER BY tons DESC`).all(...pd);
    }
    const [wc, pc] = wExcept('crop');
    const crops = db.prepare(`SELECT crop v, ROUND(SUM(tons)) tons FROM volume_monthly ${wc} GROUP BY crop ORDER BY tons DESC`).all(...pc);
    const meta = db.prepare('SELECT builtAt, maxBatchTons FROM volume_meta WHERE id = 1').get() || {};

    const data = { months, regions, districts, crops, builtAt: meta.builtAt || null, maxBatchTons: meta.maxBatchTons || null, today: mskDate() };
    volumeCache.set(key, data);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// regDate — дата регистрации в ФСА, т.е. по Москве; «сегодня» считаем так же,
// иначе с 00:00 до 03:00 МСК сервер в UTC показывал бы вчерашний день.
const mskDate = (d = new Date()) => new Date(d.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);

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
