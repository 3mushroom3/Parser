const XLSX  = require('xlsx');
const axios = require('axios');
const path  = require('path');
const fs    = require('fs');
const db    = require('./db');

const UPLOAD_DIR = path.join(__dirname, '../../data/user_uploads');

// ── Groq AI: определение типов колонок ────────────────────────────────────
async function detectColumnsWithAI(headers, sampleRows) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  const headersStr = headers
    .map((h, i) => `${i}:"${String(h || '').trim()}"`)
    .filter((_, i) => headers[i])
    .join(', ');

  const samples = sampleRows.slice(0, 3).map(row =>
    headers.map((_, i) => String(row[i] ?? '').slice(0, 30)).join(' | ')
  ).join('\n');

  const prompt =
`Таблица Excel. Определи типы колонок по шапке и примерам данных.

Шапка: ${headersStr}
Примеры строк:
${samples}

Верни ТОЛЬКО валидный JSON, без пояснений:
{"inn":-1,"name":-1,"phone":-1,"phone2":-1,"email":-1,"address":-1}

Правила:
- inn: ИНН (10 или 12 цифр, может быть в одной колонке с КПП через /)
- name: название компании или ФИО
- phone: основной телефон (мобильный, рабочий, сотовый)
- phone2: второй телефон если есть отдельная колонка
- email: электронная почта
- address: адрес, город, регион
- Если не определён — -1`;

  const resp = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 80,
    },
    {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 12000,
    }
  );

  const text = resp.data?.choices?.[0]?.message?.content?.trim() || '';
  const match = text.match(/\{[^}]+\}/);
  if (!match) throw new Error('AI вернул не JSON: ' + text.slice(0, 100));

  const parsed = JSON.parse(match[0]);
  const result = {};
  for (const key of ['inn', 'name', 'phone', 'phone2', 'email', 'address']) {
    result[key] = Number.isInteger(parsed[key]) ? parsed[key] : -1;
  }
  return result;
}

// ── Keyword fallback ───────────────────────────────────────────────────────
const COL_RULES = [
  { key: 'inn',     test: h => /^ин+н$|^inn$/i.test(h) || /\bинн\b/i.test(h) },
  { key: 'email',   test: h => /e[\-\s]?mail|почт/i.test(h) },
  { key: 'phone',   test: h => /^тел|телефон|phone|^моб|^сот/i.test(h) },
  { key: 'name',    test: h => /назван|компан|организ|наим|фирм|предприят|^name$|^shortname$/i.test(h) },
  { key: 'address', test: h => /адрес|address|местонахожд/i.test(h) },
];

function detectColumnsKeyword(headers) {
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

// ── Нормализация ───────────────────────────────────────────────────────────

// Возвращает МАССИВ всех найденных телефонов в тексте — берём первый
// как основной, второй (если есть) как phone2. Раньше возвращал только
// первое совпадение, теряя «(86342) 6-55-04, 8-960-459-8732» → второй.
function extractAllPhones(raw) {
  if (!raw && raw !== 0) return [];
  const s = String(raw).trim();
  if (!s) return [];

  const results = [];
  const seen = new Set();
  const push = (digits) => {
    let norm;
    if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8')) norm = '+7' + digits.slice(1);
    else if (digits.length === 10) norm = '+7' + digits;
    else return;
    if (!seen.has(norm)) { seen.add(norm); results.push(norm); }
  };

  // 1) полные номера с +7/8
  const RU_PHONE = /(?:\+7|8)[\s\-\(]*\d{3}[\s\-\)]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/g;
  for (const m of (s.match(RU_PHONE) || [])) push(m.replace(/\D/g, ''));

  // 2) 10-значные (мобильные 9xx или городские с кодом города)
  const TEN = /(?<!\d)(?:9\d{2}|[3-8]\d{2})[\s\-]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}(?!\d)/g;
  for (const m of (s.match(TEN) || [])) push(m.replace(/\D/g, ''));

  // 3) городские с кодом в скобках (86342) 6-55-04 — 4-5 цифр после (nnnnn)
  const CITY_PAREN = /\((\d{3,5})\)\s*(\d[\d\s\-]{4,10}\d)/g;
  let m;
  while ((m = CITY_PAREN.exec(s)) !== null) {
    const digits = (m[1] + m[2]).replace(/\D/g, '');
    if (digits.length === 10 || digits.length === 11) push(digits);
  }

  // 4) fallback: только цифры в ячейке
  if (!results.length) {
    const digits = s.replace(/\D/g, '');
    if (digits.length === 11 || digits.length === 10) push(digits);
  }
  return results;
}

// Совместимость со старым API — возвращает первый телефон
function normalizePhone(raw) { return extractAllPhones(raw)[0] || ''; }

// Извлекает email из ячейки (даже из смешанного текста).
// Ранее брал первое совпадение; теперь пропускает нередкий мусор вроде
// domain.rutel:8-800-... где кусок текста ошибочно матчится как email.
function extractEmail(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  const matches = s.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [];
  return matches.length ? matches[0].toLowerCase() : '';
}

function normalizeInn(raw) {
  const s = String(raw || '').replace(/[^0-9]/g, ' ').trim().split(/\s+/)[0] || '';
  return (s.length === 10 || s.length === 12) ? s : '';
}

// Ищет строку заголовка. Ранее ограничение в 6 строк и просто «≥2 текстовых
// ячеек» — ложно срабатывало на пустых строках-подписях. Теперь:
// - до 20 строк
// - строка со scoring по ключевым словам (тел/email/адрес/имя/инн/название/город)
// - минимум 2 совпадения ключевых слов ИЛИ 3+ текстовых ячеек длиной >2
const HEADER_KEYWORDS = /^(инн|телефон|тел\.?|моб|сот|email|e[-\s]?mail|почт|назв|компан|организ|наим|фирм|предприят|адрес|address|город|регион|фио|имя|руковод|дир|контакт)/i;
function findHeaderRow(rows) {
  const scan = Math.min(rows.length, 20);
  let bestIdx = 0, bestScore = -1;
  for (let i = 0; i < scan; i++) {
    const row = rows[i] || [];
    if (!row.some(c => c !== '' && c != null)) continue; // пустая строка — пропускаем
    let keywordHits = 0;
    let textCells = 0;
    for (const cell of row) {
      const t = String(cell || '').trim();
      if (!t) continue;
      if (t.length >= 2 && /[а-яёa-z]/i.test(t)) textCells++;
      if (HEADER_KEYWORDS.test(t)) keywordHits++;
    }
    // счёт: ключевые слова дают +10 очков, текстовые ячейки +1
    const score = keywordHits * 10 + textCells;
    // валидный заголовок: ≥2 ключевых ИЛИ ≥3 текстовых
    if ((keywordHits >= 2 || textCells >= 3) && score > bestScore) {
      bestScore = score; bestIdx = i;
    }
  }
  return bestIdx;
}

const MAX_ROWS = 100_000;

// ── Шаг 1: загрузка файла и превью для выбора колонок ─────────────────────
async function previewUpload(userId, buffer, originalName) {
  // Быстрая проверка до тяжёлого парсинга
  if (buffer.length < 8) throw new Error('Файл пустой или повреждён');

  const wb = XLSX.read(buffer, { type: 'buffer', sheetRows: MAX_ROWS + 10 });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  if (!rows.length) throw new Error('Файл пустой или не читается');

  const headerIdx = findHeaderRow(rows);
  const headers   = (rows[headerIdx] || []).map(h => String(h || ''));
  const dataRows  = rows.slice(headerIdx + 1);

  if (!dataRows.length) throw new Error('Нет строк с данными после заголовка');
  if (dataRows.length > MAX_ROWS) {
    throw new Error(`Файл содержит более ${MAX_ROWS.toLocaleString('ru')} строк. Разбейте базу на части и загружайте по частям.`);
  }

  // Первые 5 строк для превью (обрезаем ячейки до 25 символов)
  const sampleRows = dataRows.slice(0, 5).map(row =>
    headers.map((_, i) => String(row[i] ?? '').trim().slice(0, 25))
  );

  // AI + keyword-подсказка
  let suggestedCols, detectionMethod = 'keyword';
  try {
    const ai = await detectColumnsWithAI(headers, dataRows);
    if (ai) { suggestedCols = ai; detectionMethod = 'ai'; }
    else      suggestedCols = detectColumnsKeyword(headers);
  } catch (e) {
    console.warn('[preview] AI fallback:', e.message);
    suggestedCols = detectColumnsKeyword(headers);
  }

  // Сохраняем файл как pending
  const { lastInsertRowid: uploadId } = db.prepare(`
    INSERT INTO user_uploads (userId, filename, originalName, fileSize, totalRows, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `).run(userId, originalName, originalName, buffer.length, dataRows.length);

  const userDir  = path.join(UPLOAD_DIR, String(userId));
  fs.mkdirSync(userDir, { recursive: true });
  const safeName = originalName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80);
  const filename = `${uploadId}_${safeName}`;
  fs.writeFileSync(path.join(userDir, filename), buffer);
  db.prepare('UPDATE user_uploads SET filename = ? WHERE id = ?').run(filename, uploadId);

  return { uploadId, originalName, headers, sampleRows, suggestedCols, detectionMethod };
}

// ── Шаг 2: обработка файла с маппингом выбранным пользователем ────────────
function processWithMapping(userId, uploadId, mapping) {
  const upload = db.prepare('SELECT * FROM user_uploads WHERE id = ? AND userId = ?').get(uploadId, userId);
  if (!upload) throw new Error('Загрузка не найдена');

  const filePath = path.join(UPLOAD_DIR, String(userId), upload.filename);
  if (!fs.existsSync(filePath)) throw new Error('Файл не найден на сервере');

  const buffer = fs.readFileSync(filePath);
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  const headerIdx = findHeaderRow(rows);
  const dataRows  = rows.slice(headerIdx + 1);

  const cols = {
    inn:     Number.isInteger(mapping.inn)     ? mapping.inn     : -1,
    name:    Number.isInteger(mapping.name)    ? mapping.name    : -1,
    phone:   Number.isInteger(mapping.phone)   ? mapping.phone   : -1,
    phone2:  Number.isInteger(mapping.phone2)  ? mapping.phone2  : -1,
    email:   Number.isInteger(mapping.email)   ? mapping.email   : -1,
    address: Number.isInteger(mapping.address) ? mapping.address : -1,
  };

  if (cols.phone < 0 && cols.email < 0) {
    throw new Error('Необходимо выбрать хотя бы одну колонку с Телефоном или Email');
  }

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
      // В одной ячейке "Телефоны" часто два номера через запятую — забираем оба
      const phonesInMain = cols.phone  >= 0 ? extractAllPhones(row[cols.phone])  : [];
      const phonesInAlt  = cols.phone2 >= 0 ? extractAllPhones(row[cols.phone2]) : [];
      const allPhones = [...phonesInMain, ...phonesInAlt].filter((v, i, a) => v && a.indexOf(v) === i);
      const phone  = allPhones[0] || '';
      const phone2 = allPhones[1] || '';
      const email       = extractEmail(cols.email >= 0 ? row[cols.email] : '');
      const address     = String(cols.address >= 0 ? row[cols.address] ?? '' : '').trim();

      if (!phone && !email)     { skipped++; continue; }
      if (!inn && !companyName) { skipped++; continue; }

      let isPrivate = 1;
      if (inn && checkByInn.get(inn))           isPrivate = 0;
      if (isPrivate && companyName) {
        const slug = companyName.toLowerCase().slice(0, 25);
        if (checkByName.get(`%${slug}%`))       isPrivate = 0;
      }

      insertStmt.run({ userId, uploadId,
        inn: inn || null, companyName: companyName || null,
        phone: phone || null, phone2: phone2 || null,
        email: email || null, address: address || null, isPrivate });
      isPrivate ? privateCount++ : matched++;
    }
  });

  doInsert();
  db.prepare("UPDATE user_uploads SET status='processed', matchedRows=?, privateRows=? WHERE id=?")
    .run(matched, privateCount, uploadId);

  return { matched, private: privateCount, skipped, total: dataRows.length };
}

// ── Запросы ────────────────────────────────────────────────────────────────
function getUploads(userId) {
  // Удаляем брошенные pending-загрузки старше суток
  db.prepare(`
    DELETE FROM user_uploads
    WHERE userId=? AND status='pending' AND datetime(createdAt) < datetime('now','-1 day')
  `).run(userId);

  return db.prepare(`
    SELECT id, originalName, fileSize, totalRows, matchedRows, privateRows, createdAt
    FROM user_uploads WHERE userId=? AND status='processed' ORDER BY createdAt DESC
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

function getContactsForCompany(userId, inn, name) {
  if (!userId) return [];
  if (inn) {
    const rows = db.prepare(`
      SELECT DISTINCT phone, phone2, email, address, companyName
      FROM user_contacts WHERE userId=? AND inn=? AND (phone IS NOT NULL OR email IS NOT NULL)
      LIMIT 10
    `).all(userId, inn);
    if (rows.length) return rows;
  }
  if (!name) return [];
  const slug = String(name).toLowerCase().slice(0, 25);
  return db.prepare(`
    SELECT DISTINCT phone, phone2, email, address, companyName
    FROM user_contacts
    WHERE userId=? AND lower_u(COALESCE(companyName,'')) LIKE ? AND (phone IS NOT NULL OR email IS NOT NULL)
    LIMIT 10
  `).all(userId, `%${slug}%`);
}

function getPrivateCompanies(userId, page = 0, pageSize = 50) {
  const offset = page * pageSize;
  const rows  = db.prepare(`
    SELECT inn, companyName, phone, phone2, email, address, createdAt
    FROM user_contacts WHERE userId=? AND isPrivate=1
    GROUP BY COALESCE(inn, companyName)
    ORDER BY MAX(createdAt) DESC LIMIT ? OFFSET ?
  `).all(userId, pageSize, offset);
  const total = db.prepare(`
    SELECT COUNT(DISTINCT COALESCE(inn, companyName)) c
    FROM user_contacts WHERE userId=? AND isPrivate=1
  `).get(userId)?.c || 0;
  return { rows, total };
}

module.exports = {
  previewUpload, processWithMapping,
  getUploads, deleteUpload, getContactsForCompany, getPrivateCompanies,
};
