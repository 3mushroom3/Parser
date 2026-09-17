const axios = require('axios');
const path  = require('path');
const fs    = require('fs');
const db    = require('./db');
const {
  MAX_ROWS, CONTACT_TYPES,
  readWorkbook, analyzeWorkbook, loadSheet, buildRecords, findInRegistry, cellText,
} = require('./sheetAnalyzer');

const UPLOAD_DIR = path.join(__dirname, '../../data/user_uploads');

// ── Groq AI: добивает типы, которые не удалось определить локально ─────────
async function detectColumnsWithAI(headers, sampleRows) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  const headersStr = headers
    .map((h, i) => `${i}:"${String(h || '').trim()}"`)
    .filter((_, i) => headers[i])
    .join(', ');

  const samples = sampleRows.slice(0, 3).map(row =>
    headers.map((_, i) => String(row[i] ?? '').slice(0, 40)).join(' | ')
  ).join('\n');

  const prompt =
`Таблица Excel. Определи типы колонок по шапке и примерам данных.

Шапка: ${headersStr}
Примеры строк:
${samples}

Верни ТОЛЬКО валидный JSON, без пояснений:
{"inn":-1,"name":-1,"phone":-1,"phone2":-1,"email":-1,"address":-1,"person":-1}

Правила:
- inn: ИНН (10 или 12 цифр, может быть в одной колонке с КПП через /)
- name: название компании (или ФИО, если это ИП/фермер без отдельного названия)
- phone: основной телефон (мобильный, рабочий, сотовый)
- phone2: второй телефон если есть отдельная колонка
- email: электронная почта
- address: адрес, город, регион
- person: ФИО руководителя / контактного лица
- Одна колонка может содержать несколько типов (адрес + ФИО + телефон)
- Если не определён — -1`;

  const resp = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 100,
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
  for (const key of CONTACT_TYPES) {
    result[key] = Number.isInteger(parsed[key]) && parsed[key] < headers.length ? parsed[key] : -1;
  }
  return result;
}

// ── Шаг 1: загрузка файла и превью для выбора колонок ─────────────────────
async function previewUpload(userId, buffer, originalName) {
  const wb = readWorkbook(buffer, originalName);
  const analysis = analyzeWorkbook(wb, { types: CONTACT_TYPES });
  if (!analysis) throw new Error('Файл пустой или не читается');

  const { sheetName, rows, layout } = analysis;
  if (!layout.dataRows) throw new Error('Нет строк с данными после заголовка');
  if (rows.length > MAX_ROWS) {
    throw new Error(`Файл содержит более ${MAX_ROWS.toLocaleString('ru')} строк. Разбейте базу на части и загружайте по частям.`);
  }

  const headers = layout.labels;
  // В превью — первые строки с данными, а не пустые строки-продолжения
  const sampleSource = [];
  for (let r = layout.dataStart; r < rows.length && sampleSource.length < 6; r++) {
    const row = rows[r] || [];
    const filled = row.filter(v => cellText(v)).length;
    if (filled >= Math.min(2, headers.length)) sampleSource.push(row);
  }
  const sampleRows = sampleSource.map(row => headers.map((_, i) => cellText(row[i]).replace(/\s+/g, ' ').slice(0, 120)));

  const suggestedCols = { ...analysis.suggested };
  let detectionMethod = 'auto';
  const missing = ['inn', 'name', 'phone', 'email'].filter(t => suggestedCols[t] < 0);
  if (missing.length) {
    try {
      const ai = await detectColumnsWithAI(headers, sampleRows);
      if (ai) {
        for (const t of missing) {
          if (ai[t] >= 0) { suggestedCols[t] = ai[t]; detectionMethod = 'auto+ai'; }
        }
      }
    } catch (e) {
      console.warn('[preview] AI fallback:', e.message);
    }
  }

  const layoutJson = JSON.stringify({
    sheetName, headerRow: layout.headerRow, headerRows: layout.headerRows,
    dataStart: layout.dataStart, colCount: layout.colCount, labels: layout.labels,
  });

  // Сохраняем файл как pending
  const { lastInsertRowid: uploadId } = db.prepare(`
    INSERT INTO user_uploads (userId, filename, originalName, fileSize, totalRows, status, layout)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(userId, originalName, originalName, buffer.length, layout.dataRows, layoutJson);

  const userDir  = path.join(UPLOAD_DIR, String(userId));
  fs.mkdirSync(userDir, { recursive: true });
  const safeName = originalName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80);
  const filename = `${uploadId}_${safeName}`;
  fs.writeFileSync(path.join(userDir, filename), buffer);
  db.prepare('UPDATE user_uploads SET filename = ? WHERE id = ?').run(filename, uploadId);

  return {
    uploadId, originalName, headers, sampleRows, suggestedCols, detectionMethod,
    sheetName,
    sheetCount: wb.SheetNames.length,
    headerRow: layout.headerRow === null ? null : layout.headerRow + 1,
    dataRows: layout.dataRows,
  };
}

// ── Шаг 2: обработка файла с маппингом выбранным пользователем ────────────
function processWithMapping(userId, uploadId, mapping) {
  const upload = db.prepare('SELECT * FROM user_uploads WHERE id = ? AND userId = ?').get(uploadId, userId);
  if (!upload) throw new Error('Загрузка не найдена');

  const filePath = path.join(UPLOAD_DIR, String(userId), upload.filename);
  if (!fs.existsSync(filePath)) throw new Error('Файл не найден на сервере');

  const has = t => Number.isInteger(mapping?.[t]) && mapping[t] >= 0;
  if (!has('phone') && !has('phone2') && !has('email')) {
    throw new Error('Необходимо выбрать хотя бы одну колонку с Телефоном или Email');
  }
  if (!has('inn') && !has('name')) {
    throw new Error('Выберите колонку с ИНН или Названием — иначе контакты не к чему привязать');
  }

  const wb = readWorkbook(fs.readFileSync(filePath), upload.originalName);
  let sheet = null;
  try { sheet = upload.layout ? loadSheet(wb, JSON.parse(upload.layout)) : null; } catch (_) {}
  if (!sheet) sheet = analyzeWorkbook(wb, { types: CONTACT_TYPES });
  if (!sheet) throw new Error('Файл пустой или не читается');

  const { records, stats } = buildRecords(sheet.rows, sheet.layout, mapping);
  const isKnown = findInRegistry(db, records);

  const insertStmt = db.prepare(`
    INSERT INTO user_contacts (userId, uploadId, inn, companyName, phone, phone2, email, address, contactName, isPrivate)
    VALUES (@userId, @uploadId, @inn, @companyName, @phone, @phone2, @email, @address, @contactName, @isPrivate)
  `);

  let matched = 0, privateCount = 0, noContacts = 0;
  const doInsert = db.transaction(() => {
    for (const rec of records) {
      if (!rec.phones.length && !rec.emails.length) { noContacts++; continue; }
      const isPrivate = isKnown(rec) ? 0 : 1;
      insertStmt.run({
        userId, uploadId,
        inn: rec.inn || null,
        companyName: rec.name || null,
        phone: rec.phones[0] || null,
        phone2: rec.phones[1] || null,
        email: rec.emails[0] || null,
        address: rec.address || null,
        contactName: rec.person || null,
        isPrivate,
      });
      isPrivate ? privateCount++ : matched++;
    }
  });
  doInsert();

  const imported = matched + privateCount;
  db.prepare("UPDATE user_uploads SET status='processed', totalRows=?, matchedRows=?, privateRows=? WHERE id=?")
    .run(imported, matched, privateCount, uploadId);

  return {
    imported, matched, private: privateCount,
    skipped: noContacts + stats.skipped,
    noContacts,
    merged: stats.merged,
    total: records.length,
    rows: stats.rows,
  };
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
      SELECT DISTINCT phone, phone2, email, address, contactName, companyName
      FROM user_contacts WHERE userId=? AND inn=? AND (phone IS NOT NULL OR email IS NOT NULL)
      LIMIT 10
    `).all(userId, inn);
    if (rows.length) return rows;
  }
  if (!name) return [];
  const slug = String(name).toLowerCase().slice(0, 25);
  return db.prepare(`
    SELECT DISTINCT phone, phone2, email, address, contactName, companyName
    FROM user_contacts
    WHERE userId=? AND lower_u(COALESCE(companyName,'')) LIKE ? AND (phone IS NOT NULL OR email IS NOT NULL)
    LIMIT 10
  `).all(userId, `%${slug}%`);
}

function getPrivateCompanies(userId, page = 0, pageSize = 50) {
  const offset = page * pageSize;
  const rows  = db.prepare(`
    SELECT inn, companyName, phone, phone2, email, address, contactName, createdAt
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
