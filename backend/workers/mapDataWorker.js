const { parentPort } = require('worker_threads');
const db = require('../services/db');

const MAX_ORGS_PER_CITY = 50;
const CHUNK = 5000;

function extractCity(address) {
  if (!address) return null;
  const m = address.match(/(?:^|[,;\s])([Гг])(?:\.о?\.?\s*|\s+)([А-ЯЁа-яё][А-ЯЁа-яё\-]+(?:\s+[А-ЯЁа-яё][А-ЯЁа-яё\-]+)*)/);
  if (m) return m[2].split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  return null;
}

try {
  const stmt = db.prepare(
    "SELECT id, address, shortName, applicantName, lastName, inn, farmerType, productName " +
    "FROM declarations WHERE status = 'active' AND address IS NOT NULL AND address != ''"
  );

  const cityMap = {};
  let processed = 0;

  for (const rec of stmt.iterate()) {
    const city = extractCity(rec.address);
    if (!city) continue;

    if (!cityMap[city]) cityMap[city] = { city, count: 0, farmers: 0, traders: 0, orgs: {}, orgCount: 0 };
    cityMap[city].count++;

    if (rec.farmerType === 'farmer' || rec.farmerType === 'farmer_trader') cityMap[city].farmers++;
    else if (rec.farmerType === 'trader' || rec.farmerType === 'trader_farmer') cityMap[city].traders++;

    const key = (rec.shortName || rec.applicantName || rec.lastName || '—').trim();
    if (!cityMap[city].orgs[key]) {
      if (cityMap[city].orgCount >= MAX_ORGS_PER_CITY) continue;
      cityMap[city].orgs[key] = { name: key, inn: rec.inn || '', farmerType: rec.farmerType || 'unknown', decls: [] };
      cityMap[city].orgCount++;
    }
    if (cityMap[city].orgs[key].decls.length < 20) {
      cityMap[city].orgs[key].decls.push({ id: rec.id, product: (rec.productName || '').slice(0, 60) });
    }
  }

  const cities = Object.values(cityMap)
    .map(c => ({
      city: c.city,
      count: c.count,
      farmers: c.farmers,
      traders: c.traders,
      orgs: Object.values(c.orgs)
        .sort((a, b) => b.decls.length - a.decls.length)
        .slice(0, 30)
        .map(o => ({ name: o.name, inn: o.inn, farmerType: o.farmerType, count: o.decls.length, decls: o.decls })),
    }))
    .sort((a, b) => b.count - a.count);

  parentPort.postMessage({ cities, total: cities.reduce((s, c) => s + c.count, 0) });
} catch (err) {
  parentPort.postMessage({ error: err.message });
}
