/**
 * Применяет классификацию по названию компании ко всем записям с farmerType='unknown'.
 * Также очищает кэш от записей с пустым ОКВЭД (они были от 429 rate-limit).
 * Запуск: node scripts/apply-name-classify.js
 */
const fs = require('fs');
const path = require('path');
const { classifyByName } = require('../services/fnsClient');

const DB_FILE = path.join(__dirname, '../../data/declarations.json');
const CACHE_FILE = path.join(__dirname, '../../data/inn_cache.json');

// Очищаем кэш от пустых ОКВЭД (были от 429)
console.log('Очищаем кэш от записей без ОКВЭД...');
let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (_) {}
const before = Object.keys(cache).length;
// Удаляем только те, где нет ОКВЭД И farmerType='unknown' (это 429-кэши)
// Оставляем записи с farmerType != unknown (они правильно классифицированы)
const cleaned = {};
for (const [k, v] of Object.entries(cache)) {
  if (v.farmerType !== 'unknown' || v.okved) {
    cleaned[k] = v;
  }
}
fs.writeFileSync(CACHE_FILE, JSON.stringify(cleaned, null, 2));
console.log(`Кэш: было ${before}, стало ${Object.keys(cleaned).length} (удалено ${before - Object.keys(cleaned).length})`);

// Применяем name-классификацию к БД
console.log('\nЗагружаем БД...');
const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const records = Array.isArray(db) ? db : (db.records || []);
console.log(`Записей: ${records.length}`);

let updated = 0, alreadyKnown = 0, stillUnknown = 0;
for (const rec of records) {
  if (rec.farmerType && rec.farmerType !== 'unknown') {
    alreadyKnown++;
    continue;
  }
  // Пробуем все доступные поля — берём первое ненулевое совпадение
  const nameFields = [rec.shortName, rec.applicantName, rec.lastName].filter(Boolean);
  let ft = 'unknown';
  for (const name of nameFields) {
    ft = classifyByName(name);
    if (ft !== 'unknown') break;
  }
  if (ft !== 'unknown') {
    rec.farmerType = ft;
    updated++;
  } else {
    stillUnknown++;
  }
}

console.log(`Уже классифицировано: ${alreadyKnown}`);
console.log(`Обновлено по имени: ${updated}`);
console.log(`Остаётся unknown: ${stillUnknown}`);

if (!Array.isArray(db)) db.records = records;
fs.writeFileSync(DB_FILE, JSON.stringify(db));
console.log('\nБД сохранена.');
