/**
 * Импорт производителей из XLS/XLSX-файла.
 *
 * Формат файла (образец «Луганская НР»):
 *  - Строки 0-2: заголовки/подзаголовки — пропускаем
 *  - Строка 3+: данные. Если колонки «название» и «ИНН» пусты — строка
 *    принадлежит предыдущей компании (ещё одна культура).
 *
 * Колонки (0-based):
 *   1 = название предприятия
 *   2 = ИНН
 *   3 = контакты (адрес + директор + телефон в одной строке)
 *  14 = вид культуры
 *  15 = площадь посевов, га
 */
const XLSX = require('xlsx');
const db   = require('./db');

const HEADER_ROWS = 3; // строки 0-2 — шапка

// ── Парсинг контактного поля ──────────────────────────────────────────────
function parseContact(raw) {
  if (!raw) return { address: '', phone: '', ceoName: '' };
  const s = String(raw).trim();

  // Телефон: +7 или 8, 10-11 цифр, допускаем пробелы/скобки/дефисы
  const phoneMatch = s.match(/(?:тел\.?\s*)?(\+?7[\s()\-\d]{9,15}\d)/i) ||
                     s.match(/(\+7[\d]{10})/);
  const phone = phoneMatch ? phoneMatch[1].replace(/[^+\d]/g, '') : '';

  // Директор: вариации "Директор Иванов А.А.", "ФИО:", "Фамилия Имя Отчество"
  // Важно: \w в JS не включает кириллицу, поэтому используем \s вместо [^\w]
  const ceoMatch = s.match(/директор\s*[-–]?\s*([А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё.]+)+)/i) ||
                   s.match(/(?:\d[\s,]+)([А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+)(?:\s*,|\s*\+|\s*$)/i) ||
                   s.match(/,\s*([А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+)\s*,/);
  const ceoName = ceoMatch
    ? ceoMatch[1].trim()
        .replace(/\s+(?:тел|тлф|phone|факс)\.?\s*$/i, '')  // убрать "тел." в конце
        .replace(/,\s*$/, '')
        .trim()
    : '';

  // Адрес: всё до первого упоминания директора или телефона
  const addrEnd = s.search(/директор|тел\.|(\+7|8\()\d{3}/i);
  const address = (addrEnd > 0 ? s.slice(0, addrEnd) : s)
    .replace(/,$/, '').trim();

  return { address, phone, ceoName };
}

// ── Нормализуем строки культур ────────────────────────────────────────────
function normCrops(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[,;/\n\t]+/)
    .map(c => c.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// ── Основная функция импорта ──────────────────────────────────────────────
function importXlsx(buffer, options = {}) {
  const { skipExisting = false } = options;

  const wb   = XLSX.read(buffer, { type: 'buffer' });
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

  // Группируем строки по компаниям
  const companies = [];
  let cur = null;

  for (let i = HEADER_ROWS; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.every(c => c === null || c === undefined || c === '')) continue;

    const rawName = r[1];
    const rawInn  = r[2];
    const name = rawName ? String(rawName).trim() : '';
    const inn  = rawInn  ? String(rawInn ).replace(/\D/g, '') : '';

    if (name) {
      // Новая компания
      cur = { name, inn, rawContact: r[3] || '', crops: [], areaByСrop: {} };
      companies.push(cur);
    }
    // Культура текущей компании
    if (cur) {
      const cropCell = r[14];
      const areaCell = r[15];
      if (cropCell) {
        normCrops(cropCell).forEach(c => {
          if (!cur.crops.includes(c)) {
            cur.crops.push(c);
            if (areaCell) cur.areaByСrop[c] = Number(areaCell) || 0;
          }
        });
      }
    }
  }

  // ── Запись в БД ───────────────────────────────────────────────────────
  const result = { total: companies.length, inserted: 0, enriched: 0, skipped: 0, errors: [] };

  const upsertCompany = db.prepare(`
    INSERT INTO companies (id, inn, name, phone, ceoName, description, notes, updatedAt)
    VALUES (@id, @inn, @name, @phone, @ceoName, @description, @notes, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      phone    = COALESCE(NULLIF(excluded.phone, ''), companies.phone),
      ceoName  = COALESCE(NULLIF(excluded.ceoName, ''), companies.ceoName),
      description = COALESCE(NULLIF(excluded.description, ''), companies.description),
      updatedAt = CURRENT_TIMESTAMP
  `);

  const checkDecl = db.prepare(
    "SELECT COUNT(*) c FROM declarations WHERE (inn = ? AND inn != '') OR (lower_u(shortName) = lower_u(?))"
  );
  const insertDecl = db.prepare(`
    INSERT OR IGNORE INTO declarations
      (id, source, status, shortName, inn, address, phone, productName, fetchedAt, updatedAt)
    VALUES (@id, 'xls_import', 'active', @shortName, @inn, @address, @phone,
            @productName, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `);

  const doImport = db.transaction(() => {
    for (const c of companies) {
      try {
        const { address, phone, ceoName } = parseContact(c.rawContact);
        const companyKey = c.inn || c.name;
        const cropsStr   = c.crops.join(', ');
        const areaStr    = Object.entries(c.areaByСrop)
          .map(([cr, a]) => `${cr}: ${a} га`)
          .join('; ');
        const notes = [cropsStr, areaStr].filter(Boolean).join(' | ');

        upsertCompany.run({
          id:          companyKey,
          inn:         c.inn || null,
          name:        c.name,
          phone:       phone || null,
          ceoName:     ceoName || null,
          description: address || null,
          notes:       notes || null,
        });

        // Создаём ручную декларацию только если нет ФСА-данных
        const exists = c.inn
          ? checkDecl.get(c.inn, c.name).c > 0
          : checkDecl.get('', c.name).c > 0;

        if (!exists && !skipExisting) {
          const declId = 'xls_' + companyKey.replace(/\W/g, '_') + '_' + Date.now() % 100000;
          insertDecl.run({
            id:          declId,
            shortName:   c.name,
            inn:         c.inn || '',
            address:     address || '',
            phone:       phone  || '',
            productName: cropsStr || '',
          });
          result.inserted++;
        } else if (exists) {
          result.enriched++;
        } else {
          result.skipped++;
        }
      } catch (e) {
        result.errors.push({ company: c.name, error: e.message });
      }
    }
  });

  doImport();
  return result;
}

module.exports = { importXlsx };
