/**
 * Разовая загрузка истории из открытых данных РДС (fsa.gov.ru/opendata).
 * Запуск: node scripts/backfill-opendata.js [--limit N]
 *   --limit N — обработать не более N новых архивов (для теста перед полным прогоном)
 */
const fsaConfig = require('../config/fsaConfig');
const { runOpendataImport } = require('../services/opendataService');

(async () => {
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg !== -1 ? Number(process.argv[limitArg + 1]) : undefined;

  const result = await runOpendataImport(fsaConfig, { limit });
  console.log('Готово:', result);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
