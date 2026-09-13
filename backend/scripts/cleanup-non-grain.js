/**
 * Разовая очистка: opendata-бэкафилл тянул декларации ВСЕХ техрегламентов,
 * а не только зерно (ТР ТС 015/2011), потому что FSA_TECH_REGLAMENT не был
 * задан в .env — 87% таблицы (~4.3M из 4.9M строк) оказалось посторонними
 * категориями (косметика, текстиль, лифты, транспорт, электроника и т.д.)
 * или строками с непропарсенным полем technicalReglament (тоже не зерно —
 * проверено выборочно). Удаляет всё, что не зерно и не добавлено вручную.
 *
 * Запуск: node scripts/cleanup-non-grain.js [--dry-run] [--batch N]
 *   --dry-run — только посчитать, сколько строк попадёт под удаление, не трогая БД
 *   --batch N — размер пачки на одну транзакцию DELETE (по умолчанию 20000)
 *
 * Удаляет пачками (DELETE ... WHERE id IN (SELECT id ... LIMIT N)), а не
 * одним запросом — короткие транзакции меньше держат блокировку записи
 * (SQLite в journal_mode=delete блокирует читателей на время всей
 * транзакции), так что живой сайт не виснет на всё время очистки целиком.
 */
const db = require('../services/db');

const CONDITION = `
  (source IS NULL OR source != 'manual')
  AND (technicalReglament IS NULL OR technicalReglament = '' OR lower_u(technicalReglament) NOT LIKE '%зерна%')
`;

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const batchArgIdx = process.argv.indexOf('--batch');
  const batchSize = batchArgIdx !== -1 ? Number(process.argv[batchArgIdx + 1]) : 20000;

  const totalBefore = db.prepare('SELECT COUNT(*) c FROM declarations').get().c;
  const toDelete = db.prepare(`SELECT COUNT(*) c FROM declarations WHERE ${CONDITION}`).get().c;

  console.log(`Всего деклараций: ${totalBefore}`);
  console.log(`Под удаление (не зерно, не manual): ${toDelete}`);
  console.log(`Останется: ${totalBefore - toDelete}`);

  if (dryRun) {
    console.log('--dry-run: удаление не выполнялось.');
    return;
  }

  const del = db.prepare(`DELETE FROM declarations WHERE id IN (SELECT id FROM declarations WHERE ${CONDITION} LIMIT ?)`);

  let total = 0;
  let batches = 0;
  const t0 = Date.now();
  while (true) {
    const info = del.run(batchSize);
    total += info.changes;
    batches++;
    if (batches % 10 === 0 || info.changes < batchSize) {
      console.log(`  ...удалено ${total} (${batches} пачек, ${((Date.now() - t0) / 1000).toFixed(1)}с)`);
    }
    if (info.changes === 0) break;
  }

  const totalAfter = db.prepare('SELECT COUNT(*) c FROM declarations').get().c;
  console.log(`Готово. Удалено: ${total}. Осталось деклараций: ${totalAfter} (ожидалось ${totalBefore - toDelete}).`);
}

main();
