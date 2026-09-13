const express = require('express');
const router = express.Router();
const db = require('../services/db');
const auth = require('../middleware/auth');
const requireSubscription = require('../middleware/subscription');
const requireAdmin = require('../middleware/requireAdmin');
const { dataReadLimiter, exportLimiter } = require('../middleware/rateLimiters');

const DORMANT_AFTER_DAYS = 547; // 1.5 года без новых деклараций
const MAX_PAGE_SIZE = 100; // совпадает с максимумом в UI (см. #pgSize) — больше там никогда не запрашивается

function extractCity(address) {
  if (!address) return null;
  const m = address.match(/(?:^|[,;\s])([Гг])(?:\.о?\.?\s*|\s+)([А-ЯЁа-яё][А-ЯЁа-яё\-]+(?:\s+[А-ЯЁа-яё][А-ЯЁа-яё\-]+)*)/);
  if (m) return m[2].split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  return null;
}

// Группировка по producerKey требует прохода по всей (отфильтрованной) части
// таблицы — на 4.9M строк один синхронный db.prepare(...).all() занимает
// 60+ секунд и блокирует event loop (better-sqlite3 синхронный), давая 504
// всем остальным пользователям одновременно. Кэшируем результат по сигнатуре
// фильтров/сортировки (без page/size — постранично режем уже готовый массив)
// и, как в /map-data, читаем через .iterate() чанками через setImmediate,
// чтобы промах кэша не вешал сервер целиком на время подсчёта.
const PRODUCERS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 минут — живой парсер обновляет данные раз в ~30 мин
const PRODUCERS_SCAN_CHUNK_SIZE = 5000;
const producersCache = new Map(); // key -> { rows, computedAt }
const producersComputing = new Map(); // key -> Promise<rows>, чтобы не считать параллельно на конкурентные запросы

function computeAllProducers(dataQuery, params, orderParams) {
  return new Promise((resolve, reject) => {
    const iterator = db.prepare(dataQuery).iterate(...params, ...orderParams);
    const rows = [];

    const scanChunk = () => {
      try {
        let n = 0;
        let step;
        while (n < PRODUCERS_SCAN_CHUNK_SIZE && !(step = iterator.next()).done) {
          n++;
          rows.push(step.value);
        }
        if (step && step.done) {
          resolve(rows);
        } else {
          setImmediate(scanChunk);
        }
      } catch (err) {
        reject(err);
      }
    };

    scanChunk();
  });
}

router.get('/producers', auth, requireSubscription, dataReadLimiter, async (req, res, next) => {
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
  if (farmerType) {
    // Производители = farmer + farmer_trader; Трейдеры = trader + trader_farmer
    if (farmerType === 'farmer') {
      baseQuery += " AND farmerType IN ('farmer','farmer_trader')";
    } else if (farmerType === 'trader') {
      baseQuery += " AND farmerType IN ('trader','trader_farmer')";
    } else {
      baseQuery += ' AND farmerType = ?'; params.push(farmerType);
    }
  }

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
  try {
    const cacheKey = JSON.stringify({ dataQuery, params, orderParams });
    let allProducers;
    const cached = producersCache.get(cacheKey);
    if (cached && Date.now() - cached.computedAt < PRODUCERS_CACHE_TTL_MS) {
      allProducers = cached.rows;
    } else {
      let inFlight = producersComputing.get(cacheKey);
      if (!inFlight) {
        inFlight = computeAllProducers(dataQuery, params, orderParams)
          .then(rows => { producersCache.set(cacheKey, { rows, computedAt: Date.now() }); return rows; })
          .finally(() => producersComputing.delete(cacheKey));
        producersComputing.set(cacheKey, inFlight);
      }
      allProducers = await inFlight;
    }

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
  } catch (err) {
    next(err);
  }
});

// Реестр вырос до миллионов записей (opendata-бэкафилл) — полный синхронный
// проход по всем декларациям на каждый запрос блокирует весь event loop
// (better-sqlite3 синхронный) и вешает сервер на минуты. Поэтому: считаем
// только активные декларации, результат кэшируем, а сам проход бьём на чанки
// через setImmediate, чтобы event loop успевал обслуживать другие запросы.
const MAP_DATA_CACHE_TTL_MS = 20 * 60 * 1000; // 20 минут
const MAP_DATA_CHUNK_SIZE = 5000;
let mapDataCache = null; // { json, computedAt }
let mapDataComputing = null; // Promise, чтобы не считать параллельно на конкурентные запросы

function computeMapData() {
  return new Promise((resolve, reject) => {
    try {
      const stmt = db.prepare(
        "SELECT id, address, shortName, applicantName, lastName, inn, farmerType, productName " +
        "FROM declarations WHERE status = 'active' AND address IS NOT NULL AND address != ''"
      );

      const cityMap = {};
      const iterator = stmt.iterate();

      const processChunk = () => {
        try {
          let n = 0;
          let step;
          while (n < MAP_DATA_CHUNK_SIZE && !(step = iterator.next()).done) {
            const rec = step.value;
            const city = extractCity(rec.address);
            n++;
            if (!city) continue;

            if (!cityMap[city]) cityMap[city] = { city, count: 0, farmers: 0, traders: 0, orgs: {} };
            cityMap[city].count++;

            if (rec.farmerType === 'farmer' || rec.farmerType === 'farmer_trader') cityMap[city].farmers++;
            else if (rec.farmerType === 'trader' || rec.farmerType === 'trader_farmer') cityMap[city].traders++;

            const key = (rec.shortName || rec.applicantName || rec.lastName || '—').trim();
            if (!cityMap[city].orgs[key]) {
              cityMap[city].orgs[key] = { name: key, inn: rec.inn || '', farmerType: rec.farmerType || 'unknown', decls: [] };
            }
            if (cityMap[city].orgs[key].decls.length < 20) {
              cityMap[city].orgs[key].decls.push({ id: rec.id, product: (rec.productName || '').slice(0, 60) });
            }
          }

          if (step && step.done) {
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

            resolve({ cities, total: cities.reduce((s, c) => s + c.count, 0) });
          } else {
            setImmediate(processChunk);
          }
        } catch (err) {
          reject(err);
        }
      };

      processChunk();
    } catch (err) {
      reject(err);
    }
  });
}

router.get('/map-data', auth, requireSubscription, dataReadLimiter, async (req, res) => {
  try {
    if (mapDataCache && Date.now() - mapDataCache.computedAt < MAP_DATA_CACHE_TTL_MS) {
      return res.json(mapDataCache.json);
    }

    if (!mapDataComputing) {
      mapDataComputing = computeMapData()
        .then(json => {
          mapDataCache = { json, computedAt: Date.now() };
          return json;
        })
        .finally(() => { mapDataComputing = null; });
    }

    const json = await mapDataComputing;
    res.json(json);
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
  if (farmerType) {
    if (farmerType === 'farmer') {
      query += " AND farmerType IN ('farmer','farmer_trader')";
    } else if (farmerType === 'trader') {
      query += " AND farmerType IN ('trader','trader_farmer')";
    } else {
      query += ' AND farmerType = ?'; params.push(farmerType);
    }
  }

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

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const EXPORT_CSV_CHUNK_SIZE = 2000;
const EXPORT_CSV_HEADERS = [
  'ID', 'Номер декларации', 'Заявитель', 'Источник', 'Статус', 'Группа продукции',
  'Тех.регламент', 'Дата регистрации', 'Дата окончания', 'Фамилия', 'Имя',
  'Краткое наим.', 'Адрес', 'Телефон', 'Наименование продукции', 'Партия', 'Ссылка FSA'
];

// SELECT * .all() без LIMIT на 4.9M строк (+ сборка CSV-строки в память для
// всех них разом) — самый тяжёлый вариант той же проблемы, что и в
// /producers и dedupe.js: синхронный вызов на минуты, блокирующий event
// loop целиком, вдобавок с риском OOM на самой строке CSV. Тут не только
// чанкуем через .iterate()/setImmediate, но и стримим строки прямо в ответ
// по мере готовности, вместо накопления всего файла в памяти.
router.get('/export/csv', auth, requireSubscription, exportLimiter, (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="fsa_export_${new Date().toISOString().slice(0, 10)}.csv"`);
  res.write('\uFEFF' + EXPORT_CSV_HEADERS.map(csvEscape).join(',') + '\r\n');

  const iterator = db.prepare('SELECT * FROM declarations ORDER BY regDate DESC').iterate();

  const writeChunk = () => {
    let n = 0;
    let step;
    while (n < EXPORT_CSV_CHUNK_SIZE && !(step = iterator.next()).done) {
      n++;
      const r = step.value;
      const line = [
        r.id, r.declNumber || '', r.applicantName || '', r.source, r.status || 'active',
        r.productGroup || '', r.technicalReglament || '', r.regDate, r.endDate,
        r.lastName, r.firstName, r.shortName, r.address, r.phone,
        r.productName, r.batchSize, r.fsaUrl || ''
      ].map(csvEscape).join(',');
      res.write(line + '\r\n');
    }
    if (step && step.done) {
      res.end();
    } else {
      setImmediate(writeChunk);
    }
  };

  writeChunk();
});

module.exports = router;
