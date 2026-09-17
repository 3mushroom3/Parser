/**
 * Проставляет declarations.placeKey и наполняет справочник geo_places.
 *
 * Отдельный поток, потому что проход по всему реестру (600 тыс.+ строк) — это
 * десятки секунд CPU на разбор адресов плюс столько же UPDATE'ов: на основном
 * потоке это тот же симптом, что был у обогащения ИНН — event loop встаёт и
 * HTTP-запросы отваливаются по таймауту.
 *
 * Адреса, из которых НП не вытащить (иностранные производители, «в границах
 * земель сельхозназначения»), получают placeKey = '' — чтобы следующий проход
 * не разбирал их заново.
 */
const { parentPort } = require('worker_threads');
const db = require('../services/db');
const { parseAddress, norm } = require('../services/addressPlace');
const CITY_SEED = require('../services/cityCoordsSeed');

// Сид ищем по нормализованному названию: в адресах попадается и
// «РОСТОВ-НА-ДОНУ», и «Ростов-на-Дону».
const SEED_BY_NAME = new Map(Object.entries(CITY_SEED).map(([name, coords]) => [norm(name), coords]));

const BATCH = 2000;

const selectStmt = db.prepare(`
  SELECT id, address FROM declarations
  WHERE placeKey IS NULL AND address IS NOT NULL AND address != ''
  LIMIT ?
`);
const updateStmt = db.prepare('UPDATE declarations SET placeKey = ? WHERE id = ?');
// Найденный НП добавляем в справочник; уже известные (в т.ч. с координатами)
// не трогаем — status/lat/lon там ведёт задание геокодирования.
const insertPlaceStmt = db.prepare(`
  INSERT INTO geo_places (key, region, district, type, name, label, query, accuracy, lat, lon, status, source)
  VALUES (@key, @region, @district, @type, @name, @label, @query, @accuracy, @lat, @lon, @status, @source)
  ON CONFLICT(key) DO NOTHING
`);

// Крупные города берём из сида — это сотни запросов к DaData, которых можно не делать.
function seeded(place) {
  if (place.type !== 'г') return null;
  const coords = SEED_BY_NAME.get(norm(place.name));
  return coords ? { lat: coords[0], lon: coords[1] } : null;
}

const processBatch = db.transaction(rows => {
  let parsed = 0, skipped = 0, places = 0;
  for (const row of rows) {
    const place = parseAddress(row.address);
    if (!place) {
      updateStmt.run('', row.id);
      skipped++;
      continue;
    }
    updateStmt.run(place.key, row.id);
    parsed++;
    const hit = seeded(place);
    const info = insertPlaceStmt.run({
      key: place.key,
      region: place.region,
      district: place.district || null,
      type: place.type,
      name: place.name,
      label: place.label,
      query: place.query,
      accuracy: hit ? 'settlement' : null,
      lat: hit ? hit.lat : null,
      lon: hit ? hit.lon : null,
      status: hit ? 'ok' : 'pending',
      source: hit ? 'seed' : null,
    });
    if (info.changes) places++;
  }
  return { parsed, skipped, places };
});

try {
  let parsed = 0, skipped = 0, places = 0;
  for (;;) {
    const rows = selectStmt.all(BATCH);
    if (!rows.length) break;
    const res = processBatch(rows);
    parsed += res.parsed;
    skipped += res.skipped;
    places += res.places;
    parentPort.postMessage({ progress: { parsed, skipped, places } });
  }

  // Число деклараций на НП — по нему задание геокодирования выбирает, что
  // геокодировать первым: сперва самые «населённые» точки карты.
  db.prepare(`
    UPDATE geo_places SET declCount = COALESCE((
      SELECT COUNT(*) FROM declarations d WHERE d.placeKey = geo_places.key AND d.status = 'active'
    ), 0)
  `).run();

  const pending = db.prepare("SELECT COUNT(*) c FROM geo_places WHERE status = 'pending'").get().c;
  parentPort.postMessage({ done: { parsed, skipped, places, pending } });
} catch (err) {
  parentPort.postMessage({ error: err.message });
}
