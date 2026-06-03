const express = require('express');
const router = express.Router();
const db = require('../services/db');
const auth = require('../middleware/auth');
const { sendMessage, loadConfig, saveConfig } = require('../services/telegramBot');

// This will be set by server.js
let runParserFn = null;

router.setRunParser = (fn) => {
  runParserFn = fn;
};

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

router.get('/stats', (req, res) => {
  const { uniqueProducers } = db.prepare(`
    SELECT COUNT(DISTINCT CASE
      WHEN inn IS NOT NULL AND inn != '' THEN inn
      ELSE COALESCE(NULLIF(shortName, ''), NULLIF(applicantName, ''), lastName)
    END) as uniqueProducers
    FROM declarations
  `).get();

  const statusStats = db.prepare('SELECT status, COUNT(*) as count FROM declarations GROUP BY status').all();
  const sourceStats = db.prepare('SELECT source, COUNT(*) as count FROM declarations GROUP BY source').all();

  const stats = {
    total: uniqueProducers,
    active: statusStats.find(s => s.status === 'active')?.count || 0,
    suspended: statusStats.find(s => s.status === 'suspended')?.count || 0,
    expired: statusStats.find(s => s.status === 'expired')?.count || 0,
    manual: sourceStats.find(s => s.source === 'manual')?.count || 0,
    fsa: sourceStats.find(s => s.source === 'fsa')?.count || 0,
  };

  res.json(stats);
});

router.post('/parse', auth, (req, res) => {
  if (runParserFn) {
    runParserFn();
    res.json({ ok: true, message: 'Запущен' });
  } else {
    res.status(500).json({ error: 'Parser not initialized' });
  }
});

router.get('/telegram-config', auth, (req, res) => {
  res.json(loadConfig());
});

router.post('/telegram-config', auth, (req, res) => {
  const { botToken, chatId } = req.body || {};
  if (!botToken || !chatId) return res.status(400).json({ error: 'botToken и chatId обязательны' });
  saveConfig({ botToken: String(botToken).trim(), chatId: String(chatId).trim() });
  res.json({ ok: true });
});

router.post('/telegram-test', auth, async (req, res) => {
  const ok = await sendMessage('✅ Тест уведомлений FSA Parser работает!');
  res.json({ ok });
});

module.exports = router;
