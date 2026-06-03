/** Запуск: node scripts/smoke-declaration.js [id] — без поднятия HTTP */
const { getDeclarationData } = require('../server');

(async () => {
  const id = process.argv[2] || '16827658';
  const data = await getDeclarationData(id, { strict: true });
  console.log(JSON.stringify(data, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
