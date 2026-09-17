/**
 * Координаты населённого пункта по строке адреса.
 *
 * Источник — DaData (тот же токен, что и для ОКВЭД в fnsClient.js):
 * `suggest/address` отдаёт geo_lat/geo_lon и не требует платного тарифа.
 * Бесплатный лимит — 10 000 запросов в сутки, поэтому геокодер вызывают только
 * из фонового задания с суточным бюджетом (services/geoEnricher.js), а сами
 * координаты кешируются в таблице geo_places навсегда.
 *
 * qc_geo — точность: 0 дом, 1 ближайший дом, 2 улица, 3 населённый пункт,
 * 4 город, 5 координаты не определены. Ориентироваться надо на наличие
 * geo_lat/geo_lon, а не на qc: у городов qc=4 при совершенно корректных
 * координатах, и фильтр «всё кроме 4» выбрасывал как раз крупнейшие точки карты.
 */
const axios = require('axios');

const DADATA_TOKEN = process.env.DADATA_TOKEN || 'f2ffe0e5102a973aab6d4447ce92a3583b50f734';
const SUGGEST_URL = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address';

const ACCURACY = { '0': 'house', '1': 'house', '2': 'street', '3': 'settlement', '4': 'city' };

const HTTP = axios.create({
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Token ${DADATA_TOKEN}`,
  },
  validateStatus: () => true,
});

class RateLimitError extends Error {}

/**
 * Возвращает { lat, lon, accuracy, matched } или null, если адрес не найден.
 * Бросает RateLimitError на 429/403 — задание должно остановиться до завтра,
 * а не выжигать остаток лимита впустую.
 *
 * from/to ограничивают уровень ответа (город…населённый пункт — улицы и дома
 * нам не нужны); без них DaData ищет свободно, и это запасной вариант для НП,
 * которых в справочнике нет.
 */
async function geocode(query, { from = null, to = null, count = 3 } = {}) {
  if (!query) return null;
  const body = { query, count };
  if (from) body.from_bound = { value: from };
  if (to) body.to_bound = { value: to };
  const res = await HTTP.post(SUGGEST_URL, body);

  if (res.status === 429 || res.status === 403) {
    throw new RateLimitError(`DaData ответила ${res.status} — суточный лимит или блокировка токена`);
  }
  if (res.status !== 200) throw new Error(`DaData HTTP ${res.status}`);

  // берём первую подсказку с координатами: у точного совпадения их иногда нет
  // (например, у района как такового), зато есть у следующей — его центра
  for (const item of (res.data && res.data.suggestions) || []) {
    const d = item.data || {};
    if (d.geo_lat == null || d.geo_lon == null) continue;
    return {
      lat: Number(d.geo_lat),
      lon: Number(d.geo_lon),
      accuracy: ACCURACY[String(d.qc_geo)] || 'settlement',
      matched: item.value || '',
    };
  }
  return null;
}

module.exports = { geocode, RateLimitError };
