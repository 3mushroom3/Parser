const express = require('express');
const router = express.Router();
const db = require('../services/db');
const auth = require('../middleware/auth');
const requireSubscription = require('../middleware/subscription');

router.get('/company', auth, requireSubscription, (req, res) => {
  const { inn, name } = req.query;
  if (!inn && !name) return res.status(400).json({ error: 'inn or name required' });

  let records;
  if (inn) {
    records = db.prepare('SELECT * FROM declarations WHERE inn = ?').all(inn);
  } else {
    records = db.prepare('SELECT * FROM declarations WHERE (LOWER(shortName) = LOWER(?) OR LOWER(applicantName) = LOWER(?) OR LOWER(lastName) = LOWER(?))').all(name, name, name);
  }

  if (!records.length) return res.json({ found: false, decls: [] });

  const first = records[0];
  const key = inn || name;
  const companyInfo = db.prepare('SELECT * FROM companies WHERE id = ?').get(key);

  res.json({
    found: true,
    inn: first.inn || '',
    name: first.shortName || first.applicantName || first.lastName || '',
    address: first.address || '',
    phone: first.phone || '',
    farmerType: first.farmerType || 'unknown',
    okved: first.okved || '',
    lastName: first.lastName || '',
    firstName: first.firstName || '',
    middleName: first.middleName || '',
    applicantName: first.applicantName || '',
    description: companyInfo?.description || '',
    notes: companyInfo?.notes || '',
    decls: records
      .map(r => ({
        id: r.id,
        regDate: r.regDate || '',
        endDate: r.endDate || '',
        productName: r.productName || '',
        batchSize: r.batchSize || '',
        declNumber: r.declNumber || '',
        status: r.status || '',
      }))
      .sort((a, b) => b.regDate.localeCompare(a.regDate)),
  });
});

router.put('/company/notes', auth, (req, res) => {
  const { inn, name, notes, description } = req.body;
  const key = inn || name;
  if (!key) return res.status(400).json({ error: 'inn or name required' });

  const existing = db.prepare('SELECT id FROM companies WHERE id = ?').get(key);

  if (existing) {
    const fields = [];
    const params = [];
    if (notes !== undefined) { fields.push('notes = ?'); params.push(notes); }
    if (description !== undefined) { fields.push('description = ?'); params.push(description); }

    if (fields.length > 0) {
      params.push(key);
      db.prepare(`UPDATE companies SET ${fields.join(', ')}, updatedAt = CURRENT_TIMESTAMP WHERE id = ?`).run(...params);
    }
  } else {
    db.prepare('INSERT INTO companies (id, inn, name, notes, description) VALUES (?, ?, ?, ?, ?)').run(
      key, inn || null, name || null, notes || '', description || ''
    );
  }

  res.json({ ok: true });
});

router.get('/favorites', auth, (req, res) => {
  const favorites = db.prepare('SELECT * FROM favorites').all();
  res.json(favorites);
});

router.post('/favorites', auth, (req, res) => {
  const { inn, name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name обязателен' });

  try {
    db.prepare('INSERT OR IGNORE INTO favorites (inn, name) VALUES (?, ?)').run(inn || '', name);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/favorites', auth, (req, res) => {
  const { inn, name } = req.body || {};
  db.prepare('DELETE FROM favorites WHERE (inn = ? AND name = ?)').run(inn || '', name);
  res.json({ ok: true });
});

module.exports = router;
