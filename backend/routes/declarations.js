const express = require('express');
const router = express.Router();
const path = require('path');
const { Worker } = require('worker_threads');
const db = require('../services/db');
const auth = require('../middleware/auth');
const requireSubscription = require('../middleware/subscription');
const requireAdmin = require('../middleware/requireAdmin');
const { dataReadLimiter, exportLimiter } = require('../middleware/rateLimiters');
const { parseBatchTons } = require('../services/batchSize');

const DORMANT_AFTER_DAYS = 547; // 1.5 года без новых деклараций
const MAX_PAGE_SIZE = 100; // совпадает с максимумом в UI (см. #pgSize) — больше там никогда не запрашивается

// Группировка по producerKey требует прохода по всей (отфильтрованной) части
// таблицы — на 4.9M строк db.prepare(...).all() занимает от десятков секунд
// до нескольких минут. GROUP BY в SQLite не может отдавать строки потоково
// (все группы материализуются до того, как вернётся первая), поэтому
// .iterate()/setImmediate тут не спасает — весь расчёт всё равно блокирует
// единственный поток Node целиком на всё это время, давая 504 всем
// остальным пользователям одновременно (подтверждено на проде: 60+ секунд
// полного простоя сайта на один запрос реестра). Поэтому сам запрос
// выполняется в отдельном worker-потоке (см. workers/producersQueryWorker.js)
// — сколько бы он ни считал, event loop основного процесса свободен для
// всех остальных запросов. Результат ещё и кэшируется по сигнатуре
// фильтров/сортировки (без page/size — постранично режем уже готовый
// массив), чтобы повторные заходы не гоняли воркер заново.
const PRODUCERS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 минут — живой парсер обновляет данные раз в ~30 мин
const PRODUCERS_WORKER_PATH = path.join(__dirname, '../workers/producersQueryWorker.js');
const producersCache = new Map(); // key -> { rows, computedAt }
const producersComputing = new Map(); // key -> Promise<rows>, чтобы не считать параллельно на конкурентные запросы

function computeAllProducers(dataQuery, params, orderParams) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(PRODUCERS_WORKER_PATH, { workerData: { dataQuery, params, orderParams } });
    worker.once('message', (msg) => {
      worker.terminate();
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg.rows);
    });
    worker.once('error', (err) => {
      worker.terminate();
      reject(err);
    });
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
    farmerType = '',
    batchMin = '',
    batchMax = ''
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
  if (batchMin) { baseQuery += ' AND batchTons >= ?'; params.push(Number(batchMin)); }
  if (batchMax) { baseQuery += ' AND batchTons <= ?'; params.push(Number(batchMax)); }
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
// Вычисление данных карты вынесено в Worker-поток (как computeStats), чтобы
// OOM в ходе полного прохода по активным декларациям не убивал основной процесс.
const MAP_DATA_CACHE_TTL_MS = 20 * 60 * 1000; // 20 минут
const MAP_DATA_WORKER_PATH = path.join(__dirname, '../workers/mapDataWorker.js');
let mapDataCache = null; // { json, computedAt }
let mapDataComputing = null; // Promise — не считаем параллельно на конкурентных запросах

function computeMapData() {
  return new Promise((resolve, reject) => {
    const worker = new Worker(MAP_DATA_WORKER_PATH);
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('map-data worker timeout (> 5 min)'));
    }, 5 * 60 * 1000);
    worker.once('message', (msg) => {
      clearTimeout(timer);
      worker.terminate();
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg);
    });
    worker.once('error', (err) => {
      clearTimeout(timer);
      worker.terminate();
      reject(err);
    });
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

// GET /api/declarations/map-place?key=… — компании одного населённого пункта.
// Раньше список компаний ехал в общем ответе map-data по всем городам; с полным
// реестром (17 тыс. НП вместо 145 городов) это были бы десятки мегабайт, поэтому
// popup маркера запрашивает свой НП отдельно — это индексный запрос по placeKey.
const MAP_PLACE_ORGS = 30;
const MAP_PLACE_DECLS = 20;

router.get('/map-place', auth, requireSubscription, dataReadLimiter, (req, res) => {
  const id = Number(req.query.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Не указан населённый пункт' });

  const place = db.prepare('SELECT id, key, label, region, district FROM geo_places WHERE id = ?').get(id);
  if (!place) return res.status(404).json({ error: 'Населённый пункт не найден' });
  const key = place.key;

  const total = db.prepare("SELECT COUNT(*) c FROM declarations WHERE placeKey = ? AND status = 'active'").get(key).c;
  // для popup хватит первых записей: показываем не больше 30 компаний
  const rows = db.prepare(`
    SELECT id, shortName, applicantName, lastName, inn, farmerType, productName
    FROM declarations
    WHERE placeKey = ? AND status = 'active'
    ORDER BY COALESCE(shortName, applicantName, lastName), regDate DESC
    LIMIT 2000
  `).all(key);

  const orgs = new Map();
  for (const row of rows) {
    const name = (row.shortName || row.applicantName || row.lastName || '—').trim();
    if (!orgs.has(name)) {
      if (orgs.size >= MAP_PLACE_ORGS) continue;
      orgs.set(name, { name, inn: row.inn || '', farmerType: row.farmerType || 'unknown', decls: [] });
    }
    const org = orgs.get(name);
    if (org.decls.length < MAP_PLACE_DECLS) {
      org.decls.push({ id: row.id, product: (row.productName || '').slice(0, 60) });
    }
  }

  res.json({
    id: place.id,
    label: place.label,
    region: place.region,
    district: place.district,
    count: total,
    orgs: [...orgs.values()].sort((a, b) => b.decls.length - a.decls.length),
  });
});

// GET /api/declarations/recent — витрина на главной + слой «свежее» на карте.
// Один и тот же список используют оба потребителя: дашборду координаты не
// нужны, карте не нужен текст, но обоим дешевле переиспользовать один запрос,
// чем считать дважды. lat/lon берутся из geo_places (тот же справочник НП,
// что заполняет geoParseWorker для основной карты) — если НП ещё не
// геокодирован, координаты просто отсутствуют и слой карты эту декларацию
// не покажет (текстовая витрина по-прежнему покажет).
const RECENT_LIMIT_MAX = 100;
router.get('/recent', auth, requireSubscription, dataReadLimiter, (req, res) => {
  const limit = Math.min(RECENT_LIMIT_MAX, Math.max(1, Number(req.query.limit) || 30));
  // fetchedAt, не regDate: regDate — календарная дата без времени (когда
  // партию зарегистrировали в ФСА), а лента про то, когда МЫ её увидели —
  // иначе бэкафилл открытых данных выглядел бы как «партия N дней назад».
  const rows = db.prepare(`
    SELECT d.id, d.productName, d.batchSize, d.regDate, d.fetchedAt,
           g.region AS region, g.district AS district, g.label AS place,
           g.lat AS lat, g.lon AS lon
    FROM declarations d
    LEFT JOIN geo_places g ON g.key = d.placeKey
    WHERE d.status = 'active' AND d.productName IS NOT NULL AND d.productName != ''
    ORDER BY d.fetchedAt DESC
    LIMIT ?
  `).all(limit);
  res.json({ items: rows });
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

  const columns = ['id', 'source', 'status', 'fetchedAt', 'declNumber', 'applicantName', 'productGroup', 'technicalReglament', 'regDate', 'endDate', 'lastName', 'firstName', 'middleName', 'shortName', 'address', 'phone', 'productName', 'batchSize', 'batchTons', 'otherInfo', 'fsaUrl', 'productionSites'];

  const placeholders = columns.map(() => '?').join(', ');
  const values = columns.map(col => {
    if (col === 'productGroup') return rec.group || '';
    if (col === 'productionSites') return JSON.stringify(rec.productionSites || []);
    if (col === 'batchTons') return parseBatchTons(rec.batchSize);
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

  if (updates.batchSize !== undefined) {
    columnsToUpdate.push('batchTons = ?');
    values.push(parseBatchTons(updates.batchSize));
  }

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

  // \u0415\u0441\u043B\u0438 \u043A\u043B\u0438\u0435\u043D\u0442 \u043E\u0442\u0432\u0430\u043B\u0438\u043B\u0441\u044F (\u0437\u0430\u043A\u0440\u044B\u043B \u0432\u043A\u043B\u0430\u0434\u043A\u0443, nginx \u043E\u0431\u043E\u0440\u0432\u0430\u043B \u043F\u043E \u0442\u0430\u0439\u043C\u0430\u0443\u0442\u0443, \u0431\u043E\u0442
  // \u0431\u0440\u043E\u0441\u0438\u043B \u0441\u043A\u0430\u0447\u0438\u0432\u0430\u043D\u0438\u0435) \u2014 .iterate()/setImmediate \u0431\u0435\u0437 \u044D\u0442\u043E\u0439 \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438 \u043F\u0440\u043E\u0434\u043E\u043B\u0436\u0430\u043B
  // \u0431\u044B \u043C\u043E\u043B\u043E\u0442\u0438\u0442\u044C \u0432\u0441\u0435 4.9M \u0441\u0442\u0440\u043E\u043A \u0432\u043D\u0438\u043A\u0443\u0434\u0430 \u0434\u043E \u043A\u043E\u043D\u0446\u0430: res.write() \u043D\u0430 \u043C\u0451\u0440\u0442\u0432\u044B\u0439
  // \u0441\u043E\u043A\u0435\u0442 \u043D\u0435 \u0431\u0440\u043E\u0441\u0430\u0435\u0442 \u0438\u0441\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u0435 \u0438 \u043D\u0435 \u0442\u043E\u0440\u043C\u043E\u0437\u0438\u0442 \u0446\u0438\u043A\u043B \u0441\u0430\u043C \u043F\u043E \u0441\u0435\u0431\u0435. \u041A\u0430\u0436\u0434\u0430\u044F
  // \u0431\u0440\u043E\u0448\u0435\u043D\u043D\u0430\u044F \u043F\u043E\u043F\u044B\u0442\u043A\u0430 \u043F\u0440\u0435\u0432\u0440\u0430\u0449\u0430\u043B\u0430\u0441\u044C \u0432 \u043E\u0442\u0434\u0435\u043B\u044C\u043D\u044B\u0439 \u0431\u0435\u0441\u043A\u043E\u043D\u0435\u0447\u043D\u044B\u0439 \u0444\u043E\u043D\u043E\u0432\u044B\u0439 \u0441\u043A\u0430\u043D,
  // \u0438 \u043D\u0435\u0441\u043A\u043E\u043B\u044C\u043A\u043E \u0442\u0430\u043A\u0438\u0445 \u0441\u043Aan'\u043E\u0432, \u043D\u0430\u043A\u043E\u043F\u0438\u0432\u0448\u0438\u0441\u044C, \u043A\u043E\u043D\u043A\u0443\u0440\u0438\u0440\u043E\u0432\u0430\u043B\u0438 \u0437\u0430 event loop
  // \u0434\u0440\u0443\u0433 \u0441 \u0434\u0440\u0443\u0433\u043E\u043C \u0438 \u0441\u043E \u0432\u0441\u0435\u043C\u0438 \u043E\u0441\u0442\u0430\u043B\u044C\u043D\u044B\u043C\u0438 \u0437\u0430\u043F\u0440\u043E\u0441\u0430\u043C\u0438.
  let aborted = false;
  res.on('close', () => { aborted = true; });

  const writeChunk = () => {
    if (aborted) {
      iterator.return();
      return;
    }

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
