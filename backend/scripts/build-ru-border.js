#!/usr/bin/env node
/**
 * Генерирует frontend/map/ru-border.geojson — «заплатку» госграницы для карты
 * в российской версии (Крым, Севастополь, ДНР, ЛНР, Запорожская и Херсонская
 * области в составе РФ).
 *
 * Векторные тайлы OpenFreeMap (OSM) размечают Крым через `claimed_by=RU/UA` —
 * это лечится фильтром в стиле (см. build-map-style.js). А четыре новых региона
 * в OSM всё ещё внутри отношения Украины (admin_level=2) и никак не помечены,
 * поэтому их границу приходится править своей геометрией:
 *
 *   kind=border — новая госграница: участки, общие у новых регионов с
 *                 Харьковской, Днепропетровской и Николаевской областями;
 *   kind=mask   — потерявший смысл участок старой границы РФ/Украины
 *                 (Ростовская, Воронежская, Белгородская обл.) — в стиле он
 *                 закрашивается цветом суши и рисуется заново как внутренняя
 *                 межрегиональная граница.
 *
 * Геометрию берём не из Natural Earth, а из самих OSM-ways: соседние регионы в
 * OSM делят одни и те же way, поэтому линия совпадает с тайлами до метра —
 * маска накрывает линию тайла на любом зуме.
 *
 * Запуск (нужен интернет, ~1 минута): node scripts/build-ru-border.js
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const OUT = path.join(__dirname, '..', '..', 'frontend', 'map', 'ru-border.geojson');

// id отношений OSM (admin_level=4). Для Крыма и Севастополя берём российские
// отношения (claimed_by=RU), а не украинские.
const GROUPS = {
  annexed: { 3795586: 'Республика Крым', 3788485: 'Севастополь', 71973: 'Донецкая', 71971: 'Луганская', 71980: 'Запорожская', 71022: 'Херсонская' },
  ukraine: { 71254: 'Харьковская', 101746: 'Днепропетровская', 72635: 'Николаевская' },
  russia:  { 85606: 'Ростовская', 72181: 'Воронежская', 83184: 'Белгородская', 108082: 'Краснодарский' },
};

const MIRRORS = ['overpass-api.de', 'overpass.kumi.systems', 'overpass.osm.jp'];

function request(host, query) {
  const data = 'data=' + encodeURIComponent(query);
  return new Promise((resolve, reject) => {
    const req = https.request({
      host, path: '/api/interpreter', method: 'POST', timeout: 300000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'zernovik-map-build/1.0', // без него Overpass отвечает 406
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        if (res.statusCode !== 200) return reject(new Error(`${host}: HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (_) { reject(new Error(`${host}: битый JSON`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${host}: таймаут`)));
    req.on('error', reject);
    req.end(data);
  });
}

// Публичные зеркала Overpass регулярно отдают 429/504 — перебираем по кругу.
async function overpass(query) {
  let last;
  for (let attempt = 0; attempt < 6; attempt++) {
    const host = MIRRORS[attempt % MIRRORS.length];
    try { return await request(host, query); }
    catch (e) { last = e; console.log('  повтор:', e.message); await new Promise(r => setTimeout(r, 4000)); }
  }
  throw last;
}

// wayId -> [названия регионов группы, в которые way входит]
function wayIndex(group) {
  const index = new Map();
  for (const { label, ways } of Object.values(group)) {
    for (const way of ways) {
      if (!index.has(way)) index.set(way, []);
      index.get(way).push(label);
    }
  }
  return index;
}

// Склеивает ways в длинные линии по совпадающим концам: меньше фич в файле и
// ровнее стыки при рендере.
function stitch(lines) {
  const key = p => p[0] + ',' + p[1];
  const pool = lines.slice();
  const out = [];
  while (pool.length) {
    let cur = pool.pop();
    for (let grew = true; grew;) {
      grew = false;
      for (let i = 0; i < pool.length; i++) {
        const c = pool[i];
        if      (key(c[0])            === key(cur[cur.length - 1])) cur = cur.concat(c.slice(1));
        else if (key(c[c.length - 1]) === key(cur[0]))              cur = c.concat(cur.slice(1));
        else if (key(c[c.length - 1]) === key(cur[cur.length - 1])) cur = cur.concat(c.slice().reverse().slice(1));
        else if (key(c[0])            === key(cur[0]))              cur = c.slice().reverse().concat(cur.slice(1));
        else continue;
        pool.splice(i, 1);
        grew = true;
        break;
      }
    }
    out.push(cur);
  }
  return out;
}

(async () => {
  const ids = Object.values(GROUPS).flatMap(g => Object.keys(g));
  console.log('Загружаю состав отношений OSM...');
  const relResp = await overpass(`[out:json][timeout:180];rel(id:${ids.join(',')});out body;`);
  const byId = new Map(relResp.elements.map(e => [String(e.id), e]));

  const groups = {};
  for (const [name, members] of Object.entries(GROUPS)) {
    groups[name] = {};
    for (const [id, label] of Object.entries(members)) {
      const rel = byId.get(id);
      if (!rel) throw new Error(`отношение ${id} (${label}) не найдено`);
      // role=subarea и прочие вложенные отношения — не геометрия границы
      const ways = rel.members.filter(m => m.type === 'way' && (m.role === 'outer' || m.role === '')).map(m => m.ref);
      if (!ways.length) throw new Error(`у отношения ${id} (${label}) нет ways`);
      groups[name][id] = { label, ways };
    }
  }

  const annexed = wayIndex(groups.annexed);
  const ukraine = wayIndex(groups.ukraine);
  const russia  = wayIndex(groups.russia);
  const shared  = (a, b) => [...a.keys()].filter(w => b.has(w));
  const parts = { border: shared(annexed, ukraine), mask: shared(annexed, russia) };
  console.log(`Общих ways: новая граница ${parts.border.length}, старая (под маску) ${parts.mask.length}`);
  if (!parts.border.length || !parts.mask.length) throw new Error('не нашлись общие ways — проверьте id отношений');

  const all = [...new Set([...parts.border, ...parts.mask])];
  const geom = new Map();
  for (let i = 0; i < all.length; i += 200) {
    const chunk = all.slice(i, i + 200);
    console.log(`Загружаю геометрию ${i + 1}–${i + chunk.length} из ${all.length}...`);
    const resp = await overpass(`[out:json][timeout:180];way(id:${chunk.join(',')});out geom;`);
    for (const e of resp.elements) if (e.type === 'way') geom.set(e.id, e);
  }

  const round = v => Math.round(v * 1e5) / 1e5; // ~1 м, точнее рендера не нужно
  const features = [];
  let dropped = 0;
  for (const [kind, wayIds] of Object.entries(parts)) {
    const lines = [];
    for (const id of wayIds) {
      const way = geom.get(id);
      if (!way || !way.geometry) continue;
      const tags = way.tags || {};
      // морские участки (Азов, Керченский пролив) стиль не рисует — маска по
      // воде была бы видна светлой полосой, поэтому выбрасываем
      if (tags.maritime === 'yes' || tags.natural === 'coastline') { dropped++; continue; }
      lines.push(way.geometry.map(p => [round(p.lon), round(p.lat)]));
    }
    for (const coordinates of stitch(lines)) {
      features.push({ type: 'Feature', properties: { kind }, geometry: { type: 'LineString', coordinates } });
    }
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ type: 'FeatureCollection', features }));
  const points = features.reduce((s, f) => s + f.geometry.coordinates.length, 0);
  console.log(`Готово: ${OUT}`);
  console.log(`  линий ${features.length}, точек ${points}, морских ways отброшено ${dropped}, размер ${(fs.statSync(OUT).size / 1024).toFixed(0)} КБ`);
})().catch(e => { console.error('Ошибка:', e.message); process.exit(1); });
