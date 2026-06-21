/**
 * Безопасное объединение дублей: одна и та же компания (имя+адрес) иногда
 * попадает в БД с ИНН в одних декларациях и без него в других — из-за этого
 * она отображается как два разных производителя. Если для пары имя+адрес
 * известен ровно один ИНН, проставляем его записям, где ИНН пуст.
 * Группы с несколькими РАЗНЫМИ ИНН на одно имя+адрес не трогаем — это может
 * быть смена ИНН или просто два разных юрлица по одному адресу.
 */
const db = require('./db');

function backfillMissingInn() {
  const rows = db.prepare(`
    SELECT id, inn,
      lower_u(TRIM(COALESCE(NULLIF(shortName,''), NULLIF(applicantName,''), lastName))) as nameKey,
      lower_u(TRIM(address)) as addrKey
    FROM declarations
  `).all();

  const groups = new Map();
  for (const r of rows) {
    if (!r.nameKey) continue;
    const key = r.nameKey + '||' + (r.addrKey || '');
    if (!groups.has(key)) groups.set(key, { innSet: new Set(), missingIds: [] });
    const g = groups.get(key);
    const inn = (r.inn || '').trim();
    if (inn) g.innSet.add(inn);
    else g.missingIds.push(r.id);
  }

  const update = db.prepare('UPDATE declarations SET inn = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?');
  let updated = 0;
  const tx = db.transaction(() => {
    for (const g of groups.values()) {
      if (g.innSet.size === 1 && g.missingIds.length > 0) {
        const [inn] = g.innSet;
        for (const id of g.missingIds) { update.run(inn, id); updated++; }
      }
    }
  });
  tx();
  return updated;
}

// Группы, где одно и то же название+адрес встречается с несколькими РАЗНЫМИ
// ИНН — авто-слияние тут не делаем (могло быть переоформление компании на
// новый ИНН, или просто два разных юрлица по одному адресу), но показываем
// администратору отчёт для ручного решения.
function findAmbiguousInnGroups() {
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
    if (!groups.has(key)) groups.set(key, { name: r.name, address: r.address, innCounts: new Map() });
    const g = groups.get(key);
    const inn = r.inn.trim();
    g.innCounts.set(inn, (g.innCounts.get(inn) || 0) + 1);
  }

  const ambiguous = [];
  for (const g of groups.values()) {
    if (g.innCounts.size > 1) {
      ambiguous.push({
        name: g.name,
        address: g.address,
        inns: [...g.innCounts.entries()].map(([inn, count]) => ({ inn, count })).sort((a, b) => b.count - a.count),
      });
    }
  }
  return ambiguous.sort((a, b) => b.inns.length - a.inns.length);
}

module.exports = { backfillMissingInn, findAmbiguousInnGroups };
