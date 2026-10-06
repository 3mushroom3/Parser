/**
 * Догрузка диапазона дат через живой API ФСА — для месяцев, которых нет
 * в открытых данных (ФСА выложила не все архивы: например, за март 2026
 * архива нет, между data-20260228 и data-20260430 пусто).
 *
 * Запуск: node scripts/backfill-live-range.js 2026-03-01 2026-03-31 [--chunk week|day|N]
 *
 * Тот же парсер, что у ночного задания (services/parserService.js), только
 * на заданном диапазоне. Чекпоинт status.lastCompletedDate общий с основным
 * парсером, поэтому сохраняем его до прогона и возвращаем после — иначе
 * основной парсер начал бы со «второй половины марта».
 */
require('dotenv').config();

const [from, to] = process.argv.slice(2, 4);
if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) {
  console.error('Укажите диапазон: node scripts/backfill-live-range.js 2026-03-01 2026-03-31');
  process.exit(1);
}
const chunkIdx = process.argv.indexOf('--chunk');
process.env.NODE_ENV = 'test'; // server.js не поднимает HTTP и cron
process.env.FSA_DATE_FROM = from;
process.env.FSA_DATE_TO = to;
process.env.FSA_DATE_CHUNK = chunkIdx !== -1 ? process.argv[chunkIdx + 1] : 'week';
process.env.FSA_FORCE_RESCAN = 'true';

const db = require('../services/db');
const { safeRunParser } = require('../server');

const count = () => db.prepare('SELECT COUNT(*) n FROM declarations WHERE regDate BETWEEN ? AND ?').get(from, to).n;

(async () => {
  const saved = db.prepare('SELECT lastCompletedDate FROM status WHERE id = 1').get();
  const before = count();
  console.log(`Деклараций за ${from}…${to} до прогона: ${before}. Чекпоинт основного парсера: ${saved?.lastCompletedDate || '—'}`);
  try {
    await safeRunParser();
  } finally {
    db.prepare('UPDATE status SET lastCompletedDate = ? WHERE id = 1').run(saved?.lastCompletedDate || null);
  }
  console.log(`Готово. Деклараций за период: ${before} → ${count()}. Чекпоинт возвращён.`);
  console.log('Дальше в фоне идёт обогащение ОКВЭД новых записей — процесс завершится сам.');
})().catch(e => { console.error('Ошибка:', e.message); process.exit(1); });
