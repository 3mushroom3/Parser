const express = require('express');
const router = express.Router();
const db = require('../services/db');
const auth = require('../middleware/auth');
const requireSubscription = require('../middleware/subscription');
const { dataReadLimiter } = require('../middleware/rateLimiters');
const eb = require('../services/exportBaseClient');

const DORMANT_AFTER_DAYS = 547; // 1.5 года без новых деклараций

router.get('/company', auth, requireSubscription, dataReadLimiter, (req, res) => {
  const { inn, name } = req.query;
  if (!inn && !name) return res.status(400).json({ error: 'inn or name required' });

  let records;
  if (inn) {
    records = db.prepare('SELECT * FROM declarations WHERE inn = ?').all(inn);
  } else {
    records = db.prepare('SELECT * FROM declarations WHERE (lower_u(shortName) = lower_u(?) OR lower_u(applicantName) = lower_u(?) OR lower_u(lastName) = lower_u(?))').all(name, name, name);
  }

  if (!records.length) return res.json({ found: false, decls: [] });

  const first = records[0];
  const key = inn || name;
  const companyInfo = db.prepare('SELECT * FROM companies WHERE id = ?').get(key);
  const contacts = db.prepare('SELECT * FROM contacts WHERE companyId = ? ORDER BY id DESC').all(key);

  const lastDeclDate = records.reduce((max, r) => (r.regDate && r.regDate > max ? r.regDate : max), '');
  const daysSinceLastDecl = lastDeclDate ? Math.floor((Date.now() - new Date(lastDeclDate).getTime()) / 86400000) : null;

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
    companyRegDate: companyInfo?.regDate || '',
    autoNote: companyInfo?.autoNote || '',
    ebPhone: companyInfo?.phone || '',
    ebEmail: companyInfo?.email || '',
    ebWebsite: companyInfo?.website || '',
    ebCeoName: companyInfo?.ceoName || '',
    ebEmployees: companyInfo?.employees || '',
    ebRevenue: companyInfo?.revenue || '',
    ebEnrichedAt: companyInfo?.ebEnrichedAt || '',
    contacts,
    lastDeclDate,
    dormant: daysSinceLastDecl != null && daysSinceLastDecl > DORMANT_AFTER_DAYS,
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
      .sort((a, b) => {
        const statusOrder = { active: 0, suspended: 1, expired: 2, archived: 3 };
        const sa = statusOrder[a.status] ?? 4;
        const sb = statusOrder[b.status] ?? 4;
        if (sa !== sb) return sa - sb;
        return b.regDate.localeCompare(a.regDate);
      }),
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

router.post('/company/contacts', auth, (req, res) => {
  const { inn, name, contactName, role, phone, comment } = req.body || {};
  const key = inn || name;
  if (!key) return res.status(400).json({ error: 'inn or name required' });
  if (!contactName && !phone) return res.status(400).json({ error: 'contactName or phone required' });

  if (!db.prepare('SELECT id FROM companies WHERE id = ?').get(key)) {
    db.prepare('INSERT INTO companies (id, inn, name) VALUES (?, ?, ?)').run(key, inn || null, name || null);
  }

  const info = db.prepare('INSERT INTO contacts (companyId, name, role, phone, comment) VALUES (?, ?, ?, ?, ?)')
    .run(key, contactName || '', role || '', phone || '', comment || '');

  res.status(201).json({ id: info.lastInsertRowid, companyId: key, name: contactName || '', role: role || '', phone: phone || '', comment: comment || '' });
});

router.delete('/company/contacts/:id', auth, (req, res) => {
  const info = db.prepare('DELETE FROM contacts WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Не найдено' });
  res.json({ ok: true });
});

router.get('/favorites', auth, (req, res) => {
  const favorites = db.prepare('SELECT * FROM favorites WHERE userId = ?').all(req.user.id);
  res.json(favorites);
});

router.post('/favorites', auth, (req, res) => {
  const { inn, name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name обязателен' });

  try {
    db.prepare('INSERT OR IGNORE INTO favorites (userId, inn, name) VALUES (?, ?, ?)').run(req.user.id, inn || '', name);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/favorites', auth, (req, res) => {
  const { inn, name } = req.body || {};
  db.prepare('DELETE FROM favorites WHERE userId = ? AND inn = ? AND name = ?').run(req.user.id, inn || '', name);
  res.json({ ok: true });
});

// POST /api/business/company/enrich-eb — обогатить компанию через export-base.ru
// Тратит 1 лимит. Доступно авторизованным пользователям с подпиской.
router.post('/company/enrich-eb', auth, requireSubscription, async (req, res) => {
  const { inn, name } = req.body || {};
  if (!inn && !name) return res.status(400).json({ error: 'inn или name обязателен' });
  if (!eb.isConfigured()) return res.status(503).json({ error: 'EXPORT_BASE_KEY не задан в .env' });

  const key = inn || name;
  try {
    // ИП (12-значный ИНН) — API не поддерживает, лимит не тратим
    if (inn && eb.isIp(inn)) {
      return res.json({ ok: true, _isIp: true, profileUrl: eb.profileUrl(inn) });
    }

    const raw = await eb.lookupByInn(inn);
    const data = eb.extractData(raw);
    if (!data) return res.json({ ok: false, message: 'Компания не найдена в export-base' });

    const existing = db.prepare('SELECT id FROM companies WHERE id = ?').get(key);
    const saveable = Object.fromEntries(Object.entries(data).filter(([k,v]) => v != null && !k.startsWith('_')));
    const fields = Object.entries(saveable);
    const setClause = fields.map(([k]) => `${k} = ?`).join(', ');
    const values = fields.map(([,v]) => v);

    if (existing) {
      db.prepare(`UPDATE companies SET ${setClause}, ebEnrichedAt = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(...values, key);
    } else {
      db.prepare(`INSERT INTO companies (id, inn, name, ${fields.map(([k])=>k).join(',')}, ebEnrichedAt) VALUES (?,?,?,${fields.map(()=>'?').join(',')},CURRENT_TIMESTAMP)`)
        .run(key, inn || null, name || null, ...values);
    }
    res.json({ ok: true, ...saveable });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/business/eb-balance — остаток лимитов export-base
router.get('/eb-balance', auth, async (req, res) => {
  const balance = await eb.getBalance();
  res.json({ balance, configured: eb.isConfigured() });
});

module.exports = router;
