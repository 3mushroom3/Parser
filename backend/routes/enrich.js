const express = require('express');
const router = express.Router();
const db = require('../services/db');
const auth = require('../middleware/auth');
const requireAdmin = require('../middleware/requireAdmin');
const { enrichExisting, autoEnrichJob } = require('../services/innEnricher');
const fs = require('fs');
const path = require('path');
const CACHE_FILE = path.join(__dirname, '../../data/inn_cache.json');

let enrichJob = { running: false, done: 0, total: 0, errors: 0, apiCalls: 0, startedAt: null };

router.get('/enrich-status', auth, requireAdmin, (req, res) => {
  const { pending } = db.prepare("SELECT COUNT(*) as pending FROM declarations WHERE farmerType IS NULL OR farmerType = 'unknown'").get();
  const active = enrichJob.running ? enrichJob : autoEnrichJob.running ? { ...autoEnrichJob, auto: true } : enrichJob;
  res.json({ ...active, pending });
});

router.post('/enrich', auth, requireAdmin, (req, res) => {
  if (enrichJob.running || autoEnrichJob.running) return res.json({ ok: false, message: 'Уже запущено' });

  enrichJob.running = true;
  enrichJob.startedAt = new Date().toISOString();

  const records = db.prepare("SELECT * FROM declarations WHERE farmerType IS NULL OR farmerType = 'unknown'").all();

  const saveDb = () => {
    const updateStmt = db.prepare('UPDATE declarations SET farmerType = ?, okved = ?, inn = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?');
    const transaction = db.transaction((recs) => {
      for (const r of recs) {
        updateStmt.run(r.farmerType, r.okved, r.inn, r.id);
      }
    });
    transaction(records);
  };

  setImmediate(() =>
    enrichExisting(records, enrichJob, saveDb).catch(e => {
      console.error('[INN]', e.message);
      enrichJob.running = false;
    })
  );

  res.json({ ok: true, message: 'Обогащение запущено' });
});

router.post('/enrich/stop', auth, requireAdmin, (req, res) => {
  enrichJob.running = false;
  res.json({ ok: true });
});

// GET /api/enrich/cache-stats — статистика кэша обогащения
router.get('/cache-stats', auth, requireAdmin, (req, res) => {
  try {
    const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const keys = Object.keys(cache);
    const known = keys.filter(k => cache[k].farmerType !== 'unknown').length;
    const unknownWithOkved = keys.filter(k => cache[k].farmerType === 'unknown' && cache[k].okved).length;
    const unknownEmpty = keys.filter(k => cache[k].farmerType === 'unknown' && !cache[k].okved).length;
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const stale = keys.filter(k => cache[k].farmerType === 'unknown' && !cache[k].okved && (!cache[k].checkedAt || cache[k].checkedAt < cutoff)).length;
    res.json({ total: keys.length, known, unknownWithOkved, unknownEmpty, staleEmpty: stale });
  } catch (e) {
    res.json({ total: 0, known: 0, unknownWithOkved: 0, unknownEmpty: 0, staleEmpty: 0, error: e.message });
  }
});

// POST /api/enrich/purge-stale — удалить из кэша unknown-записи без ОКВЭД (>30 дней)
// чтобы они были переспрошены при следующем обогащении
router.post('/purge-stale', auth, requireAdmin, (req, res) => {
  if (enrichJob.running || autoEnrichJob.running) {
    return res.status(409).json({ error: 'Дождитесь окончания обогащения перед очисткой кэша' });
  }
  try {
    const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    let removed = 0;
    for (const key of Object.keys(cache)) {
      const e = cache[key];
      if (e.farmerType === 'unknown' && !e.okved && (!e.checkedAt || e.checkedAt < cutoff)) {
        delete cache[key];
        removed++;
      }
    }
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    res.json({ ok: true, removed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
