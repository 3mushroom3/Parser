/**
 * Дозагрузка телефонов из карточек деклараций FSA API.
 *
 * Зачем: в выгрузке открытых данных РДС 57 колонок и ни одной с контактами
 * (см. structure-*.csv на странице открытых данных), поэтому у всего, что
 * пришло оттуда — а это основная масса реестра, — телефона нет вовсе. Телефон
 * отдаёт только карточка декларации в живом API, и записи, загруженные
 * открытыми данными, её никогда не запрашивали. Выборочная проверка: контакты
 * есть примерно у половины деклараций 2025 года и у трёх из четырёх за 2026.
 *
 * Запрашиваем одну карточку на компанию, а найденный телефон проставляем всем
 * её действующим декларациям — это кратно сокращает число запросов к API,
 * который стоит за антифрод-WAF (см. CLAUDE.md).
 *
 * Запуск: node scripts/backfill-phones.js [--limit N] [--delay MS]
 *   --limit  сколько компаний обойти за прогон (по умолчанию 500)
 *   --delay  пауза между карточками, мс (по умолчанию FSA_DETAIL_DELAY_MS или 400)
 */
require('dotenv').config();
const cfg = require('../config/fsaConfig');
const db = require('../services/db');
const parser = require('../services/parser');
const { createFsaApiClient } = require('../services/apiClient');

// Опрошенные компании помечаем, иначе те, у кого контактов в реестре нет,
// запрашивались бы на каждом прогоне заново.
db.exec(`
  CREATE TABLE IF NOT EXISTS phone_backfill (
    companyKey TEXT PRIMARY KEY,
    fsaId TEXT,
    found INTEGER DEFAULT 0,
    attemptedAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

const argNum = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt;
};

const selectCompanies = db.prepare(`
  SELECT COALESCE(NULLIF(d.inn, ''), d.shortName) AS companyKey,
         MAX(d.fsaId) AS fsaId,
         COUNT(*) AS declCount
  FROM declarations d
  WHERE d.status = 'active'
    AND (d.phone IS NULL OR d.phone = '')
    AND d.fsaId IS NOT NULL AND d.fsaId != ''
    AND COALESCE(NULLIF(d.inn, ''), d.shortName) IS NOT NULL
    AND COALESCE(NULLIF(d.inn, ''), d.shortName) != ''
    AND NOT EXISTS (SELECT 1 FROM phone_backfill p WHERE p.companyKey = COALESCE(NULLIF(d.inn, ''), d.shortName))
  GROUP BY companyKey
  ORDER BY declCount DESC
  LIMIT ?
`);

const updatePhone = db.prepare(`
  UPDATE declarations SET phone = ?
  WHERE status = 'active' AND (phone IS NULL OR phone = '')
    AND COALESCE(NULLIF(inn, ''), shortName) = ?
`);

const markDone = db.prepare(`
  INSERT INTO phone_backfill (companyKey, fsaId, found) VALUES (?, ?, ?)
  ON CONFLICT(companyKey) DO UPDATE SET fsaId = excluded.fsaId, found = excluded.found,
    attemptedAt = CURRENT_TIMESTAMP
`);

async function main() {
  const limit = argNum('--limit', 500);
  const delay = argNum('--delay', Number(process.env.FSA_DETAIL_DELAY_MS) || 400);

  const left = db.prepare(`
    SELECT COUNT(*) c FROM (
      SELECT COALESCE(NULLIF(inn, ''), shortName) AS k FROM declarations
      WHERE status = 'active' AND (phone IS NULL OR phone = '') AND fsaId IS NOT NULL AND fsaId != ''
      GROUP BY k
    ) WHERE k IS NOT NULL AND k != ''
  `).get().c;
  const done = db.prepare('SELECT COUNT(*) c FROM phone_backfill').get().c;
  console.log(`Компаний без телефона: ${left} (уже опрошено ранее: ${done})`);

  const companies = selectCompanies.all(limit);
  if (!companies.length) {
    console.log('Все компании уже опрошены.');
    return;
  }
  console.log(`К обходу за этот прогон: ${companies.length}, пауза ${delay} мс`);

  const api = createFsaApiClient(cfg);
  let found = 0, empty = 0, failed = 0, declsUpdated = 0, errorStreak = 0;

  for (let i = 0; i < companies.length; i++) {
    const c = companies[i];
    try {
      const detail = await api.getDeclarationById(c.fsaId);
      const mapped = parser.mapToGetDeclarationData(detail);
      const phone = (mapped && mapped.manufacturer && mapped.manufacturer.phone) || '';
      if (phone) {
        const res = updatePhone.run(phone, c.companyKey);
        declsUpdated += res.changes;
        found++;
      } else {
        empty++;
      }
      markDone.run(c.companyKey, String(c.fsaId), phone ? 1 : 0);
      errorStreak = 0;
    } catch (err) {
      failed++;
      errorStreak++;
      // Подряд идущие ошибки означают бан или падение API — продолжать
      // бессмысленно и вредно: WAF реагирует именно на всплески.
      if (errorStreak >= 10) {
        console.log(`Прервано: 10 ошибок подряд, последняя — ${err.message}`);
        break;
      }
    }
    if ((i + 1) % 50 === 0) {
      console.log(`  ...${i + 1}/${companies.length}: телефон найден у ${found}, без контактов ${empty}, ошибок ${failed}`);
    }
    if (delay) await new Promise(r => setTimeout(r, delay));
  }

  console.log(`Готово. Опрошено компаний: ${found + empty + failed}, ` +
    `с телефоном: ${found}, без контактов в реестре: ${empty}, ошибок: ${failed}. ` +
    `Проставлено деклараций: ${declsUpdated}.`);
}

main().catch(err => {
  console.error('Ошибка:', err.message);
  process.exit(1);
});
