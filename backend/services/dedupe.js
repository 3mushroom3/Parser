/**
 * Безопасное объединение дублей: одна и та же компания (имя+адрес) иногда
 * попадает в БД с ИНН в одних декларациях и без него в других — из-за этого
 * она отображается как два разных производителя. Если для пары имя+адрес
 * известен ровно один ИНН, проставляем его записям, где ИНН пуст.
 * Группы с несколькими РАЗНЫМИ ИНН на одно имя+адрес не трогаем — это может
 * быть смена ИНН или просто два разных юрлица по одному адресу.
 *
 * Точный адрес у ФСА часто отличается посимвольно между декларациями одной
 * и той же компании (разное написание "д." vs "дом", лишние пробелы и т.п.),
 * из-за чего точное совпадение имя+адрес не срабатывает. Второй проход
 * добавляет более мягкий ключ имя+почтовый индекс (первые 6 цифр в адресе)
 * для записей, которые первый проход не нашёл.
 */
const db = require('./db');

function extractPostalCode(address) {
  const m = (address || '').match(/\b(\d{6})\b/);
  return m ? m[1] : '';
}

function backfillMissingInn() {
  const rows = db.prepare(`
    SELECT id, inn,
      lower_u(TRIM(COALESCE(NULLIF(shortName,''), NULLIF(applicantName,''), lastName))) as nameKey,
      lower_u(TRIM(address)) as addrKey,
      address
    FROM declarations
  `).all();

  const exactGroups = new Map();
  const postalGroups = new Map();
  for (const r of rows) {
    if (!r.nameKey) continue;
    const inn = (r.inn || '').trim();

    const exactKey = r.nameKey + '||' + (r.addrKey || '');
    if (!exactGroups.has(exactKey)) exactGroups.set(exactKey, { innSet: new Set(), missingIds: [] });
    const eg = exactGroups.get(exactKey);
    if (inn) eg.innSet.add(inn); else eg.missingIds.push(r.id);

    const postal = extractPostalCode(r.address);
    if (postal) {
      const postalKey = r.nameKey + '||' + postal;
      if (!postalGroups.has(postalKey)) postalGroups.set(postalKey, { innSet: new Set(), missingIds: [] });
      const pg = postalGroups.get(postalKey);
      if (inn) pg.innSet.add(inn); else pg.missingIds.push(r.id);
    }
  }

  const update = db.prepare('UPDATE declarations SET inn = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?');
  let updated = 0;
  const resolvedIds = new Set();
  const tx = db.transaction(() => {
    for (const g of exactGroups.values()) {
      if (g.innSet.size === 1 && g.missingIds.length > 0) {
        const [inn] = g.innSet;
        for (const id of g.missingIds) { update.run(inn, id); resolvedIds.add(id); updated++; }
      }
    }
    for (const g of postalGroups.values()) {
      if (g.innSet.size !== 1) continue;
      const [inn] = g.innSet;
      for (const id of g.missingIds) {
        if (resolvedIds.has(id)) continue;
        update.run(inn, id);
        resolvedIds.add(id);
        updated++;
      }
    }
  });
  tx();
  return updated;
}

// Группы, где одно и то же название+адрес встречается с несколькими РАЗНЫМИ
// ИНН — авто-слияние тут не делаем (могло быть переоформление компании на
// новый ИНН, или просто два разных юрлица по одному адресу), но показываем
// администратору отчёт для ручного решения (см. resolveAmbiguousGroup/
// dismissAmbiguousGroup ниже).
function findAmbiguousInnGroups() {
  const ignored = new Set(
    db.prepare('SELECT nameKey, addrKey FROM dedupe_ignored').all().map(r => r.nameKey + '||' + r.addrKey)
  );

  const rows = db.prepare(`
    SELECT id, inn, declNumber,
      TRIM(COALESCE(NULLIF(shortName,''), NULLIF(applicantName,''), lastName)) as name,
      TRIM(address) as address,
      lower_u(TRIM(COALESCE(NULLIF(shortName,''), NULLIF(applicantName,''), lastName))) as nameKey,
      lower_u(TRIM(address)) as addrKey
    FROM declarations
    WHERE inn != '' AND inn IS NOT NULL
  `).all();

  const groups = new Map();
  for (const r of rows) {
    if (!r.nameKey) continue;
    const key = r.nameKey + '||' + (r.addrKey || '');
    if (ignored.has(key)) continue;
    if (!groups.has(key)) groups.set(key, { nameKey: r.nameKey, addrKey: r.addrKey || '', name: r.name, address: r.address, innCounts: new Map() });
    const g = groups.get(key);
    const inn = r.inn.trim();
    g.innCounts.set(inn, (g.innCounts.get(inn) || 0) + 1);
  }

  const ambiguous = [];
  for (const g of groups.values()) {
    if (g.innCounts.size > 1) {
      ambiguous.push({
        nameKey: g.nameKey,
        addrKey: g.addrKey,
        name: g.name,
        address: g.address,
        inns: [...g.innCounts.entries()].map(([inn, count]) => ({ inn, count })).sort((a, b) => b.count - a.count),
      });
    }
  }
  return ambiguous.sort((a, b) => b.inns.length - a.inns.length);
}

// Админ вручную выбрал, какой ИНН правильный для группы имя+адрес —
// проставляем его всем записям группы (включая те, что уже имели другой ИНН).
function resolveAmbiguousGroup(nameKey, addrKey, chosenInn) {
  if (!nameKey || !chosenInn) return 0;
  const info = db.prepare(`
    UPDATE declarations SET inn = ?, updatedAt = CURRENT_TIMESTAMP
    WHERE lower_u(TRIM(COALESCE(NULLIF(shortName,''), NULLIF(applicantName,''), lastName))) = ?
      AND lower_u(TRIM(address)) = ?
  `).run(chosenInn, nameKey, addrKey || '');
  return info.changes;
}

// Админ решил, что это НЕ дубль (два разных юрлица по одному адресу/одинаковым
// названием) — больше не показываем эту пару в отчёте.
function dismissAmbiguousGroup(nameKey, addrKey) {
  if (!nameKey) return;
  db.prepare('INSERT OR IGNORE INTO dedupe_ignored (nameKey, addrKey) VALUES (?, ?)').run(nameKey, addrKey || '');
}

module.exports = { backfillMissingInn, findAmbiguousInnGroups, resolveAmbiguousGroup, dismissAmbiguousGroup };
