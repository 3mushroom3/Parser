/**
 * Агрегаты для карты: сколько деклараций в каждом населённом пункте.
 *
 * Раньше воркер сам разбирал адреса регуляркой «г. Название» и складывал в
 * память ещё и список компаний с декларациями по каждому городу. Из-за этого
 * на карту попадало 15% реестра, а ответ раздувался. Теперь НП размечены в
 * declarations.placeKey (workers/geoParseWorker.js), координаты лежат в
 * geo_places, и здесь остаётся один GROUP BY по индексу — памяти почти не
 * требуется. Список компаний отдаётся отдельным запросом при клике по маркеру
 * (GET /api/declarations/map-place).
 */
const { parentPort } = require('worker_threads');
const db = require('../services/db');

try {
  const places = db.prepare(`
    SELECT
      g.id       AS id,
      g.label    AS label,
      g.lat      AS lat,
      g.lon      AS lon,
      COUNT(*)   AS count,
      SUM(CASE WHEN d.farmerType IN ('farmer', 'farmer_trader') THEN 1 ELSE 0 END) AS farmers,
      SUM(CASE WHEN d.farmerType IN ('trader', 'trader_farmer') THEN 1 ELSE 0 END) AS traders
    FROM declarations d
    JOIN geo_places g ON g.key = d.placeKey
    WHERE d.status = 'active' AND d.placeKey IS NOT NULL AND d.placeKey != ''
      AND g.lat IS NOT NULL
    GROUP BY d.placeKey
    ORDER BY count DESC
  `).all();

  const totals = db.prepare(`
    SELECT
      COUNT(*) AS totalActive,
      SUM(CASE WHEN placeKey IS NULL THEN 1 ELSE 0 END) AS unparsed,
      SUM(CASE WHEN placeKey = ''    THEN 1 ELSE 0 END) AS noPlace
    FROM declarations WHERE status = 'active'
  `).get();

  // Считаем только НП, которые реально ждут места на карте: в справочнике
  // есть и точки от недействующих деклараций, и показывать их в счётчике
  // «осталось определить» — врать пользователю.
  const queue = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END) AS failed
    FROM geo_places WHERE declCount > 0
  `).get();

  const mapped = places.reduce((sum, p) => sum + p.count, 0);

  parentPort.postMessage({
    places: places.map(p => ({
      id: p.id,
      label: p.label,
      // до 5 знаков (~1 м) — дальше только раздувать ответ
      lat: Math.round(p.lat * 1e5) / 1e5,
      lon: Math.round(p.lon * 1e5) / 1e5,
      count: p.count,
      farmers: p.farmers,
      traders: p.traders,
    })),
    mapped,
    totalActive: totals.totalActive || 0,
    // «не на карте»: адрес без НП, ещё не разобранные и НП без координат
    unplaced: (totals.totalActive || 0) - mapped,
    noPlace: totals.noPlace || 0,
    unparsed: totals.unparsed || 0,
    placesPending: queue.pending || 0,
    placesFailed: queue.failed || 0,
  });
} catch (err) {
  parentPort.postMessage({ error: err.message });
}
