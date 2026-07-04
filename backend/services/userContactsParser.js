const XLSX = require('xlsx');
const path = require('path');
const fs   = require('fs');
const db   = require('./db');

const UPLOAD_DIR = path.join(__dirname, '../../data/user_uploads');

// ── Определение столбцов по ключевым словам шапки ─────────────────────────
const COL_RULES = [
  { key: 'inn',     test: h => /^ин+н$|^inn$/i.test(h) || /\bинн\b/i.test(h) },
  { key: 'email',   test: h => /e[\-\s]?mail|почт/i.test(h) },
  { key: 'phone',   test: h => /^тел|телефон|phone|^моб|^сот/i.test(h) },
  { key: 'name',    test: h => /назван|компан|организ|наим|фирм|предприят|^name$|^shortname$/i.test(h) },
  { key: 'address', test: h => /адрес|address|местонахожд/i.test(h) },
];

function detectColumns(headers) {
  const cols = { inn: -1, phone: -1, phone2: -1, email: -1, name: -1, address: -1 };
  headers.forEach((raw, i) => {
    const h = String(raw || '').trim().toLowerCase();
    if (!h) return;
    for (const { key, test } of COL_RULES) {
      if (!test(h)) continue;
      if (key === 'phone' && cols.phone >= 0 && cols.phone2 < 0) { cols.phone2 = i; return; }
      if (cols[key] < 0) { cols[key] = i; return; }
    }
  });
  return cols;
}

// ── Нормализация данных ────────────────────────────────────────────────────
function normalizePhone(raw) {
  if (!raw && raw !== 0) return '';
  const s = String(raw).trim();
  const digits = s.replace(/\D/g, '');
  if (!digits || digits.length < 7) return '';
  if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8')) return '+7' + digits.slice(1);
  if (digits.length === 10) return '+7' + digits;
  return s.replace(/[^\d+\-() ]/g, '').trim();
}

function normalizeInn(raw) {
  const s = String(raw || '').replace(/\D/g, '');
  return (s.length === 10 || s.length === 12) ? s : '';
}

// ── Поиск строки-заголовка (первая строка с ≥2 текстовыми ячейками) ────────
function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 6); i++) {
    const textCells = (rows[i] || []).filter(c => /[а-яёa-z]/i.test(String(c || ''))).length;
    if (textCells >= 2) return i;
  }
  return 0;
}

// ── Основная функция: парсинг и сохранение ─────────────────────────────────
function processUpload(userId, buffer, originalName) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  if (!rows.length) throw new Error('Файл пустой или не читается');

  const headerIdx = findHeaderRow(rows);
  const headers   = (rows[headerIdx] || []).map(h => String(h || ''));
  const cols      = detectColumns(headers);

  if (cols.phone < 0 && cols.email < 0) {
    const found = headers.filter(Boolean).slice(0, 8).join(', ');
    throw new Error(
      `Не найдены колонки с телефоном или email. ` +
      `Шапка (строка ${headerIdx + 1}): ${found || '(пусто)'}. ` +
      `Добавьте в шапку: Телефон, Тел, Phone, Email.`
    );
  }

  const dataRows = rows.slice(headerIdx + 1);
  if (!dataRows.length) throw new Error('Нет строк с данными после заголовка');

  const { lastInsertRowid: uploadId } = db.prepare(`
    INSERT INTO user_uploads (userId, filename, originalName, fileSize, totalRows)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, originalName, originalName, buffer.length, dataRows.length);

  // Сохраняем файл
  const userDir  = path.join(UPLOAD_DIR, String(userId));
  fs.mkdirSync(userDir, { recursive: true });
  const safeName = originalName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80);
  const filename = `${uploadId}_${safeName}`;
  fs.writeFileSync(path.join(userDir, filename), buffer);
  db.prepare('UPDATE user_uploads SET filename = ? WHERE id = ?').run(filename, uploadId);

  const checkByInn  = db.prepare('SELECT 1 FROM declarations WHERE inn = ? LIMIT 1');
  const checkByName = db.prepare("SELECT 1 FROM declarations WHERE lower_u(COALESCE(shortName,'')) LIKE ? LIMIT 1");
  const insertStmt  = db.prepare(`
    INSERT INTO user_contacts (userId, uploadId, inn, companyName, phone, phone2, email, address, isPrivate)
    VALUES (@userId, @uploadId, @inn, @companyName, @phone, @phone2, @email, @address, @isPrivate)
  `);

  let matched = 0, privateCount = 0, skipped = 0;

  const doInsert = db.transaction(() => {
    for (const row of dataRows) {
      const inn         = normalizeInn(cols.inn     >= 0 ? row[cols.inn]     : '');
      const companyName = String(cols.name    >= 0 ? row[cols.name]    ?? '' : '').trim();
      const phone       = normalizePhone(cols.phone  >= 0 ? row[cols.phone]  : '');
      const phone2      = normalizePhone(cols.phone2 >= 0 ? row[cols.phone2] : '');
      const email       = String(cols.email   >= 0 ? row[cols.email]   ?? '' : '').trim();
      const address     = String(cols.address >= 0 ? row[cols.address] ?? '' : '').trim();

      if (!phone && !email)        { skipped++; continue; }
      if (!inn && !companyName)    { skipped++; continue; }

      let isPrivate = 1;
      if (inn && checkByInn.get(inn))                                           isPrivate = 0;
      if (isPrivate && companyName) {
        const slug = companyName.toLowerCase().slice(0, 25);
        if (checkByName.get(`%${slug}%`))                                       isPrivate = 0;
      }

      insertStmt.run({ userId, uploadId,
        inn: inn || null, companyName: companyName || null,
        phone: phone || null, phone2: phone2 || null,
        email: email || null, address: address || null, isPrivate });
      isPrivate ? privateCount++ : matched++;
    }
  });

  doInsert();
  db.prepare('UPDATE user_uploads SET matchedRows = ?, privateRows = ? WHERE id = ?')
    .run(matched, privateCount, uploadId);

  return { uploadId, matched, private: privateCount, skipped, total: dataRows.length };
}

// ── Запросы ────────────────────────────────────────────────────────────────
function getUploads(userId) {
  return db.prepare(`
    SELECT id, originalName, fileSize, totalRows, matchedRows, privateRows, createdAt
    FROM user_uploads WHERE userId = ? ORDER BY createdAt DESC
  `).all(userId);
}

function deleteUpload(userId, uploadId) {
  const upload = db.prepare('SELECT * FROM user_uploads WHERE id = ? AND userId = ?').get(uploadId, userId);
  if (!upload) return false;
  try {
    const fp = path.join(UPLOAD_DIR, String(userId), upload.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch (_) {}
  db.prepare('DELETE FROM user_contacts WHERE uploadId = ?').run(uploadId);
  db.prepare('DELETE FROM user_uploads WHERE id = ?').run(uploadId);
  return true;
}

// Уникальные телефоны/email для компании (по ИНН или имени)
function getContactsForCompany(userId, inn, name) {
  if (!userId) return [];
  if (inn) {
    const rows = db.prepare(`
      SELECT DISTINCT phone, phone2, email, address, companyName
      FROM user_contacts WHERE userId = ? AND inn = ? AND (phone IS NOT NULL OR email IS NOT NULL)
      LIMIT 10
    `).all(userId, inn);
    if (rows.length) return rows;
  }
  if (!name) return [];
  const slug = String(name).toLowerCase().slice(0, 25);
  return db.prepare(`
    SELECT DISTINCT phone, phone2, email, address, companyName
    FROM user_contacts
    WHERE userId = ? AND lower_u(COALESCE(companyName,'')) LIKE ? AND (phone IS NOT NULL OR email IS NOT NULL)
    LIMIT 10
  `).all(userId, `%${slug}%`);
}

function getPrivateCompanies(userId, page = 0, pageSize = 50) {
  const offset = page * pageSize;
  const rows  = db.prepare(`
    SELECT inn, companyName, phone, phone2, email, address, createdAt
    FROM user_contacts WHERE userId = ? AND isPrivate = 1
    GROUP BY COALESCE(inn, companyName)
    ORDER BY MAX(createdAt) DESC
    LIMIT ? OFFSET ?
  `).all(userId, pageSize, offset);
  const total = db.prepare(`
    SELECT COUNT(DISTINCT COALESCE(inn, companyName)) c
    FROM user_contacts WHERE userId = ? AND isPrivate = 1
  `).get(userId)?.c || 0;
  return { rows, total };
}

module.exports = { processUpload, getUploads, deleteUpload, getContactsForCompany, getPrivateCompanies };
