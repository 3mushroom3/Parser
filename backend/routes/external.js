/**
 * Внешний read-only API для интеграций (например, Битрикс24).
 * Авторизация по заголовку X-API-Key (см. middleware/apiKeyAuth.js),
 * отдельно от пользовательских JWT-сессий SPA.
 */
const express = require('express');
const router = express.Router();
const db = require('../services/db');
const apiKeyAuth = require('../middleware/apiKeyAuth');

router.use(apiKeyAuth);

// GET /api/external/declarations — постраничный список деклараций
router.get('/declarations', (req, res) => {
  const { page = 0, size = 100, dateFrom = '', dateTo = '', updatedSince = '', inn = '', status = '' } = req.query;

  let query = 'FROM declarations WHERE 1=1';
  const params = [];
  if (dateFrom) { query += ' AND regDate >= ?'; params.push(dateFrom); }
  if (dateTo) { query += ' AND regDate <= ?'; params.push(dateTo); }
  if (updatedSince) { query += ' AND updatedAt >= ?'; params.push(updatedSince); }
  if (inn) { query += ' AND inn = ?'; params.push(inn); }
  if (status) { query += ' AND status = ?'; params.push(status); }

  const { total } = db.prepare('SELECT COUNT(*) as total ' + query).get(...params);

  const s = Math.min(500, Math.max(1, parseInt(size) || 100));
  const p = Math.max(0, parseInt(page) || 0);
  const rows = db.prepare(
    `SELECT id, declNumber, status, productGroup as "group", technicalReglament, regDate, endDate,
            inn, shortName, applicantName, lastName, firstName, middleName, address, phone,
            productName, batchSize, farmerType, okved, fsaUrl, updatedAt
     ${query} ORDER BY updatedAt DESC LIMIT ? OFFSET ?`
  ).all(...params, s, p * s);

  res.json({ items: rows, total, page: p, size: s, pages: Math.ceil(total / s) || 1 });
});

// GET /api/external/companies — производители, сгруппированные по ИНН/названию, с контактами
router.get('/companies', (req, res) => {
  const { page = 0, size = 100, inn = '', search = '' } = req.query;

  let baseQuery = 'FROM declarations WHERE 1=1';
  const params = [];
  if (inn) { baseQuery += ' AND inn = ?'; params.push(inn); }
  if (search) { baseQuery += ' AND (lower_u(shortName) LIKE ? OR lower_u(applicantName) LIKE ?)'; const m = `%${search.toLowerCase()}%`; params.push(m, m); }

  const rows = db.prepare(`
    SELECT
      COALESCE(NULLIF(inn, ''), COALESCE(NULLIF(shortName, ''), NULLIF(applicantName, ''), lastName)) as producerKey,
      MAX(shortName) as shortName,
      MAX(applicantName) as applicantName,
      MAX(lastName) as lastName,
      MAX(inn) as inn,
      MAX(address) as address,
      MAX(phone) as phone,
      MAX(farmerType) as farmerType,
      MAX(updatedAt) as updatedAt,
      COUNT(id) as declCount
    ${baseQuery}
    GROUP BY producerKey
    ORDER BY updatedAt DESC
  `).all(...params);

  const total = rows.length;
  const s = Math.min(500, Math.max(1, parseInt(size) || 100));
  const p = Math.max(0, parseInt(page) || 0);
  const pageRows = rows.slice(p * s, (p + 1) * s);

  const contactsStmt = db.prepare('SELECT name, role, phone, comment FROM contacts WHERE companyId = ? ORDER BY id DESC');
  const items = pageRows.map(r => {
    const name = (r.shortName || r.applicantName || r.lastName || '').trim();
    const companyKey = (r.inn || name || '').trim();
    return {
      inn: r.inn || '',
      name,
      address: r.address || '',
      phone: r.phone || '',
      farmerType: r.farmerType || 'unknown',
      declCount: r.declCount,
      updatedAt: r.updatedAt,
      contacts: contactsStmt.all(companyKey),
    };
  });

  res.json({ items, total, page: p, size: s, pages: Math.ceil(total / s) || 1 });
});

module.exports = router;
