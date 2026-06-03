/**
 * FSA Declarations Parser — HTTP-слой и оркестрация.
 * Бизнес-логика и API: services/, config/fsaConfig.js
 */

// Фикс кодировки кириллицы в Windows-терминале
if (process.platform === 'win32') {
  try { require('child_process').execSync('chcp 65001', { stdio: 'pipe' }); } catch (_) {}
}

const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const fsaConfig = require('./config/fsaConfig');
const { createFsaApiClient } = require('./services/apiClient');
const { createDeclarationService } = require('./services/declarationService');
const parser = require('./services/parser');
const { isJwtString } = require('./services/authUtils');
const { enrichRecords, enrichExisting, applyCache } = require('./services/innEnricher');
const telegramBot = require('./services/telegramBot');

const app = express();
const PORT = process.env.PORT || 3001;

const CONFIG = {
  // Размер страницы API (на сайте до 100; больше — быстрее полный обход)
  PAGE_SIZE: Math.min(100, Math.max(1, Number(process.env.FSA_PAGE_SIZE) || 100)),
  // Макс. страниц за один запуск парсера. 0 = без лимита (качать все, пока API отдаёт данные).
  // FSA_PAGES_PER_RUN — устаревший алиас: если задан и >0, ограничивает число страниц.
  MAX_PAGES_PER_RUN: (() => {
    const a = Number(process.env.FSA_MAX_PAGES_PER_RUN);
    if (Number.isFinite(a) && a > 0) return a;
    const legacy = Number(process.env.FSA_PAGES_PER_RUN);
    if (Number.isFinite(legacy) && legacy > 0) return legacy;
    return 0;
  })(),
  CRON_SCHEDULE: process.env.FSA_CRON_SCHEDULE || '*/30 * * * *',
  DELAY_MS: Number(process.env.FSA_DELAY_MS) || 1500,
  DATA_FILE: fsaConfig.dataFile,
  STATUS_FILE: fsaConfig.statusFile,
  // 0 = не обрезать локальную БД по числу записей
  MAX_RECORDS: Number(process.env.FSA_MAX_RECORDS) || 0,
  MANUAL_TOKEN: process.env.FSA_MANUAL_TOKEN || '',
  /**
   * Локальный фильтр по тех.регламенту (применяется до загрузки карточки декларации).
   * Значение — подстрока полного названия в API (не код!).
   * FSA API хранит "О безопасности зерна", а не "ТР ТС 015/2011".
   * Пример: FSA_TECH_REGLAMENT=О безопасности зерна
   */
  TECH_REGLAMENT: (process.env.FSA_TECH_REGLAMENT || '').trim().toLowerCase(),
  /**
   * Числовые ID технических регламентов для filter.idTechReg (через запятую).
   * Найти ID: node scripts/probe-api.js --tech-regs
   * Пример: FSA_TECH_REG_IDS=15 (ТР ТС 015/2011 «О безопасности зерна»)
   */
  TECH_REG_IDS: (() => {
    const raw = process.env.FSA_TECH_REG_IDS || '32';
    if (!raw) return [];
    return raw.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0);
  })(),
  /**
   * Дополнительные поля в filter{} FSA API (JSON). Перезаписывают соответствующие поля.
   * Пример: FSA_FILTERS={"status":[1]}
   */
  FILTERS: (() => {
    try { return process.env.FSA_FILTERS ? JSON.parse(process.env.FSA_FILTERS) : {}; }
    catch { console.warn('[CONFIG] FSA_FILTERS: неверный JSON, использую {}'); return {}; }
  })(),
  /**
   * Диапазон дат регистрации (YYYY-MM-DD) → filter.regDate.minDate/maxDate.
   * FSA API жёстко ограничивает пагинацию страницей 20 (~2100 записей).
   * Чтобы скачать всё — используйте FSA_DATE_CHUNK=week вместе с DATE_FROM.
   */
  DATE_FROM: process.env.FSA_DATE_FROM || '',
  DATE_TO: process.env.FSA_DATE_TO || '',
  /**
   * Нарезка диапазона на окна для полного скачивания (обход лимита API).
   * Значения: week (7 дней), biweek (14), month (30), day (1) или число дней.
   * Требует FSA_DATE_FROM. Если DATE_TO не задан — качает до сегодня.
   * Пример: FSA_DATE_CHUNK=week FSA_DATE_FROM=2024-01-01 FSA_DATE_TO=2024-12-31
   */
  DATE_CHUNK: (() => {
    const v = (process.env.FSA_DATE_CHUNK || '').toLowerCase().trim();
    if (v === 'week') return 7;
    if (v === 'biweek') return 14;
    if (v === 'month') return 30;
    if (v === 'day') return 1;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  })(),
};

const DECLARATIONS_LIST_COLUMNS = [
  'declarationId',
  'docStatus',
  'idStatus',
  'objKindVersion',
  'number',
  'declDate',
  'endDate',
  'applicantName',
  'manufacterName',
  'prodName',
  'productFullName',
  'productIdentificationName',
  'productBatchSize',
  'group',
  'technicalReglaments',
  'batchSize',
  'applicantAddress',
];

function declarationsListPayload(pageIndex, dateFrom, dateTo) {
  const filter = {
    status: [],
    idDeclType: [],
    idCertObjectType: [],
    idProductType: [],
    idGroupRU: [],
    idGroupEEU: [],
    idTechReg: CONFIG.TECH_REG_IDS,
    idDeclScheme: [],
    idApplicantType: [],
    idProductEEU: [],
    idProductOrigin: [],
    idProductRU: [],
    status: [1],
    regDate: { minDate: dateFrom || null, maxDate: dateTo || null },
    endDate: { minDate: null, maxDate: null },
    columnsSearch: [],
    awaitForApprove: null,
    awaitOperatorCheck: null,
    checkerAIProtocolsMistakes: null,
    checkerAIProtocolsResults: null,
    checkerAIResult: null,
    editApp: null,
    hiddenFromOpen: null,
    isProtocolInvalid: null,
    violationSendDate: null,
    ...CONFIG.FILTERS,
  };
  return {
    page: pageIndex,
    size: CONFIG.PAGE_SIZE,
    count: 0,
    columnsSort: [{ column: 'declDate', sort: 'DESC' }],
    filter,
  };
}

/** Генерация временны́х окон между from и to с шагом chunkDays */
function generateDateWindows(fromStr, toStr, chunkDays) {
  const windows = [];
  const from = new Date(fromStr);
  const to = toStr ? new Date(toStr) : new Date();
  // Нормализуем to до конца дня
  to.setHours(23, 59, 59, 999);
  let cur = new Date(from);
  while (cur <= to) {
    const end = new Date(cur);
    end.setDate(end.getDate() + chunkDays - 1);
    if (end > to) end.setTime(to.getTime());
    windows.push({
      from: cur.toISOString().slice(0, 10),
      to: end.toISOString().slice(0, 10),
    });
    cur.setDate(cur.getDate() + chunkDays);
  }
  return windows;
}

const apiClient = createFsaApiClient(fsaConfig);
const declarationService = createDeclarationService(apiClient, fsaConfig);

if (CONFIG.MANUAL_TOKEN) apiClient.setManualToken(CONFIG.MANUAL_TOKEN.trim());

// --- Enrich job state -----------------------------------------------------
const enrichJob = { running: false, done: 0, total: 0, errors: 0, startedAt: null };

// --- DB -------------------------------------------------------------------
let db = { records: [], updatedAt: null };

function loadDB() {
  try {
    if (fs.existsSync(CONFIG.DATA_FILE)) {
      db = JSON.parse(fs.readFileSync(CONFIG.DATA_FILE, 'utf8'));
      console.log(`[DB] Загружено ${db.records.length} записей`);
    }
  } catch (e) {
    db = { records: [], updatedAt: null };
  }
}

function saveDB() {
  try {
    fs.mkdirSync(path.dirname(CONFIG.DATA_FILE), { recursive: true });
    fs.writeFileSync(CONFIG.DATA_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('[DB]', e.message);
  }
}

function setStatus(state, message, parsed = 0, errors = 0) {
  const s = { state, message, parsed, errors, time: new Date().toISOString() };
  try {
    fs.mkdirSync(path.dirname(CONFIG.STATUS_FILE), { recursive: true });
    fs.writeFileSync(CONFIG.STATUS_FILE, JSON.stringify(s, null, 2));
  } catch (_) {}
  return s;
}

function getStatus() {
  try {
    if (fs.existsSync(CONFIG.STATUS_FILE)) return JSON.parse(fs.readFileSync(CONFIG.STATUS_FILE, 'utf8'));
  } catch (_) {}
  return { state: 'idle', message: 'Ожидание', time: null };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Парсер (cron) --------------------------------------------------------
let parserRunning = false;

/**
 * Скачивает все страницы одного временно́го окна [dateFrom, dateTo].
 * Возвращает { parsed, errors, hitApiLimit }.
 * hitApiLimit=true означает что окно слишком широкое — нужно сузить.
 */
async function runPageLoop(dateFrom, dateTo, existingIds, newRecords, windowLabel) {
  const maxPages = CONFIG.MAX_PAGES_PER_RUN > 0 ? CONFIG.MAX_PAGES_PER_RUN : Number.MAX_SAFE_INTEGER;
  let page = 0;
  let registryTotal = null;
  let listFetchFailures = 0;
  let parsed = 0;
  let errors = 0;
  let hitApiLimit = false;

  while (page < maxPages) {
    const totalPagesHint =
      registryTotal != null ? Math.max(1, Math.ceil(registryTotal / CONFIG.PAGE_SIZE)) : null;
    const pageLabel = totalPagesHint != null ? `${page + 1}/${totalPagesHint}` : `${page + 1}`;
    const windowInfo = windowLabel ? ` [${windowLabel}]` : '';
    console.log(`[PARSER] Страница ${pageLabel}${windowInfo}${registryTotal != null ? `, реестр ~${registryTotal}` : ''}`);

    let pageData;
    const payload = declarationsListPayload(page, dateFrom, dateTo);
    try {
      pageData = await apiClient.postDeclarationsList(payload);
      listFetchFailures = 0;
    } catch (e) {
      const code = e.response?.status;
      const apiCode = e.response?.data?.code;
      console.error(`  ✗ HTTP ${code || e.message} — ${JSON.stringify(e.response?.data || '').slice(0, 300)}`);
      if (code === 400 && apiCode === 'RDS-APP-9995') {
        console.warn(`[PARSER] Лимит FSA (стр. 21+) в окне ${windowLabel || dateFrom}.`);
        if (CONFIG.DATE_CHUNK > 0) {
          console.warn('[PARSER] Окно слишком широкое — уменьшите FSA_DATE_CHUNK.');
        } else {
          console.warn('[PARSER] Используйте FSA_DATE_CHUNK=week для полного скачивания.');
        }
        hitApiLimit = true;
        break;
      }
      errors++;
      listFetchFailures++;
      if (listFetchFailures >= 10) {
        console.error('[PARSER] 10 ошибок подряд — пропускаю окно');
        break;
      }
      if (code === 401 || code === 403) {
        apiClient.invalidateToken();
        try {
          await apiClient.ensureAuth();
          pageData = await apiClient.postDeclarationsList(payload);
          listFetchFailures = 0;
        } catch (_) {
          await sleep(CONFIG.DELAY_MS);
          continue;
        }
      } else {
        const backoff = Math.min(60000, CONFIG.DELAY_MS * 2 * listFetchFailures);
        console.warn(`  Повтор через ${(backoff / 1000).toFixed(0)} с (попытка ${listFetchFailures}/10)...`);
        await sleep(backoff);
        continue;
      }
    }

    if (registryTotal == null && pageData?.total != null) {
      registryTotal = Number(pageData.total);
    }

    const items = pageData?.items || pageData?.content || pageData?.data || [];
    if (!items.length) {
      console.log('  Страница пуста — конец окна');
      break;
    }
    console.log(`  ✓ ${items.length} записей`);

    for (const item of items) {
      const declId = String(item.id || item.declId || item.declarationId || '');
      if (!declId) continue;

      if (CONFIG.TECH_REGLAMENT) {
        const tr = String(item.technicalReglaments || '').toLowerCase();
        if (!tr.includes(CONFIG.TECH_REGLAMENT)) continue;
      }

      if (existingIds.has(declId)) {
        const idx = db.records.findIndex((r) => (r.fsaId || r.id) === declId);
        if (idx >= 0) {
          db.records[idx].status = parser.mapStatus(item.status || item.docStatus || item.idStatus);
          if (item.group) db.records[idx].group = String(item.group);
          if (item.technicalReglaments) db.records[idx].technicalReglament = String(item.technicalReglaments);
          const productName = item.productFullName || item.productIdentificationName || item.prodName || '';
          if (productName && !db.records[idx].productName) db.records[idx].productName = String(productName);
        }
        continue;
      }

      if (parser.mapStatus(item.docStatus || item.idStatus || item.status) !== 'active') continue;

      let detail = null;
      try {
        detail = await apiClient.getDeclarationById(declId);
        await sleep(300);
      } catch (e) {
        if (e.response?.status !== 404) errors++;
      }
      const rec = parser.mapRecordForDb(item, detail, apiClient.getBaseUrl());
      newRecords.push(rec);
      existingIds.add(declId);
      parsed++;
      console.log(`  + [${declId}] ${(rec.shortName || '').slice(0, 28)} / ${(rec.productName || '').slice(0, 35)}`);
    }

    const lastShortPage = items.length < CONFIG.PAGE_SIZE;
    page++;
    if (lastShortPage) {
      console.log(`  Конец окна: неполная страница (${items.length} < ${CONFIG.PAGE_SIZE})`);
      break;
    }
    await sleep(CONFIG.DELAY_MS);
  }

  if (page >= maxPages && maxPages < Number.MAX_SAFE_INTEGER) {
    console.warn(`[PARSER] Остановка по лимиту FSA_MAX_PAGES_PER_RUN=${maxPages}.`);
  }

  return { parsed, errors, hitApiLimit };
}

async function runParser() {
  console.log(`\n[PARSER] ═══ ${new Date().toLocaleString('ru-RU')} ═══`);
  if (CONFIG.TECH_REGLAMENT) console.log(`[PARSER] Фильтр регламента: "${CONFIG.TECH_REGLAMENT}"`);

  // Определяем окна дат
  let windows;
  if (CONFIG.DATE_CHUNK > 0) {
    if (!CONFIG.DATE_FROM) {
      console.warn('[PARSER] FSA_DATE_CHUNK задан, но FSA_DATE_FROM не задан — chunking пропущен');
      windows = [{ from: CONFIG.DATE_FROM, to: CONFIG.DATE_TO }];
    } else {
      windows = generateDateWindows(CONFIG.DATE_FROM, CONFIG.DATE_TO, CONFIG.DATE_CHUNK);
      console.log(`[PARSER] Режим: chunked (шаг ${CONFIG.DATE_CHUNK} дн.), окон: ${windows.length}`);
      console.log(`[PARSER] Диапазон: ${windows[0].from} — ${windows[windows.length - 1].to}`);
    }
  } else {
    windows = [{ from: CONFIG.DATE_FROM, to: CONFIG.DATE_TO }];
    if (CONFIG.DATE_FROM || CONFIG.DATE_TO) {
      console.log(`[PARSER] Диапазон дат: ${CONFIG.DATE_FROM || '*'} — ${CONFIG.DATE_TO || '*'}`);
    }
    if (CONFIG.MAX_PAGES_PER_RUN > 0) {
      console.log(`[PARSER] Лимит страниц: ${CONFIG.MAX_PAGES_PER_RUN}`);
    } else {
      console.log(`[PARSER] Режим: все страницы (размер страницы ${CONFIG.PAGE_SIZE})`);
    }
  }

  setStatus('running', 'Авторизация...');
  const token = await apiClient.ensureAuth();
  if (!token) {
    setStatus('error', 'Не удалось получить токен. Задайте FSA_MANUAL_TOKEN или проверьте сеть.');
    return;
  }

  let totalParsed = 0;
  let totalErrors = 0;
  let totalHitLimit = 0;
  const newRecords = [];
  const existingIds = new Set(db.records.map((r) => r.fsaId || r.id));

  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    const label = `${w.from}–${w.to || 'сейчас'}`;
    if (windows.length > 1) {
      console.log(`\n[PARSER] Окно ${i + 1}/${windows.length}: ${label}`);
      setStatus('running', `Окно ${i + 1}/${windows.length}: ${label}`, totalParsed, totalErrors);
    }

    const { parsed, errors, hitApiLimit } = await runPageLoop(
      w.from, w.to, existingIds, newRecords, windows.length > 1 ? label : null
    );
    totalParsed += parsed;
    totalErrors += errors;
    if (hitApiLimit) totalHitLimit++;

    // Пауза между окнами чтобы не перегружать API
    if (i < windows.length - 1) await sleep(CONFIG.DELAY_MS);
  }

  if (totalHitLimit > 0) {
    console.warn(`[PARSER] ⚠ ${totalHitLimit} окн(а) упёрлись в лимит FSA. Уменьшите FSA_DATE_CHUNK.`);
  }

  if (newRecords.length > 0) {
    db.records = [...newRecords, ...db.records];
    if (CONFIG.MAX_RECORDS > 0 && db.records.length > CONFIG.MAX_RECORDS) {
      db.records = db.records.slice(0, CONFIG.MAX_RECORDS);
      console.warn(`[PARSER] Обрезка БД до FSA_MAX_RECORDS=${CONFIG.MAX_RECORDS}`);
    }
  }
  db.updatedAt = new Date().toISOString();
  saveDB();
  const msg = `Готово. Новых: ${newRecords.length}, всего: ${db.records.length}, ошибок: ${totalErrors}`;
  console.log(`[PARSER] ${msg}\n`);
  setStatus('idle', msg, totalParsed, totalErrors);

  // Фоновое обогащение: ИНН → ОКВЭД → farmerType
  if (newRecords.length > 0) {
    setImmediate(async () => {
      try {
        console.log(`[INN] Запуск обогащения для ${newRecords.length} новых записей...`);
        await enrichRecords(newRecords);
        // Применяем обновлённые farmerType обратно в БД и сохраняем
        const idToType = new Map(newRecords.map(r => [r.id, { farmerType: r.farmerType, okved: r.okved }]));
        for (const rec of db.records) {
          const upd = idToType.get(rec.id);
          if (upd) { rec.farmerType = upd.farmerType; rec.okved = upd.okved; }
        }
        saveDB();
        // Уведомить Telegram об избранных
        await telegramBot.notifyFavorites(newRecords);
      } catch (e) {
        console.error('[INN]', e.message);
      }
    });
  }
}

async function safeRunParser() {
  if (parserRunning) return;
  parserRunning = true;
  try {
    await runParser();
  } catch (e) {
    console.error('[PARSER]', e.message);
    setStatus('error', e.message);
  } finally {
    parserRunning = false;
  }
}

// --- HTTP -----------------------------------------------------------------
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Нормализованные сведения по декларации (для интеграций)
app.get('/api/fsa/declarations/:id/data', async (req, res) => {
  try {
    const data = await declarationService.getDeclarationData(req.params.id, { strict: true });
    res.json(data);
  } catch (e) {
    const code = e.response?.status === 404 ? 404 : 502;
    res.status(code).json({ error: e.message || 'Ошибка загрузки' });
  }
});

// Пакет: { "ids": ["1","2"], "listItemsById": { "1": { ... } } }
app.post('/api/fsa/declarations/data-batch', async (req, res) => {
  const { ids, listItemsById } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'Нужен массив ids' });
  try {
    const map = await declarationService.getDeclarationsData(ids, { listItemsById: listItemsById || {} });
    res.json(Object.fromEntries(map));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/declarations', (req, res) => {
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
    dateSearch = '',
    applicant = '',
    address = '',
    product = '',
    sortField = 'regDate',
    sortDir = 'desc',
  } = req.query;
  let r = [...db.records];
  const q = search.toLowerCase();
  if (q)
    r = r.filter((x) =>
      [x.group, x.technicalReglament, x.shortName, x.lastName, x.firstName, x.address, x.phone, x.productName, x.batchSize, x.otherInfo, x.applicantName]
        .join(' ')
        .toLowerCase()
        .includes(q)
    );
  if (source) r = r.filter((x) => x.source === source);
  if (status) r = r.filter((x) => x.status === status);
  if (group) r = r.filter((x) => (x.group || '').toLowerCase().includes(group.toLowerCase()));
  if (manufacturer)
    r = r.filter(
      (x) =>
        (x.shortName || '').toLowerCase().includes(manufacturer.toLowerCase()) ||
        (x.lastName || '').toLowerCase().includes(manufacturer.toLowerCase())
    );
  if (techReglament)
    r = r.filter((x) => (x.technicalReglament || '').toLowerCase().includes(String(techReglament).toLowerCase()));
  if (dateFrom) r = r.filter((x) => x.regDate >= dateFrom);
  if (dateTo) r = r.filter((x) => x.regDate <= dateTo);
  if (dateSearch) r = r.filter((x) => (x.regDate || '').includes(dateSearch));
  if (applicant) r = r.filter((x) => (x.applicantName || '').toLowerCase().includes(applicant.toLowerCase()));
  if (address) r = r.filter((x) => (x.address || '').toLowerCase().includes(address.toLowerCase()));
  if (product) r = r.filter((x) => (x.productName || '').toLowerCase().includes(product.toLowerCase()));
  r.sort((a, b) =>
    sortDir === 'asc'
      ? (a[sortField] || '').localeCompare(b[sortField] || '')
      : (b[sortField] || '').localeCompare(a[sortField] || '')
  );
  const total = r.length;
  const p = +page;
  const s = +size;
  res.json({ items: r.slice(p * s, p * s + s), total, page: p, size: s, pages: Math.ceil(total / s) || 1 });
});

app.get('/api/declarations/:id', (req, res) => {
  const r = db.records.find((x) => x.id === req.params.id || x.fsaId === req.params.id);
  r ? res.json(r) : res.status(404).json({ error: 'Не найдено' });
});

app.post('/api/declarations', (req, res) => {
  const rec = { id: 'manual_' + Date.now(), source: 'manual', status: 'active', fetchedAt: new Date().toISOString(), ...req.body };
  db.records.unshift(rec);
  saveDB();
  res.status(201).json(rec);
});

app.put('/api/declarations/:id', (req, res) => {
  const i = db.records.findIndex((x) => x.id === req.params.id || x.fsaId === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Не найдено' });
  db.records[i] = { ...db.records[i], ...req.body, id: db.records[i].id };
  saveDB();
  res.json(db.records[i]);
});

app.delete('/api/declarations/:id', (req, res) => {
  const n = db.records.length;
  db.records = db.records.filter((x) => x.id !== req.params.id && x.fsaId !== req.params.id);
  if (db.records.length === n) return res.status(404).json({ error: 'Не найдено' });
  saveDB();
  res.json({ ok: true });
});

app.get('/api/status', (req, res) =>
  res.json({ ...getStatus(), totalRecords: db.records.length, lastUpdated: db.updatedAt, isRunning: parserRunning })
);

app.post('/api/parse', (req, res) => {
  if (parserRunning) return res.json({ ok: false, message: 'Уже запущен' });
  res.json({ ok: true, message: 'Запущен' });
  setImmediate(safeRunParser);
});

app.get('/api/stats', (req, res) => {
  const uniqueProducers = new Set(
    db.records.map(r => (r.shortName || r.applicantName || r.lastName || '').trim()).filter(Boolean)
  ).size;
  res.json({
    total: uniqueProducers,
    active: db.records.filter((r) => r.status === 'active').length,
    suspended: db.records.filter((r) => r.status === 'suspended').length,
    expired: db.records.filter((r) => r.status === 'expired').length,
    manual: db.records.filter((r) => r.source === 'manual').length,
    fsa: db.records.filter((r) => r.source === 'fsa').length,
  });
});

// ── Telegram конфиг ──────────────────────────────────────────────────────────
app.get('/api/telegram-config', (req, res) => res.json(telegramBot.loadConfig()));

app.post('/api/telegram-config', (req, res) => {
  const { botToken, chatId } = req.body || {};
  if (!botToken || !chatId) return res.status(400).json({ error: 'botToken и chatId обязательны' });
  telegramBot.saveConfig({ botToken: String(botToken).trim(), chatId: String(chatId).trim() });
  res.json({ ok: true });
});

app.post('/api/telegram-test', async (req, res) => {
  const ok = await telegramBot.sendMessage('✅ Тест уведомлений FSA Parser работает!');
  res.json({ ok });
});

// ── Карточка компании ─────────────────────────────────────────────────────────
const COMPANIES_FILE = path.join(__dirname, '../data/companies.json');

function loadCompanies() {
  try { if (fs.existsSync(COMPANIES_FILE)) return JSON.parse(fs.readFileSync(COMPANIES_FILE, 'utf8')); } catch (_) {}
  return {};
}
function saveCompanies(data) {
  fs.mkdirSync(path.dirname(COMPANIES_FILE), { recursive: true });
  fs.writeFileSync(COMPANIES_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/company', (req, res) => {
  const { inn, name } = req.query;
  if (!inn && !name) return res.status(400).json({ error: 'inn or name required' });
  let records = db.records;
  if (inn) {
    records = records.filter(r => r.inn === inn);
  } else {
    const q = name.toLowerCase();
    records = records.filter(r =>
      (r.shortName || r.applicantName || r.lastName || '').toLowerCase() === q
    );
  }
  if (!records.length) return res.json({ found: false, decls: [] });
  const first = records[0];
  const notesKey = inn || name;
  const companies = loadCompanies();
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
    description: companies[notesKey]?.description || '',
    notes: companies[notesKey]?.notes || '',
    decls: records
      .map(r => ({
        id: String(r.id || r.fsaId || ''),
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

app.put('/api/company/notes', (req, res) => {
  const { inn, name, notes, description } = req.body;
  const key = inn || name;
  if (!key) return res.status(400).json({ error: 'inn or name required' });
  const companies = loadCompanies();
  if (!companies[key]) companies[key] = {};
  if (notes !== undefined) companies[key].notes = notes?.trim() || '';
  if (description !== undefined) companies[key].description = description?.trim() || '';
  companies[key].updatedAt = new Date().toISOString();
  if (!companies[key].notes && !companies[key].description) delete companies[key];
  saveCompanies(companies);
  res.json({ ok: true });
});

// ── Массовое обогащение ИНН/ОКВЭД ────────────────────────────────────────────
app.get('/api/enrich-status', (req, res) => {
  const pending = db.records.filter(r => !r.farmerType || r.farmerType === 'unknown').length;
  res.json({ ...enrichJob, pending });
});

app.post('/api/enrich', (req, res) => {
  if (enrichJob.running) return res.json({ ok: false, message: 'Уже запущено' });
  enrichJob.running = true;
  enrichJob.startedAt = new Date().toISOString();
  res.json({ ok: true, message: 'Обогащение запущено' });
  setImmediate(() =>
    enrichExisting(db.records, enrichJob, saveDB).catch(e => {
      console.error('[INN]', e.message);
      enrichJob.running = false;
    })
  );
});

app.post('/api/enrich/stop', (req, res) => {
  enrichJob.running = false;
  res.json({ ok: true });
});

// ── Избранные компании ────────────────────────────────────────────────────────
const FAV_FILE = path.join(__dirname, '../data/favorites.json');

function loadFavs() {
  try { if (fs.existsSync(FAV_FILE)) return JSON.parse(fs.readFileSync(FAV_FILE, 'utf8')); } catch (_) {}
  return [];
}
function saveFavs(list) {
  fs.mkdirSync(path.dirname(FAV_FILE), { recursive: true });
  fs.writeFileSync(FAV_FILE, JSON.stringify(list, null, 2));
}

app.get('/api/favorites', (req, res) => res.json(loadFavs()));

app.post('/api/favorites', (req, res) => {
  const { inn, name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name обязателен' });
  const list = loadFavs();
  const key = inn || name;
  if (!list.find(f => (f.inn || f.name) === key)) {
    list.push({ inn: inn || '', name, addedAt: new Date().toISOString() });
    saveFavs(list);
  }
  res.json({ ok: true });
});

app.delete('/api/favorites', (req, res) => {
  const { inn, name } = req.body || {};
  const key = inn || name;
  const list = loadFavs().filter(f => (f.inn || f.name) !== key);
  saveFavs(list);
  res.json({ ok: true });
});

// ── Папки ─────────────────────────────────────────────────────────────────────
const FOLDERS_FILE = path.join(__dirname, '../data/folders.json');

function loadFolders() {
  try { if (fs.existsSync(FOLDERS_FILE)) return JSON.parse(fs.readFileSync(FOLDERS_FILE, 'utf8')); } catch (_) {}
  return [];
}
function saveFolders(list) {
  fs.mkdirSync(path.dirname(FOLDERS_FILE), { recursive: true });
  fs.writeFileSync(FOLDERS_FILE, JSON.stringify(list, null, 2));
}

app.get('/api/folders', (req, res) => res.json(loadFolders()));

app.post('/api/folders', (req, res) => {
  const { name, parentId } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name обязателен' });
  const list = loadFolders();
  const folder = { id: Date.now().toString(), name: name.trim(), parentId: parentId || null, items: [], createdAt: new Date().toISOString() };
  list.push(folder);
  saveFolders(list);
  res.status(201).json(folder);
});

app.delete('/api/folders/:id', (req, res) => {
  const list = loadFolders().filter(f => f.id !== req.params.id);
  saveFolders(list);
  res.json({ ok: true });
});

// Добавить/убрать элемент из папки: { type: 'inn'|'decl', value: '...' }
app.post('/api/folders/:id/items', (req, res) => {
  const { type, value, label } = req.body || {};
  if (!type || !value) return res.status(400).json({ error: 'type и value обязательны' });
  const list = loadFolders();
  const folder = list.find(f => f.id === req.params.id);
  if (!folder) return res.status(404).json({ error: 'Папка не найдена' });
  if (!folder.items.find(i => i.type === type && i.value === value)) {
    folder.items.push({ type, value, ...(label ? { label } : {}) });
  }
  saveFolders(list);
  res.json({ ok: true });
});

app.delete('/api/folders/:id/items', (req, res) => {
  const { type, value } = req.body || {};
  const list = loadFolders();
  const folder = list.find(f => f.id === req.params.id);
  if (!folder) return res.status(404).json({ error: 'Папка не найдена' });
  folder.items = folder.items.filter(i => !(i.type === type && i.value === value));
  saveFolders(list);
  res.json({ ok: true });
});

function extractCity(address) {
  if (!address) return null;
  // \b doesn't work with Cyrillic in JS — use explicit delimiter instead
  // Handles: "г. Город", "Г.ГОРОД", "г.о. Город", "г Город", "ГОРОД КРАСНОДАР"
  const m = address.match(/(?:^|[,;\s])([Гг])(?:\.о?\.?\s*|\s+)([А-ЯЁа-яё][А-ЯЁа-яё\-]+(?:\s+[А-ЯЁа-яё][А-ЯЁа-яё\-]+)*)/);
  if (m) return m[2].split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  return null;
}

app.get('/api/producers', (req, res) => {
  const { search = '', dateFrom = '', dateTo = '', manufacturer = '', address = '', product = '', farmerType = '' } = req.query;
  let records = db.records;
  if (dateFrom) records = records.filter(r => !r.regDate || r.regDate >= dateFrom);
  if (dateTo)   records = records.filter(r => !r.regDate || r.regDate <= dateTo);
  if (search) {
    const q = search.toLowerCase();
    records = records.filter(r =>
      [r.shortName, r.applicantName, r.lastName, r.address, r.productName, r.group, r.inn]
        .some(v => (v || '').toLowerCase().includes(q)));
  }
  if (manufacturer) {
    const q = manufacturer.toLowerCase();
    records = records.filter(r => (r.shortName || r.applicantName || r.lastName || '').toLowerCase().includes(q));
  }
  if (address) {
    const q = address.toLowerCase();
    records = records.filter(r => (r.address || '').toLowerCase().includes(q));
  }
  if (product) {
    const q = product.toLowerCase();
    records = records.filter(r => (r.productName || '').toLowerCase().includes(q));
  }

  // Группируем по ИНН (если есть), иначе по имени
  const producerMap = new Map();
  for (const r of records) {
    const key = r.inn || (r.shortName || r.applicantName || r.lastName || '—').trim();
    if (!producerMap.has(key)) {
      producerMap.set(key, {
        inn: r.inn || '',
        name: (r.shortName || r.applicantName || r.lastName || '—').trim(),
        address: '',
        phone: '',
        farmerType: r.farmerType || 'unknown',
        okved: r.okved || '',
        decls: [],
      });
    }
    const p = producerMap.get(key);
    if (!p.address && r.address) p.address = r.address;
    if (!p.phone && r.phone) p.phone = r.phone;
    if (p.farmerType === 'unknown' && r.farmerType && r.farmerType !== 'unknown') {
      p.farmerType = r.farmerType;
      p.okved = r.okved || '';
    }
    p.decls.push({
      id: String(r.id || r.fsaId || ''),
      regDate: r.regDate || '',
      productName: r.productName || '',
      batchSize: r.batchSize || '',
      group: r.group || '',
      declNumber: r.declNumber || '',
      fsaUrl: r.fsaUrl || '',
    });
  }

  let producers = [...producerMap.values()].sort((a, b) => b.decls.length - a.decls.length);
  if (farmerType) producers = producers.filter(p => p.farmerType === farmerType);

  const total = producers.length;
  const page = Math.max(0, parseInt(req.query.page) || 0);
  const size = Math.min(200, Math.max(1, parseInt(req.query.size) || 50));
  const items = producers.slice(page * size, (page + 1) * size);
  res.json({ items, total, page, pages: Math.ceil(total / size) });
});

app.get('/api/map-data', (req, res) => {
  const cityMap = {};
  for (const rec of db.records) {
    if (!rec.address) continue;
    const city = extractCity(rec.address);
    if (!city) continue;
    if (!cityMap[city]) cityMap[city] = { city, count: 0, farmers: 0, traders: 0, orgs: {} };
    cityMap[city].count++;
    if (rec.farmerType === 'farmer') cityMap[city].farmers++;
    else if (rec.farmerType === 'trader') cityMap[city].traders++;
    const key = rec.shortName || rec.applicantName || rec.lastName || '—';
    if (!cityMap[city].orgs[key]) {
      cityMap[city].orgs[key] = { name: key, inn: rec.inn || '', farmerType: rec.farmerType || 'unknown', decls: [] };
    }
    const id = String(rec.id || rec.fsaId || '');
    if (id) cityMap[city].orgs[key].decls.push({ id, product: (rec.productName || '').slice(0, 80) });
  }
  const cities = Object.values(cityMap)
    .map(c => ({
      city: c.city,
      count: c.count,
      farmers: c.farmers,
      traders: c.traders,
      orgs: Object.values(c.orgs)
        .sort((a, b) => b.decls.length - a.decls.length)
        .map(o => ({ name: o.name, inn: o.inn, farmerType: o.farmerType, count: o.decls.length, decls: o.decls })),
    }))
    .sort((a, b) => b.count - a.count);
  res.json({ cities, total: cities.reduce((s, c) => s + c.count, 0) });
});

app.get('/api/export/csv', (req, res) => {
  const H = [
    'ID',
    'Номер декларации',
    'Заявитель',
    'Источник',
    'Статус',
    'Группа продукции',
    'Тех.регламент',
    'Дата регистрации',
    'Дата окончания',
    'Фамилия',
    'Имя',
    'Отчество',
    'Краткое наим.',
    'Адрес',
    'Телефон',
    'Наименование продукции',
    'Партия',
    'Доп.инфо',
    'Ссылка FSA',
  ];
  const rows = db.records.map((r) =>
    [
      r.id,
      r.declNumber || '',
      r.applicantName || '',
      r.source,
      r.status,
      r.group,
      r.technicalReglament || '',
      r.regDate,
      r.endDate,
      r.lastName,
      r.firstName,
      r.middleName,
      r.shortName,
      r.address,
      r.phone,
      r.productName,
      r.batchSize,
      r.otherInfo,
      r.fsaUrl || '',
    ].map((v) => '"' + String(v || '').replace(/"/g, '""') + '"')
  );
  const csv = '﻿' + [H, ...rows].map((r) => r.join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="fsa_${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

app.post('/api/settoken', (req, res) => {
  const { token } = req.body;
  if (!token || !isJwtString(token)) return res.status(400).json({ error: 'Неверный токен' });
  apiClient.setManualToken(token);
  const st = apiClient.getState();
  console.log(`[AUTH] Токен установлен вручную, истекает: ${new Date(st.expiresAt).toLocaleTimeString('ru-RU')}`);
  res.json({ ok: true, expiresAt: new Date(st.expiresAt).toISOString() });
});

app.get('/api/debug/fsa', async (req, res) => {
  const result = {};
  try {
    const axios = require('axios');
    const r1 = await axios.get(`${fsaConfig.fsaBaseUrl}${fsaConfig.paths.sessionBootstrap}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/146.0', Accept: 'text/html' },
      timeout: 10000,
      maxRedirects: 5,
    });
    const { parseCookiesFromResponse } = require('./services/authUtils');
    result.step1 = { ok: true, status: r1.status, cookies: r1.headers['set-cookie'] };

    const { createFsaApiClient } = require('./services/apiClient');
    const probeClient = createFsaApiClient(fsaConfig);
    await probeClient.ensureAuth();
    const t = probeClient.getState().token;
    if (t && isJwtString(t)) {
      result.tokenOk = true;
      result.tokenPreview = t.slice(0, 60) + '...';
      const r3 = await probeClient.postDeclarationsList({
        page: 0,
        size: 2,
        filters: {},
        selectedColumns: ['declarationId', 'docStatus', 'prodName', 'group'],
      });
      result.listTest = {
        ok: true,
        items: (r3?.items || []).length,
        total: r3?.total,
        preview: JSON.stringify(r3?.items?.[0] || {}).slice(0, 300),
      };
    }
  } catch (e) {
    result.error = { status: e.response?.status, message: e.message };
  }
  res.json(result);
});

// ── Прокси тайлов Яндекс.Карт (обход CORS) ───────────────────────────────
const https = require('https');
app.get('/api/tiles/:z/:x/:y', (req, res) => {
  const { z, x, y } = req.params;
  const url = `https://core-renderer-tiles.maps.yandex.net/tiles?l=map&x=${x}&y=${y}&z=${z}&scale=1&lang=ru_RU`;
  const request = https.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://yandex.ru/maps/',
    },
  }, (tileRes) => {
    if (tileRes.statusCode !== 200) { res.status(tileRes.statusCode).end(); return; }
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=604800');
    tileRes.pipe(res);
  });
  request.on('error', () => res.status(502).end());
});

loadDB();

if (require.main === module) {
  cron.schedule(CONFIG.CRON_SCHEDULE, () => safeRunParser());
  app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════╗
║  FSA Parser v7                           ║
║  Сайт:    http://localhost:${PORT}          ║
║  API:     /api/declarations              ║
║  Статус:  /api/status                   ║
║  Дебаг:   /api/debug/fsa                ║
╚══════════════════════════════════════════╝
`);
    setTimeout(safeRunParser, 2000);
  });
}

module.exports = {
  app,
  apiClient,
  declarationService,
  getDeclarationData: (id, opts) => declarationService.getDeclarationData(id, opts),
};
