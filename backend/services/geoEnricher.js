/**
 * Наполнение карты: адрес декларации → населённый пункт → координаты.
 *
 * Два шага, оба фоновые:
 *   1. runParsePass()   — worker проставляет declarations.placeKey и собирает
 *                         справочник geo_places (локально, без сети).
 *   2. runGeocodePass() — берёт из geo_places непокоординированные НП и спрашивает
 *                         координаты у DaData. Самые «населённые» НП идут первыми,
 *                         чтобы карта наполнялась по значимости, а не по алфавиту.
 *
 * Координаты кешируются навсегда: запрос к геокодеру делается один раз на
 * населённый пункт, а не на декларацию (17 тыс. НП против 600 тыс. деклараций).
 * Суточный бюджет запросов ограничен — токен DaData общий с обогащением ОКВЭД
 * (10 000 запросов/сутки на двоих).
 */
const path = require('path');
const { Worker } = require('worker_threads');
const db = require('./db');
const logger = require('./logger');
const { geocode, RateLimitError } = require('./geocoder');

const PARSE_WORKER = path.join(__dirname, '..', 'workers', 'geoParseWorker.js');

// Бюджет и пауза: у DaData 10 000 запросов/сутки, 3000 из них забирает обогащение
// ОКВЭД (ENRICH_DAILY_LIMIT), поэтому по умолчанию берём 5000.
const DAILY_LIMIT = parseInt(process.env.GEO_DAILY_LIMIT || '5000', 10);
const DELAY_MS = parseInt(process.env.GEO_DELAY_MS || '350', 10);
const MAX_ATTEMPTS = 2;

const geoJob = {
  running: false,
  phase: null,        // parse | geocode
  parsed: 0,
  places: 0,
  geocoded: 0,
  failed: 0,
  apiCalls: 0,
  pending: null,
  startedAt: null,
  finishedAt: null,
  lastError: null,
};

const updateOkStmt = db.prepare(`
  UPDATE geo_places
  SET lat = ?, lon = ?, accuracy = ?, status = 'ok', source = 'dadata',
      attempts = attempts + 1, updatedAt = CURRENT_TIMESTAMP
  WHERE key = ?
`);
const updateFailStmt = db.prepare(`
  UPDATE geo_places
  SET attempts = attempts + 1,
      status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END,
      updatedAt = CURRENT_TIMESTAMP
  WHERE key = ?
`);
const pendingStmt = db.prepare(`
  SELECT key, query, region, district, name, type
  FROM geo_places
  WHERE status = 'pending'
  ORDER BY declCount DESC, key
  LIMIT ?
`);

function stats() {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'ok'      THEN 1 ELSE 0 END) AS ok,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END) AS failed
    FROM geo_places
  `).get();
  const decl = db.prepare(`
    SELECT
      SUM(CASE WHEN placeKey IS NULL THEN 1 ELSE 0 END) AS unparsed,
      SUM(CASE WHEN placeKey = ''    THEN 1 ELSE 0 END) AS noPlace
    FROM declarations WHERE status = 'active'
  `).get();
  return { places: row, declarations: decl, job: geoJob };
}

/** Проставляет placeKey всем декларациям без него. Возвращает итог прохода. */
function runParsePass() {
  return new Promise((resolve, reject) => {
    const worker = new Worker(PARSE_WORKER);
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('geo-parse worker timeout (> 30 мин)'));
    }, 30 * 60 * 1000);

    worker.on('message', msg => {
      if (msg.progress) {
        Object.assign(geoJob, { parsed: msg.progress.parsed, places: msg.progress.places });
        return;
      }
      clearTimeout(timer);
      worker.terminate();
      if (msg.error) return reject(new Error(msg.error));
      resolve(msg.done);
    });
    worker.once('error', err => { clearTimeout(timer); worker.terminate(); reject(err); });
  });
}

/**
 * Геокодирует НП из очереди. Если НП не нашёлся, пробуем район — маркер в
 * районном центре полезнее отсутствующего маркера; регион целиком не берём:
 * точка в центре области выглядела бы как настоящий адрес производителя.
 */
async function runGeocodePass({ maxCalls = DAILY_LIMIT, delayMs = DELAY_MS } = {}) {
  const queue = pendingStmt.all(maxCalls);
  if (!queue.length) return { geocoded: 0, failed: 0, apiCalls: 0 };

  let geocoded = 0, failed = 0, apiCalls = 0;
  for (const place of queue) {
    if (apiCalls >= maxCalls) break;
    try {
      // 1) поиск строго по уровню НП — самый точный;
      // 2) свободный поиск: часть сел в справочнике DaData подписана иначе;
      // 3) район — маркер в райцентре лучше отсутствующего маркера.
      apiCalls++;
      geoJob.apiCalls = apiCalls;
      let hit = await geocode(place.query, { from: 'city', to: 'settlement' });
      let accuracy = hit && hit.accuracy;

      if (!hit) {
        await new Promise(r => setTimeout(r, delayMs));
        apiCalls++;
        geoJob.apiCalls = apiCalls;
        hit = await geocode(place.query);
        accuracy = hit && hit.accuracy;
      }

      if (!hit && place.district) {
        await new Promise(r => setTimeout(r, delayMs));
        apiCalls++;
        geoJob.apiCalls = apiCalls;
        hit = await geocode(`${place.region}, ${place.district} р-н`);
        accuracy = hit ? 'district' : null;
      }

      if (hit) {
        updateOkStmt.run(hit.lat, hit.lon, accuracy, place.key);
        geocoded++;
        geoJob.geocoded = geocoded;
      } else {
        updateFailStmt.run(MAX_ATTEMPTS, place.key);
        failed++;
        geoJob.failed = failed;
      }
    } catch (e) {
      if (e instanceof RateLimitError) {
        logger.warn('[GEO] Лимит DaData исчерпан, останавливаюсь: %s', e.message);
        geoJob.lastError = e.message;
        break;
      }
      logger.warn('[GEO] %s — %s', place.query, e.message);
      updateFailStmt.run(MAX_ATTEMPTS, place.key);
      failed++;
    }
    await new Promise(r => setTimeout(r, delayMs));
  }
  return { geocoded, failed, apiCalls };
}

/** Полный цикл: разбор адресов + геокодирование очереди. */
async function runGeoJob({ maxCalls = DAILY_LIMIT, delayMs = DELAY_MS } = {}) {
  if (geoJob.running) {
    logger.info('[GEO] Пропуск: задание уже выполняется');
    return null;
  }
  Object.assign(geoJob, {
    running: true, phase: 'parse', parsed: 0, places: 0, geocoded: 0, failed: 0,
    apiCalls: 0, pending: null, startedAt: new Date().toISOString(), finishedAt: null, lastError: null,
  });
  try {
    const parse = await runParsePass();
    Object.assign(geoJob, { parsed: parse.parsed, places: parse.places, pending: parse.pending, phase: 'geocode' });
    logger.info(`[GEO] Разбор адресов: +${parse.parsed} деклараций, +${parse.places} НП, без НП ${parse.skipped}, в очереди ${parse.pending}`);

    const geo = await runGeocodePass({ maxCalls, delayMs });
    logger.info(`[GEO] Геокодирование: +${geo.geocoded} НП, не найдено ${geo.failed}, запросов ${geo.apiCalls}`);
    return { parse, geo };
  } catch (e) {
    geoJob.lastError = e.message;
    logger.error('[GEO] Ошибка: %s', e.message);
    throw e;
  } finally {
    Object.assign(geoJob, { running: false, phase: null, finishedAt: new Date().toISOString() });
  }
}

module.exports = { runGeoJob, runParsePass, runGeocodePass, stats, geoJob, DAILY_LIMIT, DELAY_MS };
