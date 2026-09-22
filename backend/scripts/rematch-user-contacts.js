/**
 * Пересверка уже загруженных пользовательских баз с реестром.
 *
 * Отметка «есть в реестре» проставляется один раз при импорте, поэтому после
 * правок сверки (services/sheetAnalyzer.js → findInRegistry) старые загрузки
 * остаются со старыми цифрами. Скрипт прогоняет их заново, не требуя от
 * пользователя перезаливать файл.
 *
 * Запуск: node scripts/rematch-user-contacts.js [--upload N] [--dry]
 */
const db = require('../services/db');
const { findInRegistry } = require('../services/sheetAnalyzer');

function main() {
  const uploadArg = process.argv.indexOf('--upload');
  const onlyUpload = uploadArg !== -1 ? Number(process.argv[uploadArg + 1]) : null;
  const dry = process.argv.includes('--dry');

  const uploads = onlyUpload
    ? db.prepare('SELECT id, userId, originalName FROM user_uploads WHERE id = ?').all(onlyUpload)
    : db.prepare("SELECT id, userId, originalName FROM user_uploads WHERE status = 'processed' ORDER BY id").all();

  if (!uploads.length) {
    console.log('Обработанных загрузок не найдено');
    return;
  }
  console.log(`Загрузок к пересверке: ${uploads.length}${dry ? ' (пробный прогон, без записи)' : ''}`);

  const rowsStmt = db.prepare('SELECT id, inn, companyName, address, isPrivate FROM user_contacts WHERE uploadId = ?');
  const updStmt = db.prepare('UPDATE user_contacts SET isPrivate = ? WHERE id = ?');
  const uploadStmt = db.prepare('UPDATE user_uploads SET matchedRows = ?, privateRows = ? WHERE id = ?');

  for (const up of uploads) {
    const rows = rowsStmt.all(up.id);
    if (!rows.length) continue;

    const records = rows.map(r => ({ inn: r.inn || '', name: r.companyName || '', address: r.address || '' }));
    const isKnown = findInRegistry(db, records);

    let matched = 0, priv = 0, changed = 0;
    const apply = db.transaction(() => {
      rows.forEach((row, i) => {
        const nowPrivate = isKnown(records[i]) ? 0 : 1;
        if (nowPrivate !== row.isPrivate) {
          changed++;
          if (!dry) updStmt.run(nowPrivate, row.id);
        }
        nowPrivate ? priv++ : matched++;
      });
      if (!dry) uploadStmt.run(matched, priv, up.id);
    });
    apply();

    console.log(`  #${up.id} «${(up.originalName || '').slice(0, 40)}»: строк ${rows.length}, ` +
      `совпало ${matched}, только у пользователя ${priv}, изменилось ${changed}`);
  }
  console.log('Готово.');
}

main();
