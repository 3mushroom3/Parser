/**
 * Фоновое обогащение деклараций данными ФНС:
 * ИНН → ОКВЭД → farmerType (farmer / trader / unknown).
 * Результаты кешируются в data/inn_cache.json (один запрос на ИНН навсегда).
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { lookupInn, lookupByName, classifyOkved, classifyByName, buildMixedActivityNote, RATE_LIMITED } = require('./fnsClient');

const CACHE_FILE = path.join(__dirname, '../../data/inn_cache.json');
const DELAY_MS = 300; // пауза между запросами (dadata допускает быстрее чем itsoft)

// Сохраняет дату регистрации/авто-пометку в companies, не трогая ручные description/notes.
const _upsertCompanyInfoStmt = db.prepare(`
  INSERT INTO companies (id, inn, name, regDate, autoNote)
  VALUES (@key, @inn, @name, @regDate, @autoNote)
  ON CONFLICT(id) DO UPDATE SET
    regDate = COALESCE(NULLIF(excluded.regDate, ''), companies.regDate),
    autoNote = excluded.autoNote,
    updatedAt = CURRENT_TIMESTAMP
`);
function upsertCompanyInfo(key, inn, name, regDate, autoNote) {
  if (!key || (!regDate && !autoNote)) return;
  try {
    _upsertCompanyInfoStmt.run({ key, inn: inn || null, name: name || null, regDate: regDate || '', autoNote: autoNote || '' });
  } catch (e) {
    console.warn('[INN] Ошибка сохранения regDate/autoNote для', key, ':', e.message);
  }
}

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch (_) {}
  return {};
}

function saveCache(cache) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.warn('[INN] Ошибка сохранения кэша:', e.message);
  }
}

/**
 * Обогащает массив новых записей (после парсинга FSA).
 * Изменяет записи на месте: rec.farmerType, rec.okved, rec.inn (если нашли по имени).
 */
async function enrichRecords(records) {
  const cache = loadCache();
  let newLookups = 0;
  let cacheHits = 0;

  for (const rec of records) {
    const inn = rec.inn;

    // ── Есть ИНН — ищем по нему ──────────────────────────────────────────
    if (inn) {
      if (cache[inn]) {
        rec.farmerType = cache[inn].farmerType;
        rec.okved = cache[inn].okved || '';
        cacheHits++;
        continue;
      }
      try {
        await new Promise(r => setTimeout(r, DELAY_MS));
        const data = await lookupInn(inn);
        const farmerType = data ? classifyOkved(data.okved, data.okveds) : 'unknown';
        const okved = data?.okved || '';
        const autoNote = data ? buildMixedActivityNote(data.okved, data.okveds) : '';
        cache[inn] = { farmerType, okved, regDate: data?.regDate || '', autoNote, checkedAt: new Date().toISOString() };
        rec.farmerType = farmerType;
        rec.okved = okved;
        upsertCompanyInfo(inn, inn, rec.shortName || rec.applicantName || rec.lastName, data?.regDate, autoNote);
        newLookups++;
        console.log(`[INN] ${inn} → ${okved || '?'} → ${farmerType}`);
      } catch (e) {
        console.warn(`[INN] Ошибка для ИНН ${inn}: ${e.message}`);
        cache[inn] = { farmerType: 'unknown', okved: '', checkedAt: new Date().toISOString() };
        rec.farmerType = 'unknown';
        newLookups++;
      }
      continue;
    }

    // ── Нет ИНН — ищем по названию компании ─────────────────────────────
    const nameKey = rec.shortName || rec.applicantName || rec.lastName;
    if (!nameKey) continue;

    const nameCacheKey = 'name:' + nameKey;
    if (cache[nameCacheKey]) {
      rec.farmerType = cache[nameCacheKey].farmerType;
      rec.okved = cache[nameCacheKey].okved || '';
      if (cache[nameCacheKey].inn) rec.inn = cache[nameCacheKey].inn;
      cacheHits++;
      continue;
    }

    try {
      await new Promise(r => setTimeout(r, DELAY_MS));
      const data = await lookupByName(nameKey);
      const farmerType = data ? classifyOkved(data.okved, data.okveds) : 'unknown';
      const okved = data?.okved || '';
      const foundInn = data?.inn || '';
      const autoNote = data ? buildMixedActivityNote(data.okved, data.okveds) : '';

      cache[nameCacheKey] = { farmerType, okved, inn: foundInn, regDate: data?.regDate || '', autoNote, checkedAt: new Date().toISOString() };
      if (foundInn) cache[foundInn] = { farmerType, okved, regDate: data?.regDate || '', autoNote, checkedAt: new Date().toISOString() };

      rec.farmerType = farmerType;
      rec.okved = okved;
      if (foundInn) rec.inn = foundInn;
      upsertCompanyInfo(foundInn || nameKey, foundInn, nameKey, data?.regDate, autoNote);
      newLookups++;
      console.log(`[INN] "${nameKey.slice(0,30)}" → ИНН ${foundInn || '?'} → ${okved || '?'} → ${farmerType}`);
    } catch (e) {
      console.warn(`[INN] Ошибка для "${nameKey.slice(0,30)}": ${e.message}`);
      cache[nameCacheKey] = { farmerType: 'unknown', okved: '', checkedAt: new Date().toISOString() };
      rec.farmerType = 'unknown';
      newLookups++;
    }
  }

  if (newLookups > 0) saveCache(cache);
  if (newLookups > 0 || cacheHits > 0) {
    console.log(`[INN] Обогащено: ${newLookups} новых запросов, ${cacheHits} из кэша`);
  }
  return newLookups;
}

/**
 * Применяет кэш к существующим записям без новых запросов к ФНС.
 */
function applyCache(records) {
  const cache = loadCache();
  let updated = 0;
  for (const rec of records) {
    const key = rec.inn ? rec.inn : ('name:' + (rec.shortName || rec.applicantName || rec.lastName || ''));
    if (cache[key] && (!rec.farmerType || rec.farmerType === 'unknown')) {
      rec.farmerType = cache[key].farmerType;
      rec.okved = cache[key].okved || '';
      if (!rec.inn && cache[key].inn) rec.inn = cache[key].inn;
      updated++;
    }
  }
  return updated;
}

/**
 * Массовое обогащение существующих записей БД.
 * job = { running, done, total, errors, stop } — объект состояния (изменяется на месте).
 * saveDb — функция сохранения БД.
 * Обрабатывает записи пачками по batchSize, сохраняет каждые savePer записей.
 */
let autoEnrichJob = { running: false, done: 0, total: 0, errors: 0, apiCalls: 0, startedAt: null };

async function enrichExisting(records, job, saveDb, { batchSize = 50, savePer = 200, maxApiCalls = 0 } = {}) {
  const cache = loadCache();
  const toProcess = records.filter(r => !r.farmerType || r.farmerType === 'unknown');
  job.total = toProcess.length;
  job.done = 0;
  job.errors = 0;
  if (!job.apiCalls) job.apiCalls = 0;

  console.log(`[INN] Запуск массового обогащения: ${job.total} записей`);

  for (let i = 0; i < toProcess.length; i++) {
    if (!job.running) {
      console.log(`[INN] Обогащение остановлено на ${i}/${job.total}`);
      break;
    }

    const rec = toProcess[i];
    const inn = rec.inn;
    const nameKey = rec.shortName || rec.applicantName || rec.lastName;
    const cacheKey = inn || ('name:' + nameKey);

    if (!cacheKey || cacheKey === 'name:') { job.done++; continue; }

    // Есть в кэше — применяем мгновенно
    if (cache[cacheKey]) {
      rec.farmerType = cache[cacheKey].farmerType;
      rec.okved = cache[cacheKey].okved || '';
      if (!rec.inn && cache[cacheKey].inn) rec.inn = cache[cacheKey].inn;
      job.done++;
      continue;
    }

    // Запрос к ФНС
    if (maxApiCalls > 0 && (job.apiCalls || 0) >= maxApiCalls) {
      console.log(`[INN] Достигнут дневной лимит ${maxApiCalls} запросов к API`);
      break;
    }
    try {
      await new Promise(r => setTimeout(r, DELAY_MS));
      job.apiCalls = (job.apiCalls || 0) + 1;
      const data = inn ? await lookupInn(inn) : await lookupByName(nameKey);

      // 429 — rate limit, НЕ кэшируем, применяем name-fallback
      if (data === RATE_LIMITED) {
        const nameFallback = classifyByName(nameKey || rec.shortName || rec.applicantName || rec.lastName || '');
        rec.farmerType = nameFallback;
        job.done++;
        continue;
      }

      const okved = data?.okved || '';
      const foundInn = data?.inn || inn || '';
      let farmerType = data ? classifyOkved(data.okved, data.okveds) : 'unknown';
      const autoNote = data ? buildMixedActivityNote(data.okved, data.okveds) : '';

      // Если ОКВЭД не получен — пробуем по названию
      if (farmerType === 'unknown') {
        const nameFallback = classifyByName(nameKey || rec.shortName || rec.applicantName || rec.lastName || '');
        if (nameFallback !== 'unknown') farmerType = nameFallback;
      }

      cache[cacheKey] = { farmerType, okved, inn: foundInn, regDate: data?.regDate || '', autoNote, checkedAt: new Date().toISOString() };
      if (foundInn && foundInn !== cacheKey) {
        cache[foundInn] = { farmerType, okved, regDate: data?.regDate || '', autoNote, checkedAt: new Date().toISOString() };
      }

      rec.farmerType = farmerType;
      rec.okved = okved;
      if (foundInn) rec.inn = foundInn;
      upsertCompanyInfo(foundInn || nameKey, foundInn, nameKey || rec.shortName || rec.applicantName || rec.lastName, data?.regDate, autoNote);

      if (i < 20 || farmerType !== 'unknown') {
        console.log(`[INN] [${i+1}/${job.total}] "${(nameKey||inn||'').slice(0,35)}" → ИНН:${foundInn||'?'} ОКВЭД:${okved||'нет'} → ${farmerType}`);
      }
    } catch (e) {
      // Не кэшируем ошибки сети — повторим при следующем запуске
      // Но пробуем name-fallback прямо сейчас
      const nameFallback = classifyByName(nameKey || rec.shortName || rec.applicantName || rec.lastName || '');
      rec.farmerType = nameFallback;
      if (nameFallback !== 'unknown') {
        console.log(`[INN] [${i+1}] name-fallback "${(nameKey||'').slice(0,30)}" → ${nameFallback}`);
      }
      job.errors++;
    }

    job.done++;

    // Сохраняем периодически
    if (job.done % savePer === 0) {
      saveCache(cache);
      saveDb();
      console.log(`[INN] Прогресс: ${job.done}/${job.total}, ошибок: ${job.errors}`);
    }
  }

  saveCache(cache);
  saveDb();
  job.running = false;
  console.log(`[INN] Массовое обогащение завершено: ${job.done}/${job.total}, ошибок: ${job.errors}`);
}

module.exports = { enrichRecords, enrichExisting, applyCache, autoEnrichJob };
