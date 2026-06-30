const express = require('express');
const router = express.Router();
const db = require('../services/db');
const auth = require('../middleware/auth');
const requireSubscription = require('../middleware/subscription');
const requireAdmin = require('../middleware/requireAdmin');
const { dataReadLimiter, exportLimiter } = require('../middleware/rateLimiters');
const exportFromJSON = require('json-to-csv-export');

const DORMANT_AFTER_DAYS = 547; // 1.5 года без новых деклараций
const MAX_PAGE_SIZE = 100; // совпадает с максимумом в UI (см. #pgSize) — больше там никогда не запрашивается

function extractCity(address) {
  if (!address) return null;
  const m = address.match(/(?:^|[,;\s])([Гг])(?:\.о?\.?\s*|\s+)([А-ЯЁа-яё][А-ЯЁа-яё\-]+(?:\s+[А-ЯЁа-яё][А-ЯЁа-яё\-]+)*)/);
  if (m) return m[2].split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  return null;
}

router.get('/producers', auth, requireSubscription, dataReadLimiter, (req, res) => {
  const {
    page = 0,
    size = 50,
    search = '',
    manufacturer = '',
    address = '',
    product = '',
    dateFrom = '',
    dateTo = '',
    farmerType = ''
  } = req.query;

  let baseQuery = 'FROM declarations WHERE 1=1';
  let params = [];

  if (search) {
    baseQuery += ' AND (lower_u(applicantName) LIKE ? OR lower_u(shortName) LIKE ? OR lower_u(lastName) LIKE ? OR lower_u(productName) LIKE ? OR lower_u(address) LIKE ? OR inn LIKE ?)';
    const s = `%${search.toLowerCase()}%`;
    params.push(s, s, s, s, s, `%${search}%`);
  }
  if (manufacturer) {
    baseQuery += ' AND (lower_u(shortName) LIKE ? OR lower_u(applicantName) LIKE ? OR lower_u(lastName) LIKE ? OR inn LIKE ?)';
    const m = `%${manufacturer.toLowerCase()}%`;
    params.push(m, m, m, `%${manufacturer}%`);
  }
  if (address) { baseQuery += ' AND lower_u(address) LIKE ?'; params.push(`%${address.toLowerCase()}%`); }
  if (product) { baseQuery += ' AND lower_u(productName) LIKE ?'; params.push(`%${product.toLowerCase()}%`); }
  if (dateFrom) { baseQuery += ' AND regDate >= ?'; params.push(dateFrom); }
  if (dateTo) { baseQuery += ' AND regDate <= ?'; params.push(dateTo); }
  if (farmerType) { baseQuery += ' AND farmerType = ?'; params.push(farmerType); }

  // By default, show producers with the most recently registered declaration
  // first. When searching by manufacturer, rank exact/prefix name matches
  // above companies that merely contain the term somewhere, with recency as
  // the tiebreaker.
  let orderClause = 'ORDER BY lastRegDate DESC';
  const orderParams = [];
  if (manufacturer) {
    const mLower = manufacturer.toLowerCase();
    orderClause = `ORDER BY
      CASE
        WHEN lower_u(COALESCE(NULLIF(shortName,''), NULLIF(applicantName,''), lastName)) = ? THEN 0
        WHEN lower_u(COALESCE(NULLIF(shortName,''), NULLIF(applicantName,''), lastName)) LIKE ? THEN 1
        ELSE 2
      END,
      lastRegDate DESC`;
    orderParams.push(mLower, `${mLower}%`);
  }

  // We need to group by manufacturer (inn or names)
  // Simplified logic: group by inn if present, otherwise by name
  const dataQuery = `
    SELECT
      COALESCE(NULLIF(inn, ''), COALESCE(NULLIF(shortName, ''), NULLIF(applicantName, ''), lastName)) as producerKey,
      MAX(shortName) as shortName,
      MAX(applicantName) as applicantName,
      MAX(lastName) as lastName,
      MAX(inn) as inn,
      MAX(address) as address,
      MAX(phone) as phone,
      MAX(farmerType) as farmerType,
      MAX(okved) as okved,
      MAX(regDate) as lastRegDate,
      GROUP_CONCAT(id) as declIds
    ${baseQuery}
    GROUP BY producerKey
    ${orderClause}
  `;

  // Группируем по всей таблице (нужно для total/сортировки), но декларации
  // каждой группы подгружаем ТОЛЬКО для текущей страницы — раньше это
  // делалось для всех ~40k групп на каждый запрос (N+1), что было и узким
  // местом производительности, и готовым DoS-вектором вне зависимости от
  // лимита size.
  const allProducers = db.prepare(dataQuery).all(...params, ...orderParams);

  const total = allProducers.length;
  const p = parseInt(page) || 0;
  const s = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(size) || 50));
  const pageRows = allProducers.slice(p * s, (p + 1) * s);

  const items = pageRows.map(row => {
    const ids = row.declIds.split(',');
    const decls = db.prepare(`SELECT id, regDate, endDate, productName, batchSize, productGroup as "group", declNumber, fsaUrl, status FROM declarations WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY regDate DESC`).all(...ids);

    const daysSinceLastDecl = row.lastRegDate ? Math.floor((Date.now() - new Date(row.lastRegDate).getTime()) / 86400000) : null;

    return {
      inn: row.inn || '',
      name: (row.shortName || row.applicantName || row.lastName || '—').trim(),
      address: row.address || '',
      phone: row.phone || '',
      farmerType: row.farmerType || 'unknown',
      okved: row.okved || '',
      lastDeclDate: row.lastRegDate || '',
      dormant: daysSinceLastDecl != null && daysSinceLastDecl > DORMANT_AFTER_DAYS,
      decls
    };
  });

  res.json({ items, total, page: p, size: s, pages: Math.ceil(total / s) });
});

router.get('/map-data', auth, requireSubscription, dataReadLimiter, (req, res) => {
  try {
    const stmt = db.prepare("SELECT id, address, shortName, applicantName, lastName, inn, farmerType, productName FROM declarations WHERE address IS NOT NULL AND address != ''");

    const cityMap = {};
    for (const rec of stmt.iterate()) {
      const city = extractCity(rec.address);
      if (!city) continue;

      if (!cityMap[city]) cityMap[city] = { city, count: 0, farmers: 0, traders: 0, orgs: {} };
      cityMap[city].count++;

      if (rec.farmerType === 'farmer') cityMap[city].farmers++;
      else if (rec.farmerType === 'trader') cityMap[city].traders++;

      const key = (rec.shortName || rec.applicantName || rec.lastName || '—').trim();
      if (!cityMap[city].orgs[key]) {
        cityMap[city].orgs[key] = { name: key, inn: rec.inn || '', farmerType: rec.farmerType || 'unknown', decls: [] };
      }
      if (cityMap[city].orgs[key].decls.length < 20) {
        cityMap[city].orgs[key].decls.push({ id: rec.id, product: (rec.productName || '').slice(0, 60) });
      }
    }

    const cities = Object.values(cityMap)
      .map(c => ({
        city: c.city,
        count: c.count,
        farmers: c.farmers,
        traders: c.traders,
        orgs: Object.values(c.orgs)
          .sort((a, b) => b.decls.length - a.decls.length)
          .slice(0, 30)
          .map(o => ({
            name: o.name,
            inn: o.inn,
            farmerType: o.farmerType,
            count: o.decls.length,
            decls: o.decls
          })),
      }))
      .sort((a, b) => b.count - a.count);

    res.json({ cities, total: cities.reduce((s, c) => s + c.count, 0) });
  } catch (err) {
    console.error('[map-data]', err.message);
    res.status(500).json({ error: 'Ошибка формирования данных карты: ' + err.message });
  }
});

router.get('/', auth, requireSubscription, dataReadLimiter, (req, res) => {
  const {
    page = 0,
    size = 20,
    search = '',
    source = '',
    status = '',
    group = '',
    manufacturer = '',
    techReglament = '',
    dateFrom = '',
    dateTo = '',
    applicant = '',
    address = '',
    product = '',
    sortField = 'regDate',
    sortDir = 'desc',
    farmerType = ''
  } = req.query;

  let query = 'SELECT * FROM declarations WHERE 1=1';
  let params = [];

  if (search) {
    query += ' AND (lower_u(applicantName) LIKE ? OR lower_u(shortName) LIKE ? OR lower_u(lastName) LIKE ? OR lower_u(productName) LIKE ? OR lower_u(productGroup) LIKE ? OR id LIKE ? OR inn LIKE ?)';
    const s = `%${search.toLowerCase()}%`;
    params.push(s, s, s, s, s, `%${search}%`, `%${search}%`);
  }
  if (source) { query += ' AND source = ?'; params.push(source); }
  if (status) { query += ' AND status = ?'; params.push(status); }
  if (group) { query += ' AND lower_u(productGroup) LIKE ?'; params.push(`%${group.toLowerCase()}%`); }
  if (manufacturer) {
    query += ' AND (lower_u(shortName) LIKE ? OR lower_u(applicantName) LIKE ? OR lower_u(lastName) LIKE ? OR inn LIKE ?)';
    const m = `%${manufacturer.toLowerCase()}%`;
    params.push(m, m, m, `%${manufacturer}%`);
  }
  if (techReglament) { query += ' AND lower_u(technicalReglament) LIKE ?'; params.push(`%${techReglament.toLowerCase()}%`); }
  if (dateFrom) { query += ' AND regDate >= ?'; params.push(dateFrom); }
  if (dateTo) { query += ' AND regDate <= ?'; params.push(dateTo); }
  if (applicant) { query += ' AND lower_u(applicantName) LIKE ?'; params.push(`%${applicant.toLowerCase()}%`); }
  if (address) { query += ' AND lower_u(address) LIKE ?'; params.push(`%${address.toLowerCase()}%`); }
  if (product) { query += ' AND lower_u(productName) LIKE ?'; params.push(`%${product.toLowerCase()}%`); }
  if (farmerType) { query += ' AND farmerType = ?'; params.push(farmerType); }

  const countQuery = 'SELECT COUNT(*) as total FROM (' + query + ')';
  const { total } = db.prepare(countQuery).get(...params);

  const allowedSortFields = ['regDate', 'applicantName', 'shortName', 'productName', 'status'];
  const finalSortField = allowedSortFields.includes(sortField) ? sortField : 'regDate';
  const finalSortDir = sortDir.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  query += ` ORDER BY ${finalSortField === 'group' ? 'productGroup' : finalSortField} ${finalSortDir}`;

  const safeSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(size) || 20));
  const safePage = Math.max(0, parseInt(page) || 0);
  query += ' LIMIT ? OFFSET ?';
  params.push(safeSize, safePage * safeSize);

  const items = db.prepare(query).all(...params);

  res.json({
    items: items.map(item => ({
      ...item,
      group: item.productGroup,
      productionSites: item.productionSites ? JSON.parse(item.productionSites) : []
    })),
    total,
    page: safePage,
    size: safeSize,
    pages: Math.ceil(total / safeSize) || 1
  });
});

router.get('/:id', auth, requireSubscription, dataReadLimiter, (req, res) => {
  const item = db.prepare('SELECT * FROM declarations WHERE id = ? OR fsaId = ?').get(req.params.id, req.params.id);
  if (!item) return res.status(404).json({ error: 'Не найдено' });

  res.json({
    ...item,
    group: item.productGroup,
    productionSites: item.productionSites ? JSON.parse(item.productionSites) : []
  });
});

router.post('/', auth, requireAdmin, (req, res) => {
  const rec = {
    id: 'manual_' + Date.now(),
    source: 'manual',
    status: 'active',
    fetchedAt: new Date().toISOString(),
    ...req.body
  };

  const columns = ['id', 'source', 'status', 'fetchedAt', 'declNumber', 'applicantName', 'productGroup', 'technicalReglament', 'regDate', 'endDate', 'lastName', 'firstName', 'middleName', 'shortName', 'address', 'phone', 'productName', 'batchSize', 'otherInfo', 'fsaUrl', 'productionSites'];

  const placeholders = columns.map(() => '?').join(', ');
  const values = columns.map(col => {
    if (col === 'productGroup') return rec.group || '';
    if (col === 'productionSites') return JSON.stringify(rec.productionSites || []);
    return rec[col] || '';
  });

  db.prepare(`INSERT INTO declarations (${columns.join(', ')}) VALUES (${placeholders})`).run(...values);
  res.status(201).json(rec);
});

router.put('/:id', auth, requireAdmin, (req, res) => {
  const item = db.prepare('SELECT * FROM declarations WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Не найдено' });

  const updates = req.body;
  const columnsToUpdate = [];
  const values = [];

  const allowed = ['declNumber', 'applicantName', 'status', 'regDate', 'endDate', 'lastName', 'firstName', 'middleName', 'shortName', 'address', 'phone', 'productName', 'batchSize', 'otherInfo', 'fsaUrl', 'productionSites'];

  allowed.forEach(col => {
    if (updates[col] !== undefined) {
      columnsToUpdate.push(`${col} = ?`);
      values.push(col === 'productionSites' ? JSON.stringify(updates[col]) : updates[col]);
    }
  });

  if (updates.group !== undefined) {
    columnsToUpdate.push('productGroup = ?');
    values.push(updates.group);
  }

  if (columnsToUpdate.length === 0) return res.json(item);

  values.push(req.params.id);
  db.prepare(`UPDATE declarations SET ${columnsToUpdate.join(', ')}, updatedAt = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);

  const updatedItem = db.prepare('SELECT * FROM declarations WHERE id = ?').get(req.params.id);
  res.json({
    ...updatedItem,
    group: updatedItem.productGroup,
    productionSites: updatedItem.productionSites ? JSON.parse(updatedItem.productionSites) : []
  });
});

router.delete('/:id', auth, requireAdmin, (req, res) => {
  const info = db.prepare('DELETE FROM declarations WHERE id = ? OR fsaId = ?').run(req.params.id, req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Не найдено' });
  res.json({ ok: true });
});

router.get('/export/csv', auth, requireSubscription, exportLimiter, (req, res) => {
  const records = db.prepare('SELECT * FROM declarations ORDER BY regDate DESC').all();
  const data = records.map(r => ({
    ID: r.id,
    'Номер декларации': r.declNumber || '',
    Заявитель: r.applicantName || '',
    Источник: r.source,
    Статус: r.status || 'active',
    'Группа продукции': r.productGroup || '',
    'Тех.регламент': r.technicalReglament || '',
    'Дата регистрации': r.regDate,
    'Дата окончания': r.endDate,
    Фамилия: r.lastName,
    Имя: r.firstName,
    'Краткое наим.': r.shortName,
    Адрес: r.address,
    Телефон: r.phone,
    'Наименование продукции': r.productName,
    Партия: r.batchSize,
    'Ссылка FSA': r.fsaUrl || ''
  }));

  const csv = exportFromJSON({ data, fileName: 'export', exportType: 'csv', returnType: 'txt' });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="fsa_export_${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('\uFEFF' + csv);
});

module.exports = router;
