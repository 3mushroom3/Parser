#!/usr/bin/env node
/**
 * Генерирует frontend/map/style-ru.json — стиль карты «База АПК».
 *
 * Берём бесплатный векторный стиль OpenFreeMap (Positron, тайлы OSM — работают
 * из России, без ключа и лимитов) и правим его под русскую версию карты:
 *
 *  1. Все подписи — из `name:ru`, а не двуязычные латиница+местный язык.
 *     Иначе Украина подписана «Україна», а ДНР/ЛНР — по-украински.
 *  2. Донецкая и Луганская области подписаны как ДНР/ЛНР: в OSM это ещё
 *     украинские области, своих названий у российских субъектов там нет.
 *  3. Крым и Севастополь: тайлы отдают спорные участки дважды — с
 *     `claimed_by=RU` и `claimed_by=UA`. Украинский вариант скрываем, а
 *     российский рисуем как внутреннюю границу региона (Крым в составе РФ,
 *     значит линия по Перекопу — межрегиональная, а не государственная).
 *     Дубль подписи «Автономна Республіка Крим» убираем, остаётся
 *     «Республика Крым».
 *  4. ДНР/ЛНР, Запорожская и Херсонская области: в OSM они внутри Украины и
 *     никак не помечены, поэтому границу правим своей геометрией из
 *     frontend/map/ru-border.geojson (см. build-ru-border.js).
 *  5. Спрайт (иконки) выкидываем вместе со слоями, которым он нужен: при
 *     `icon-optional: false` недоступный спрайт скрыл бы и сами подписи.
 *
 * Запуск (нужен интернет): node scripts/build-map-style.js
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const SRC = 'https://tiles.openfreemap.org/styles/positron';
const OUT = path.join(__dirname, '..', '..', 'frontend', 'map', 'style-ru.json');

// Подписи: русское название, дальше латиница и исходное как страховка.
const RU_TEXT = ['coalesce', ['get', 'name:ru'], ['get', 'name:latin'], ['get', 'name']];
// Регионы, у которых в OSM нет российского названия.
const RENAMED = {
  'Донецька область': 'Донецкая Народная Республика',
  'Луганська область': 'Луганская Народная Республика',
};
// Украинский дубль Крыма (российский называется «Республика Крым»).
const HIDDEN_LABEL = 'Автономна Республіка Крим';

const LAND_COLOR = 'rgb(242,243,240)'; // = background, им закрашиваем старую границу
const MASK_WIDTH = ['interpolate', ['linear'], ['zoom'], 3, 3.5, 5, 4, 12, 7];

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'zernovik-map-build/1.0' } }, res => {
      if (res.statusCode !== 200) return reject(new Error(`${url}: HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(new Error(`${url}: битый JSON`)); }
      });
    }).on('error', reject);
  });
}

(async () => {
  console.log('Загружаю', SRC);
  const style = await fetchJson(SRC);
  const layer = id => style.layers.find(l => l.id === id);

  const boundaryRegional = layer('boundary_3');
  const boundaryCountry  = layer('boundary_2');
  if (!boundaryRegional || !boundaryCountry || !layer('boundary_disputed')) {
    throw new Error('в стиле нет ожидаемых слоёв boundary_* — стиль изменился, скрипт надо править');
  }

  style.name = 'База АПК — русская версия';
  delete style.sprite;
  delete style.sources.ne2_shaded; // в Positron этот источник не используется

  // ── Спорные границы: российская трактовка ────────────────────────────────
  layer('boundary_disputed').filter = ['all',
    ['!=', ['get', 'maritime'], 1],
    ['==', ['get', 'disputed'], 1],
    // RU рисуем ниже как внутреннюю, UA не рисуем вовсе; чужие споры
    // (Кашмир, Западная Сахара) оставляем как было
    ['match', ['coalesce', ['get', 'claimed_by'], ''], ['RU', 'UA'], false, true],
  ];

  const ruInternal = {
    ...JSON.parse(JSON.stringify(boundaryRegional)),
    id: 'boundary_ru_internal',
    filter: ['all',
      ['!=', ['get', 'maritime'], 1],
      ['==', ['get', 'disputed'], 1],
      ['==', ['get', 'claimed_by'], 'RU'],
    ],
  };

  // ── Своя геометрия для новых регионов ────────────────────────────────────
  style.sources.ruborder = { type: 'geojson', data: '/map/ru-border.geojson' };
  const patch = [
    {
      // закрашиваем цветом суши старую границу РФ/Украины, потерявшую смысл
      id: 'ru_border_mask',
      type: 'line', source: 'ruborder',
      filter: ['==', ['get', 'kind'], 'mask'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': LAND_COLOR, 'line-width': MASK_WIDTH },
    },
    {
      // и рисуем её заново как границу между регионами РФ
      ...JSON.parse(JSON.stringify(boundaryRegional)),
      id: 'ru_border_regional',
      source: 'ruborder',
      filter: ['==', ['get', 'kind'], 'mask'],
    },
    {
      // новая госграница с Украиной
      ...JSON.parse(JSON.stringify(boundaryCountry)),
      id: 'ru_border_country',
      source: 'ruborder',
      filter: ['==', ['get', 'kind'], 'border'],
    },
  ];
  for (const l of patch) delete l['source-layer'];

  const at = style.layers.findIndex(l => l.id === 'boundary_disputed') + 1;
  style.layers.splice(at, 0, ruInternal, ...patch);

  // ── Подписи ──────────────────────────────────────────────────────────────
  let texts = 0, icons = 0;
  style.layers = style.layers.filter(l => {
    // слои, которые без спрайта не имеют смысла (иконки аэропортов, щитки дорог)
    const iconOnly = l.layout && l.layout['icon-image'] && !l.layout['text-field'];
    const shield = /shield/.test(l.id);
    if (iconOnly || shield) { icons++; return false; }
    return true;
  });
  for (const l of style.layers) {
    if (l.type !== 'symbol' || !l.layout) continue;
    for (const key of ['icon-image', 'icon-size', 'icon-optional', 'icon-allow-overlap', 'icon-anchor', 'icon-offset']) {
      delete l.layout[key];
    }
    if (!l.layout['text-field']) continue;
    const renamed = Object.entries(RENAMED).flat();
    l.layout['text-field'] = l['source-layer'] === 'place'
      ? ['match', ['coalesce', ['get', 'name'], ''], ...renamed, RU_TEXT]
      : RU_TEXT;
    texts++;
  }
  const state = layer('label_state');
  state.filter = ['all', ['==', ['get', 'class'], 'state'], ['!=', ['get', 'name'], HIDDEN_LABEL]];

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(style, null, 1));
  console.log(`Готово: ${OUT}`);
  console.log(`  слоёв ${style.layers.length}, подписей переведено ${texts}, слоёв со спрайтом удалено ${icons}, размер ${(fs.statSync(OUT).size / 1024).toFixed(0)} КБ`);
})().catch(e => { console.error('Ошибка:', e.message); process.exit(1); });
