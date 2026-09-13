const express = require('express');
const router = express.Router();
const path = require('path');
const { Worker } = require('worker_threads');
const db = require('../services/db');
const auth = require('../middleware/auth');
const requireAdmin = require('../middleware/requireAdmin');
const { sendMessage, loadConfig, saveConfig } = require('../services/telegramBot');

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

router.get('/telegram-config', auth, requireAdmin, (req, res) => {
  res.json(loadConfig());
});

router.post('/telegram-config', auth, requireAdmin, (req, res) => {
  const { botToken, chatId } = req.body || {};
  if (!botToken || !chatId) return res.status(400).json({ error: 'botToken и chatId обязательны' });
  saveConfig({ botToken: String(botToken).trim(), chatId: String(chatId).trim() });
  res.json({ ok: true });
});

router.post('/telegram-test', auth, requireAdmin, async (req, res) => {
  const ok = await sendMessage('✅ Тест уведомлений FSA Parser работает!');
  res.json({ ok });
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
