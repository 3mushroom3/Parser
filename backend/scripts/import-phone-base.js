/**
 * Заливка телефонов ИП и КФХ из покупных региональных баз (Excel).
 * Вся логика — в services/phoneBaseImport.js.
 *
 * Запуск: node scripts/import-phone-base.js <файл или папка>... [--dry] [--sample N]
 *   --dry       только сверить и показать цифры, в базу ничего не писать
 *   --sample N  показать N случайных пар «реестр ↔ база» для проверки глазами
 *   --reapply   без файлов: проставить уже залитые телефоны новым декларациям
 *   --rollback  без файлов: убрать залитые телефоны и очистить phone_imports
 *
 * Архивы распаковать заранее. Листы незнакомого формата пропускаются со
 * списком в конце. Повторный запуск безопасен: телефон по ИНН перезаписывается
 * в phone_imports, а в декларациях заполняются только пустые поля.
 */
require('dotenv').config();
const { loadBase, matchBase, saveMatches, applyImportedPhones, rollbackImportedPhones } = require('../services/phoneBaseImport');

const args = process.argv.slice(2);
const has = name => args.includes(name);
const sampleIdx = args.indexOf('--sample');
const sampleSize = sampleIdx !== -1 ? Number(args[sampleIdx + 1]) || 20 : 0;
const paths = args.filter((a, i) => !a.startsWith('--') && !(sampleIdx !== -1 && i === sampleIdx + 1));

function main() {
  if (has('--rollback')) {
    const { cleared, removed } = rollbackImportedPhones();
    console.log(`Откат: очищено деклараций ${cleared}, удалено записей phone_imports ${removed}.`);
    return;
  }
  if (has('--reapply')) {
    console.log(`Проставлено деклараций: ${applyImportedPhones()}.`);
    return;
  }
  if (!paths.length) {
    console.log('Использование: node scripts/import-phone-base.js <файл или папка>... [--dry] [--sample N]');
    process.exit(1);
  }

  const { entries, files, skipped } = loadBase(paths);
  console.log(`Файлов: ${files.length}, строк: ${files.reduce((s, f) => s + f.rows, 0)}, ` +
    `пригодных к сверке (ФИО + регион + телефон): ${entries.length}`);
  const noRegion = files.filter(f => !f.region);
  if (noRegion.length) console.log('Регион не определён по имени файла: ' + noRegion.map(f => f.file).join('; '));

  const { matches, ambiguous, perRegion, individualsActive } = matchBase(entries);
  const byDistrict = matches.filter(m => m.matchedBy === 'district');
  const sum = (list, f) => list.reduce((s, m) => s + m[f], 0);
  console.log(`\nИП и КФХ с действующими декларациями в реестре: ${individualsActive}`);
  console.log(`Найдено в базе: ${matches.length} ` +
    `(ФИО + регион + район: ${byDistrict.length}, без района при отсутствии тёзок: ${matches.length - byDistrict.length}); ` +
    `неоднозначных, пропущено: ${ambiguous}`);
  console.log(`С мобильным: ${matches.filter(m => m.phone.startsWith('+79')).length}. ` +
    `Действующих деклараций у найденных: ${sum(matches, 'active')}, из них без телефона: ${sum(matches, 'activeNoPhone')}`);

  console.log('\nПо регионам (найдено / ИП с действующими декларациями):');
  for (const [region, s] of [...perRegion].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${region}: ${s.matched}/${s.total} (${Math.round(100 * s.matched / s.total)}%)`);
  }

  if (sampleSize) {
    console.log(`\nСлучайные ${sampleSize} пар для проверки:`);
    const pool = [...matches];
    for (let i = 0; i < sampleSize && pool.length; i++) {
      const m = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
      console.log(`  [${m.matchedBy}] ${m.fio} | ${m.address || ''}\n      ↔ ${m.sourceName} | ${m.baseDistrict} | ${m.phone} | ${m.sourceFile}`);
    }
  }
  if (skipped.length) console.log('\nПропущены листы незнакомого формата: ' + skipped.join('; '));

  if (has('--dry')) {
    console.log('\n--dry: в базу ничего не записано.');
    return;
  }
  saveMatches(matches);
  console.log(`\nЗаписано в phone_imports: ${matches.length}. Проставлено деклараций: ${applyImportedPhones()}.`);
}

main();
