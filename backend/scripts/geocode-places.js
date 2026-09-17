/**
 * Разовый прогон наполнения карты: разбор адресов по населённым пунктам
 * и геокодирование очереди.
 * Запуск: node scripts/geocode-places.js [--limit N] [--delay MS] [--parse-only]
 *   --limit N     — не больше N запросов к DaData (по умолчанию GEO_DAILY_LIMIT)
 *   --delay MS    — пауза между запросами (по умолчанию GEO_DELAY_MS)
 *   --parse-only  — только разметить адреса, к геокодеру не обращаться
 *
 * Нужен, когда очередь надо пройти быстрее, чем ночным заданием: на первом
 * запуске в очереди весь реестр, а суточный лимит DaData делится с обогащением
 * ОКВЭД. Прогресс печатается по ходу, прерывать можно — координаты уже
 * найденных НП сохранены в geo_places.
 */
require('dotenv').config();
const { runParsePass, runGeocodePass, stats, DAILY_LIMIT, DELAY_MS } = require('../services/geoEnricher');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  const value = Number(process.argv[i + 1]);
  return Number.isFinite(value) ? value : fallback;
}

(async () => {
  const maxCalls = arg('--limit', DAILY_LIMIT);
  const delayMs = arg('--delay', DELAY_MS);

  console.log('Разбираю адреса...');
  const parse = await runParsePass();
  console.log(`  деклараций размечено: ${parse.parsed}, без НП: ${parse.skipped}, новых НП: ${parse.places}`);
  console.log(`  в очереди на геокодирование: ${parse.pending}`);

  if (process.argv.includes('--parse-only')) {
    console.log(JSON.stringify(stats(), null, 2));
    process.exit(0);
  }

  console.log(`Геокодирую (лимит ${maxCalls} запросов, пауза ${delayMs} мс)...`);
  const geo = await runGeocodePass({ maxCalls, delayMs });
  console.log(`  найдено: ${geo.geocoded}, не найдено: ${geo.failed}, запросов: ${geo.apiCalls}`);

  const s = stats();
  console.log(`Итого НП: всего ${s.places.total}, с координатами ${s.places.ok}, в очереди ${s.places.pending}, не найдено ${s.places.failed}`);
  process.exit(0);
})().catch(e => { console.error('Ошибка:', e.message); process.exit(1); });
