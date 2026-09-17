/**
 * Админский импорт производителей из XLS/XLSX/CSV-файла.
 *
 * Структура файла определяется автоматически (services/sheetAnalyzer.js):
 * лист, строка шапки, колонки названия/ИНН/телефона/адреса/руководителя/
 * культур/площади — по заголовкам и содержимому. Поддерживаются «смешанные»
 * ячейки (адрес + директор + телефон в одной, как в образце «Луганская НР»)
 * и строки-продолжения (доп. культуры компании без названия и ИНН).
 */
const crypto = require('crypto');
const db = require('./db');
const {
  PRODUCER_TYPES, readWorkbook, analyzeWorkbook, buildRecords, findInRegistry, nameKey,
} = require('./sheetAnalyzer');

const TYPE_LABELS = {
  name: 'Название', inn: 'ИНН', phone: 'Телефон', phone2: 'Телефон 2', email: 'Email',
  address: 'Адрес', person: 'Руководитель', crops: 'Культуры', area: 'Площадь',
};

const formatArea = n => `${Number(n.toFixed(2)).toLocaleString('ru-RU')} га`;

function describeAreas(areas) {
  if (!areas.length) return '';
  if (areas.length === 1) return formatArea(areas[0].area);
  const total = areas.reduce((s, a) => s + a.area, 0);
  const parts = areas.map(a => (a.crops.length ? `${a.crops.join(', ')}: ` : '') + formatArea(a.area));
  return `${parts.join('; ')} (всего ${formatArea(total)})`;
}

// ── Основная функция импорта ──────────────────────────────────────────────
function importXlsx(buffer, options = {}) {
  const { skipExisting = false, fileName = '' } = options;

  const wb = readWorkbook(buffer, fileName);
  const analysis = analyzeWorkbook(wb, { types: PRODUCER_TYPES });
  if (!analysis) throw new Error('Файл пустой или не читается');

  const { sheetName, rows, layout, suggested } = analysis;
  if (suggested.name < 0 && suggested.inn < 0) {
    throw new Error('Не удалось найти колонку с названием или ИНН производителя. Проверьте, что в файле есть шапка «Наименование»/«ИНН».');
  }

  const detected = {};
  for (const [type, col] of Object.entries(suggested)) {
    if (col >= 0) detected[TYPE_LABELS[type] || type] = layout.labels[col] || `Колонка ${col + 1}`;
  }

  const { records, stats } = buildRecords(rows, layout, suggested);
  const companies = records.filter(r => r.name || r.inn);

  // ── Запись в БД ───────────────────────────────────────────────────────
  const result = {
    total: companies.length, inserted: 0, enriched: 0, skipped: 0, errors: [],
    sheetName, detected, mergedRows: stats.merged,
  };

  // Какие ИНН и названия уже есть в реестре — пачкой, без запроса на строку
  const inRegistry = findInRegistry(db, companies);

  const upsertCompany = db.prepare(`
    INSERT INTO companies (id, inn, name, phone, email, ceoName, notes, updatedAt)
    VALUES (@id, @inn, @name, @phone, @email, @ceoName, @notes, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      phone    = COALESCE(NULLIF(excluded.phone, ''), companies.phone),
      email    = COALESCE(NULLIF(excluded.email, ''), companies.email),
      ceoName  = COALESCE(NULLIF(excluded.ceoName, ''), companies.ceoName),
      notes    = COALESCE(NULLIF(companies.notes, ''), excluded.notes),
      updatedAt = CURRENT_TIMESTAMP
  `);

  const insertDecl = db.prepare(`
    INSERT OR IGNORE INTO declarations
      (id, source, status, shortName, inn, address, phone, productName, fetchedAt, updatedAt)
    VALUES (@id, 'xls_import', 'active', @shortName, @inn, @address, @phone,
            @productName, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);

  const doImport = db.transaction(() => {
    for (const c of companies) {
      try {
        const companyKey = c.inn || c.name;
        const phones = c.phones.join(', ');
        const cropsStr = c.crops.join(', ');
        const areaStr = describeAreas(c.areas);

        // Всё из XLS пишем в заметки — description не трогаем,
        // чтобы не затирать то, что admin написал вручную
        const xlsParts = [
          c.address        ? `Адрес: ${c.address}`              : '',
          c.person         ? `Руководитель: ${c.person}`        : '',
          c.phones.length > 1 ? `Телефоны: ${phones}`           : '',
          c.emails.length  ? `Email: ${c.emails.join(', ')}`    : '',
          cropsStr         ? `Культуры: ${cropsStr}`            : '',
          areaStr          ? `Посевная площадь: ${areaStr}`     : '',
        ].filter(Boolean);
        const notes = xlsParts.length ? `📥 Из XLS-базы\n${xlsParts.join('\n')}` : null;

        upsertCompany.run({
          id:      companyKey,
          inn:     c.inn || null,
          name:    c.name || null,
          phone:   phones || null,
          email:   c.emails[0] || null,
          ceoName: c.person || null,
          notes,
        });

        const exists = inRegistry(c);

        if (!exists && !skipExisting) {
          // Стабильный id: повторный импорт того же файла не плодит дубли
          const declId = 'xls_' + (c.inn || crypto.createHash('sha1').update(nameKey(c.name) || c.name).digest('hex').slice(0, 16));
          const { changes } = insertDecl.run({
            id:          declId,
            shortName:   c.name || c.inn,
            inn:         c.inn || '',
            address:     c.address || '',
            phone:       c.phones[0] || '',
            productName: cropsStr || '',
          });
          changes ? result.inserted++ : result.enriched++;
        } else if (exists) {
          result.enriched++;
        } else {
          result.skipped++;
        }
      } catch (e) {
        result.errors.push({ company: c.name || c.inn, error: e.message });
      }
    }
  });

  doImport();
  return result;
}

module.exports = { importXlsx };
