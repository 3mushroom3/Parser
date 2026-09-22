/**
 * Разовое дозаполнение companies.ceoName/email из ЕГРЮЛ (dadata) для компаний,
 * которые уже классифицированы (farmerType != unknown) и поэтому не попадают
 * в обычный проход enrichExisting() — тот берёт только записи без farmerType.
 *
 * Запуск: node scripts/backfill-egrul.js [--limit N]
 *   --limit N — не больше N запросов к dadata (по умолчанию без лимита —
 *               использовать осторожно, токен общий с ОКВЭД/гео-обогащением)
 */
const db = require('../services/db');
const { lookupInn } = require('../services/fnsClient');

const DELAY_MS = parseInt(process.env.ENRICH_DELAY_MS || '1500', 10);

async function main() {
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg !== -1 ? Number(process.argv[limitArg + 1]) : Infinity;

  const rows = db.prepare(`
    SELECT DISTINCT d.inn AS inn
    FROM declarations d
    LEFT JOIN companies c ON c.id = d.inn
    WHERE d.inn IS NOT NULL AND d.inn != ''
      AND (c.ceoName IS NULL OR c.ceoName = '')
  `).all();

  console.log(`К дозаполнению: ${rows.length} компаний (лимит запросов: ${limit === Infinity ? 'без лимита' : limit})`);

  const upsert = db.prepare(`
    INSERT INTO companies (id, inn, ceoName, email, regDate, egrulStatus, egrulAddress, ogrn)
    VALUES (@inn, @inn, @ceoName, @email, @regDate, @egrulStatus, @egrulAddress, @ogrn)
    ON CONFLICT(id) DO UPDATE SET
      ceoName = COALESCE(NULLIF(excluded.ceoName, ''), companies.ceoName),
      email = COALESCE(NULLIF(excluded.email, ''), companies.email),
      regDate = COALESCE(NULLIF(excluded.regDate, ''), companies.regDate),
      egrulStatus = COALESCE(NULLIF(excluded.egrulStatus, ''), companies.egrulStatus),
      egrulAddress = COALESCE(NULLIF(excluded.egrulAddress, ''), companies.egrulAddress),
      ogrn = COALESCE(NULLIF(excluded.ogrn, ''), companies.ogrn),
      updatedAt = CURRENT_TIMESTAMP
  `);

  let done = 0, found = 0, calls = 0;
  for (const { inn } of rows) {
    if (calls >= limit) { console.log('Достигнут --limit, останавливаюсь'); break; }
    try {
      calls++;
      const data = await lookupInn(inn);
      if (data && (data.director || data.egrulEmail || data.egrulStatus)) {
        upsert.run({
          inn, ceoName: data.director || '', email: data.egrulEmail || '', regDate: data.regDate || '',
          egrulStatus: data.egrulStatus || '', egrulAddress: data.egrulAddress || '', ogrn: data.ogrn || '',
        });
        found++;
      }
    } catch (e) {
      console.warn(`[EGRUL] ${inn}: ${e.message}`);
    }
    done++;
    if (done % 100 === 0) console.log(`  ...${done}/${rows.length}, найдено директоров/e-mail: ${found}`);
    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  console.log(`Готово. Обработано: ${done}, дозаполнено: ${found}.`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
