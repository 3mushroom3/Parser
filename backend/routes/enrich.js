const express = require('express');
const router = express.Router();
const db = require('../services/db');
const auth = require('../middleware/auth');
const { enrichExisting } = require('../services/innEnricher');

let enrichJob = { running: false, done: 0, total: 0, errors: 0, startedAt: null };

router.get('/enrich-status', auth, (req, res) => {
  const { pending } = db.prepare("SELECT COUNT(*) as pending FROM declarations WHERE farmerType IS NULL OR farmerType = 'unknown'").get();
  res.json({ ...enrichJob, pending });
});

router.post('/enrich', auth, (req, res) => {
  if (enrichJob.running) return res.json({ ok: false, message: 'Уже запущено' });

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

router.post('/enrich/stop', auth, (req, res) => {
  enrichJob.running = false;
  res.json({ ok: true });
});

module.exports = router;
