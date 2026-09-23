/**
 * Разовый прогон дозагрузки телефонов. Вся логика — в
 * services/phoneBackfill.js, туда же ходит ночное задание из server.js.
 *
 * Запуск: node scripts/backfill-phones.js [--limit N] [--delay MS]
 *   --limit  сколько компаний обойти за прогон (по умолчанию 500)
 *   --delay  пауза между карточками, мс (по умолчанию FSA_DETAIL_DELAY_MS или 400)
 */
require('dotenv').config();
const { runPhoneBackfill, pendingCompanies } = require('../services/phoneBackfill');
const db = require('../services/db');

const argNum = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt;
};

async function main() {
  const limit = argNum('--limit', 500);
  const delay = argNum('--delay', Number(process.env.FSA_DETAIL_DELAY_MS) || 400);

  const left = pendingCompanies();
  const done = db.prepare('SELECT COUNT(*) c FROM phone_backfill').get().c;
  console.log(`Компаний без телефона: ${left} (уже опрошено ранее: ${done})`);
  console.log(`К обходу за этот прогон: до ${limit}, пауза ${delay} мс`);

  const res = await runPhoneBackfill({
    limit,
    delay,
    onProgress: ({ i, total, found, empty, failed }) =>
      console.log(`  ...${i}/${total}: телефон найден у ${found}, без контактов ${empty}, ошибок ${failed}`),
  });

  if (!res) { console.log('Дозагрузка уже выполняется.'); return; }
  console.log(`Готово. Опрошено компаний: ${res.checked}, с телефоном: ${res.found}, ` +
    `без контактов в реестре: ${res.empty}, ошибок: ${res.failed}. Проставлено деклараций: ${res.declsUpdated}.`);
}

main().catch(err => {
  console.error('Ошибка:', err.message);
  process.exit(1);
});
