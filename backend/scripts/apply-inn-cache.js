/**
 * Проставляет декларациям тип производителя/ОКВЭД из data/inn_cache.json — без запросов к DaData.
 * Ночное обогащение делает это само перед каждым прогоном; скрипт — для разового догона.
 * Запуск: node scripts/apply-inn-cache.js
 */
require('dotenv').config();
const db = require('../services/db');
const { applyCacheToDb, selectPendingRecords } = require('../services/innEnricher');

const count = () => db.prepare(`
  SELECT COUNT(*) n, SUM(farmerType IS NOT NULL AND farmerType != 'unknown') typed
  FROM declarations WHERE status = 'active'
`).get();

const before = count();
const t = Date.now();
const updated = applyCacheToDb();
const after = count();
console.log(`Обновлено деклараций: ${updated} за ${((Date.now() - t) / 1000).toFixed(1)} с`);
console.log(`Действующие с типом: ${before.typed} → ${after.typed} из ${after.n}`);
console.log(`Компаний ещё не проверено в DaData: ${selectPendingRecords().length}`);
