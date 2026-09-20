/**
 * Разовая переочистка уже сохранённых адресов в user_contacts.
 *
 * До фикса в sheetAnalyzer.js (parseRow) cleanAddress() запускался только для
 * «смешанных» колонок (несколько типов сразу на одну колонку). Если колонка
 * файла была размечена только как «Адрес», но по факту содержала прилипший
 * телефон/подпись («346271, х. Зубковский, Северная, 12 моб.…8-928-771-4561»),
 * очистка не запускалась вообще и мусор так и оставался в address — уже
 * загруженные через «Мои базы» файлы успели сохранить такие адреса в БД.
 * Код теперь чинит будущие импорты; этот скрипт переочищает то, что уже есть.
 *
 * Запуск: node scripts/reclean-contact-addresses.js [--dry-run]
 *   --dry-run — только посчитать и показать примеры, БД не трогать
 */
const db = require('../services/db');
const { cleanAddress } = require('../services/sheetAnalyzer');

function main() {
  const dryRun = process.argv.includes('--dry-run');

  const rows = db.prepare("SELECT id, address FROM user_contacts WHERE address IS NOT NULL AND address != ''").all();
  const update = db.prepare('UPDATE user_contacts SET address = ? WHERE id = ?');

  let changed = 0;
  const samples = [];
  const apply = db.transaction((items) => {
    for (const { id, cleaned } of items) update.run(cleaned, id);
  });
  const toUpdate = [];

  for (const row of rows) {
    const cleaned = cleanAddress(row.address) || row.address;
    if (cleaned !== row.address) {
      changed++;
      if (samples.length < 15) samples.push({ before: row.address, after: cleaned });
      toUpdate.push({ id: row.id, cleaned });
    }
  }

  console.log(`Всего адресов: ${rows.length}`);
  console.log(`Требуют переочистки: ${changed}`);
  console.log('\nПримеры:');
  for (const s of samples) {
    console.log(`  БЫЛО:  ${s.before}`);
    console.log(`  СТАЛО: ${s.after}\n`);
  }

  if (dryRun) {
    console.log('--dry-run: изменения не сохранены.');
    return;
  }

  apply(toUpdate);
  console.log(`Готово. Обновлено записей: ${toUpdate.length}.`);
}

main();
