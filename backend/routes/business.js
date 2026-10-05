const express = require('express');
const router = express.Router();
const db = require('../services/db');
const auth = require('../middleware/auth');
const requireSubscription = require('../middleware/subscription');
const { dataReadLimiter } = require('../middleware/rateLimiters');

const DORMANT_AFTER_DAYS = 547; // 1.5 года без новых деклараций

router.get('/company', auth, requireSubscription, dataReadLimiter, (req, res) => {
  const { inn, name } = req.query;
  if (!inn && !name) return res.status(400).json({ error: 'inn or name required' });

  let records;
  if (inn) {
    records = db.prepare('SELECT * FROM declarations WHERE inn = ?').all(inn);
  } else {
    records = db.prepare('SELECT * FROM declarations WHERE (lower_u(shortName) = lower_u(?) OR lower_u(applicantName) = lower_u(?) OR lower_u(lastName) = lower_u(?))').all(name, name, name);
  }

  if (!records.length) return res.json({ found: false, decls: [] });

  const first = records[0];
  const key = inn || name;
  db.prepare('INSERT INTO companies (id, viewCount) VALUES (?, 1) ON CONFLICT(id) DO UPDATE SET viewCount = viewCount + 1').run(key);
  const companyInfo = db.prepare('SELECT * FROM companies WHERE id = ?').get(key);
  const isAdmin = req.user.role === 'admin';
  const contacts = db.prepare(
    'SELECT * FROM contacts WHERE companyId = ? AND (userId = ? OR (userId IS NULL AND ?)) ORDER BY id DESC'
  ).all(key, req.user.id, isAdmin ? 1 : 0);
  const myNotes = db.prepare('SELECT notes FROM company_user_notes WHERE userId = ? AND companyKey = ?').get(req.user.id, key);

  const lastDeclDate = records.reduce((max, r) => (r.regDate && r.regDate > max ? r.regDate : max), '');
  const daysSinceLastDecl = lastDeclDate ? Math.floor((Date.now() - new Date(lastDeclDate).getTime()) / 86400000) : null;

  res.json({
    found: true,
    inn: first.inn || '',
    name: first.shortName || first.applicantName || first.lastName || '',
    address: first.address || '',
    phone: first.phone || '',
    farmerType: first.farmerType || 'unknown',
    okved: first.okved || '',
    lastName: first.lastName || '',
    firstName: first.firstName || '',
    middleName: first.middleName || '',
    applicantName: first.applicantName || '',
    description: companyInfo?.description || '',
    // Личная заметка пользователя; старая общая — только админу, чтобы не потерялась.
    notes: myNotes ? myNotes.notes : (isAdmin ? companyInfo?.notes || '' : ''),
    companyRegDate: companyInfo?.regDate || '',
    autoNote: companyInfo?.autoNote || '',
    ebPhone: companyInfo?.phone || '',    // из XLS-импорта
    ebEmail: companyInfo?.email || '',
    ebWebsite: companyInfo?.website || '',
    ebCeoName: companyInfo?.ceoName || '',
    ebRevenue: companyInfo?.revenue || '',
    viewCount: companyInfo?.viewCount || 1,
    contacts,
    lastDeclDate,
    dormant: daysSinceLastDecl != null && daysSinceLastDecl > DORMANT_AFTER_DAYS,
    decls: records
      .map(r => ({
        id: r.id,
        regDate: r.regDate || '',
        endDate: r.endDate || '',
        productName: r.productName || '',
        batchSize: r.batchSize || '',
        declNumber: r.declNumber || '',
        status: r.status || '',
      }))
      .sort((a, b) => {
        const statusOrder = { active: 0, suspended: 1, expired: 2, archived: 3 };
        const sa = statusOrder[a.status] ?? 4;
        const sb = statusOrder[b.status] ?? 4;
        if (sa !== sb) return sa - sb;
        return b.regDate.localeCompare(a.regDate);
      }),
  });
});

// GET /api/business/company/report?inn=X — данные для отчёта о должной
// осмотрительности (E1). MVP на том, что уже даёт бесплатный ответ DaData
// при обогащении ОКВЭД (см. services/fnsClient.js): статус в ЕГРЮЛ, ОГРН,
// директор, дата регистрации, официальный адрес — без банкротства/арбитража/
// ФССП, для которых нужен платный источник (см. CLAUDE.md, фаза E1).
const EGRUL_STATUS_LABELS = {
  ACTIVE: 'Действующая', LIQUIDATING: 'В процессе ликвидации', LIQUIDATED: 'Ликвидирована',
  BANKRUPT: 'Банкротство', REORGANIZING: 'В процессе реорганизации',
};
router.get('/company/report', auth, requireSubscription, dataReadLimiter, (req, res) => {
  const { inn } = req.query;
  if (!inn) return res.status(400).json({ error: 'inn required' });

  const decl = db.prepare('SELECT address, shortName, applicantName, lastName, okved FROM declarations WHERE inn = ? ORDER BY regDate DESC LIMIT 1').get(inn);
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(inn);
  if (!decl && !company) return res.status(404).json({ error: 'Компания не найдена' });

  const declAddress = (decl?.address || '').trim();
  const egrulAddress = (company?.egrulAddress || '').trim();
  // Декларация и ЕГРЮЛ форматируют один и тот же адрес по-разному («ул.» vs
  // «улица», «р-н» vs «район», порядок слов, запятые) — точное вхождение
  // подстроки почти всегда ложно отрицательное. Сравниваем по пересечению
  // слов-токенов: адрес длинный, случайное совпадение >половины токенов
  // маловероятно, а разное форматирование одного адреса даёт его легко.
  const addressTokens = s => new Set(s.toLowerCase().replace(/[().,]/g, ' ').split(/\s+/).filter(t => t.length > 1));
  let addressMatch = null;
  if (declAddress && egrulAddress) {
    const ta = addressTokens(declAddress), tb = addressTokens(egrulAddress);
    const common = [...ta].filter(t => tb.has(t)).length;
    addressMatch = common / Math.min(ta.size, tb.size) >= 0.5;
  }

  res.json({
    inn,
    name: company?.name || decl?.shortName || decl?.applicantName || decl?.lastName || '',
    ogrn: company?.ogrn || '',
    egrulStatus: company?.egrulStatus || '',
    egrulStatusLabel: EGRUL_STATUS_LABELS[company?.egrulStatus] || (company?.egrulStatus ? company.egrulStatus : 'нет данных'),
    regDate: company?.regDate || '',
    director: company?.ceoName || '',
    okved: decl?.okved || '',
    declAddress,
    egrulAddress,
    addressMatch,
    hasEgrulData: !!(company?.egrulStatus || company?.ceoName || company?.regDate),
    generatedAt: new Date().toISOString(),
  });
});

// notes — личная заметка пользователя о компании; description — общее описание
// компании, которое видят все, поэтому менять его может только администратор.
router.put('/company/notes', auth, (req, res) => {
  const { inn, name, notes, description } = req.body || {};
  const key = inn || name;
  if (!key) return res.status(400).json({ error: 'inn or name required' });

  if (notes !== undefined) {
    db.prepare(`
      INSERT INTO company_user_notes (userId, companyKey, notes) VALUES (?, ?, ?)
      ON CONFLICT(userId, companyKey) DO UPDATE SET notes = excluded.notes, updatedAt = CURRENT_TIMESTAMP
    `).run(req.user.id, key, String(notes).slice(0, 5000));
  }

  if (description !== undefined) {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Описание компании может менять только администратор' });
    db.prepare(`
      INSERT INTO companies (id, inn, name, description) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET description = excluded.description, updatedAt = CURRENT_TIMESTAMP
    `).run(key, inn || null, name || null, String(description).slice(0, 5000));
  }

  res.json({ ok: true });
});

router.post('/company/contacts', auth, (req, res) => {
  const { inn, name, contactName, role, phone, comment } = req.body || {};
  const key = inn || name;
  if (!key) return res.status(400).json({ error: 'inn or name required' });
  if (!contactName && !phone) return res.status(400).json({ error: 'contactName or phone required' });

  if (!db.prepare('SELECT id FROM companies WHERE id = ?').get(key)) {
    db.prepare('INSERT INTO companies (id, inn, name) VALUES (?, ?, ?)').run(key, inn || null, name || null);
  }

  const info = db.prepare('INSERT INTO contacts (companyId, userId, name, role, phone, comment) VALUES (?, ?, ?, ?, ?, ?)')
    .run(key, req.user.id, contactName || '', role || '', phone || '', comment || '');

  res.status(201).json({ id: info.lastInsertRowid, companyId: key, name: contactName || '', role: role || '', phone: phone || '', comment: comment || '' });
});

router.delete('/company/contacts/:id', auth, (req, res) => {
  // Только свои контакты (старые общие, без userId, — может удалить админ).
  const info = db.prepare('DELETE FROM contacts WHERE id = ? AND (userId = ? OR (userId IS NULL AND ?))')
    .run(req.params.id, req.user.id, req.user.role === 'admin' ? 1 : 0);
  if (info.changes === 0) return res.status(404).json({ error: 'Не найдено' });
  res.json({ ok: true });
});

router.get('/favorites', auth, (req, res) => {
  const favorites = db.prepare('SELECT * FROM favorites WHERE userId = ?').all(req.user.id);
  res.json(favorites);
});

router.post('/favorites', auth, (req, res) => {
  const { inn, name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name обязателен' });

  try {
    db.prepare('INSERT OR IGNORE INTO favorites (userId, inn, name) VALUES (?, ?, ?)').run(req.user.id, inn || '', name);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/favorites', auth, (req, res) => {
  const { inn, name } = req.body || {};
  db.prepare('DELETE FROM favorites WHERE userId = ? AND inn = ? AND name = ?').run(req.user.id, inn || '', name);
  res.json({ ok: true });
});


module.exports = router;
