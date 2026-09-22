/**
 * Разовый бэкафилл: заполняет declarations.batchTons (число в тоннах) из
 * batchSize (свободная строка вида «280 т», «2 110 тонн», «500 000 кг») для
 * деклараций, загруженных до появления фильтра по объёму партии.
 *
 * Запуск: node scripts/backfill-batch-tons.js [--batch N] [--all]
 *
 * --all — пересчитать и уже заполненные значения. Нужен после правок самого
 * разбора: обычный прогон берёт только строки с batchTons IS NULL и посчитанные
 * по старым правилам не тронет.
 */
const db = require('../services/db');
const { parseBatchTons } = require('../services/batchSize');

function main() {
  const batchArgIdx = process.argv.indexOf('--batch');
  const batchSize = batchArgIdx !== -1 ? Number(process.argv[batchArgIdx + 1]) : 20000;

  const all = process.argv.includes('--all');
  if (all) {
    // Сбрасываем прежние значения, иначе выборка «batchTons IS NULL» их не увидит.
    const reset = db.prepare("UPDATE declarations SET batchTons = NULL WHERE batchSize IS NOT NULL AND batchSize != ''").run();
    console.log(`Режим --all: сброшено прежних значений — ${reset.changes}`);
  }

  const total = db.prepare("SELECT COUNT(*) c FROM declarations WHERE batchTons IS NULL AND batchSize IS NOT NULL AND batchSize != ''").get().c;
  console.log(`К пересчёту: ${total} деклараций`);

  // Не распознанные значения помечаем -1, а не оставляем NULL — иначе тот же
  // LIMIT-запрос будет возвращать их на каждой итерации бесконечно.
  const selectStmt = db.prepare(`
    SELECT id, batchSize FROM declarations
    WHERE batchTons IS NULL AND batchSize IS NOT NULL AND batchSize != ''
    LIMIT ?
  `);
  const updateStmt = db.prepare('UPDATE declarations SET batchTons = ? WHERE id = ?');
  let unresolved = 0;
  const applyBatch = db.transaction((rows) => {
    for (const row of rows) {
      const tons = parseBatchTons(row.batchSize);
      if (tons === null) unresolved++;
      updateStmt.run(tons === null ? -1 : tons, row.id);
    }
  });

  let processed = 0;
  while (true) {
    const rows = selectStmt.all(batchSize);
    if (!rows.length) break;
    applyBatch(rows);
    processed += rows.length;
    console.log(`  ...обработано ${processed}/${total}`);
  }

  db.prepare('UPDATE declarations SET batchTons = NULL WHERE batchTons = -1').run();
  console.log(`Готово. Обработано: ${processed}. Не распознано (оставлено NULL): ${unresolved}.`);
}

main();
