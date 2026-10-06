// Сводка объёмов для графика «Объёмы по декларациям» на главной: тонны по
// месяцу регистрации × регион × район × культура. Считается здесь, в отдельном
// потоке (проход по ~650 тыс. деклараций занимает секунды), и складывается в
// volume_monthly — запросы графика читают уже её и отвечают за миллисекунды.
//
// Рамочные декларации — «до 500 000 т» и т.п. — это лимиты трейдеров, а не
// партии: 0,4% деклараций дают треть суммарного объёма и превращают график в
// «урожай в пять раз больше страны». В тонны их не складываем, только считаем.
const { parentPort } = require('worker_threads');
const db = require('../services/db');
const { CROP_PATTERNS } = require('../services/cropPatterns');

const MAX_BATCH_TONS = 100000;
const FROM_DATE = '2021-01-01'; // раньше — единичные декларации без объёма

// LIKE-шаблоны из cropPatterns → проверка строки: '%x%' — содержит,
// 'x%' — начинается с, '% x%' — содержит « x».
const CROP_TESTS = Object.entries(CROP_PATTERNS).map(([key, pats]) => {
  const tests = pats.map(p => {
    const starts = !p.startsWith('%');
    const body = p.replace(/^%/, '').replace(/%$/, '');
    return s => (starts ? s.startsWith(body) : s.includes(body));
  });
  return [key, s => tests.some(t => t(s))];
});
function cropOf(productName) {
  const s = String(productName || '').toLowerCase();
  for (const [key, test] of CROP_TESTS) if (test(s)) return key;
  return 'other';
}

try {
  const t0 = Date.now();
  const agg = new Map();
  const rows = db.prepare(`
    SELECT substr(d.regDate, 1, 7) AS ym, d.batchTons AS tons, d.productName AS product,
           COALESCE(g.region, '') AS region, COALESCE(g.district, '') AS district
    FROM declarations d
    LEFT JOIN geo_places g ON g.key = d.placeKey
    WHERE d.regDate >= ?
  `).iterate(FROM_DATE);
  for (const r of rows) {
    const crop = cropOf(r.product);
    const k = `${r.ym}\u0001${r.region}\u0001${r.district}\u0001${crop}`;
    let a = agg.get(k);
    if (!a) { a = { ym: r.ym, region: r.region, district: r.district, crop, tons: 0, n: 0, big: 0 }; agg.set(k, a); }
    const t = Number(r.tons) || 0;
    if (t > MAX_BATCH_TONS) a.big++;
    else { a.tons += t; a.n++; }
  }

  const ins = db.prepare('INSERT INTO volume_monthly (ym, region, district, crop, tons, n, big) VALUES (@ym, @region, @district, @crop, @tons, @n, @big)');
  db.transaction(() => {
    db.prepare('DELETE FROM volume_monthly').run();
    for (const a of agg.values()) ins.run(a);
    db.prepare(`INSERT INTO volume_meta (id, builtAt, maxBatchTons) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET builtAt = excluded.builtAt, maxBatchTons = excluded.maxBatchTons`)
      .run(new Date().toISOString(), MAX_BATCH_TONS);
  })();
  parentPort.postMessage({ ok: true, rows: agg.size, ms: Date.now() - t0 });
} catch (e) {
  parentPort.postMessage({ error: e.message });
}
