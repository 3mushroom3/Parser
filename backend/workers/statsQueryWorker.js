// /api/system/stats считает 8 агрегатов (несколько COUNT(DISTINCT CASE/
// COALESCE...), пару GROUP BY) по всей таблице declarations — на 4.9M строк
// синхронно на основном потоке это отняло у event loop десятки секунд разом,
// вешая заодно и все остальные запросы (better-sqlite3 синхронный). Как и
// producersQueryWorker.js — считаем в отдельном потоке, чтобы это никого
// не блокировало.
const { parentPort } = require('worker_threads');
const db = require('../services/db');

try {
  const { uniqueProducers } = db.prepare(`
    SELECT COUNT(DISTINCT CASE
      WHEN inn IS NOT NULL AND inn != '' THEN inn
      ELSE COALESCE(NULLIF(shortName, ''), NULLIF(applicantName, ''), lastName)
    END) as uniqueProducers
    FROM declarations
  `).get();

  const statusStats = db.prepare('SELECT status, COUNT(*) as count FROM declarations GROUP BY status').all();
  const sourceStats = db.prepare('SELECT source, COUNT(*) as count FROM declarations GROUP BY source').all();

  const producerCountByType = (type) => {
    const types = type === 'farmer' ? "'farmer','farmer_trader'"
                : type === 'trader' ? "'trader','trader_farmer'"
                : `'${type}'`;
    return db.prepare(`
      SELECT COUNT(DISTINCT COALESCE(NULLIF(inn, ''), COALESCE(NULLIF(shortName, ''), NULLIF(applicantName, ''), lastName))) as c
      FROM declarations WHERE farmerType IN (${types}) AND status = 'active'
    `).get().c;
  };
  const declCountByType = (type) => {
    const types = type === 'farmer' ? "'farmer','farmer_trader'"
                : type === 'trader' ? "'trader','trader_farmer'"
                : `'${type}'`;
    return db.prepare(`SELECT COUNT(*) as c FROM declarations WHERE farmerType IN (${types}) AND status = 'active'`).get().c;
  };
  const producerCountByStatus = (status) => db.prepare(`
    SELECT COUNT(DISTINCT COALESCE(NULLIF(inn, ''), COALESCE(NULLIF(shortName, ''), NULLIF(applicantName, ''), lastName))) as c
    FROM declarations WHERE status = ?
  `).get(status).c;

  const activeDecls = statusStats.find(s => s.status === 'active')?.count || 0;
  const totalDecls = statusStats.reduce((sum, s) => sum + s.count, 0);

  const stats = {
    total: uniqueProducers,
    totalDecls,
    active: activeDecls,
    activeProducers: producerCountByStatus('active'),
    suspended: statusStats.find(s => s.status === 'suspended')?.count || 0,
    expired: statusStats.find(s => s.status === 'expired')?.count || 0,
    manual: sourceStats.find(s => s.source === 'manual')?.count || 0,
    fsa: sourceStats.find(s => s.source === 'fsa')?.count || 0,
    farmerProducers: producerCountByType('farmer'),
    traderProducers: producerCountByType('trader'),
    farmerDecls: declCountByType('farmer'),
    traderDecls: declCountByType('trader'),
  };

  parentPort.postMessage({ stats });
} catch (err) {
  parentPort.postMessage({ error: err.message });
}
