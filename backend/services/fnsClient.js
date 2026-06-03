/**
 * Получение ОКВЭД компании.
 *
 * Основной источник: dadata.ru (10 000 запросов/день, требует токен).
 * Запасной источник: egrul.itsoft.ru/{INN}.json — ~145 запросов/день, без токена.
 * Поиск по имени: egrul.nalog.ru → ИНН → dadata/itsoft.
 */
const axios = require('axios');

const DADATA_TOKEN = process.env.DADATA_TOKEN || 'f2ffe0e5102a973aab6d4447ce92a3583b50f734';

const FARMER_PREFIXES = ['01.'];
const TRADER_PREFIXES = ['46.', '47.', '51.', '52.'];

const HTTP = axios.create({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json, */*',
  },
  timeout: 15000,
  validateStatus: () => true,
});

// Клиент для dadata.ru
const HTTP_DADATA = axios.create({
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `Token ${DADATA_TOKEN}`,
  },
  timeout: 10000,
  validateStatus: () => true,
});

// Клиент для egrul.nalog.ru (поиск по имени)
const HTTP_NALOG = axios.create({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'ru-RU,ru;q=0.9',
    'Referer': 'https://egrul.nalog.ru/',
    'X-Requested-With': 'XMLHttpRequest',
  },
  timeout: 20000,
  validateStatus: () => true,
});

// Сессия egrul.nalog.ru (переиспользуется для поиска по имени)
let _sessionCookie = null;
let _sessionExpiry = 0;
const SESSION_TTL_MS = 8 * 60 * 1000;

async function getSession() {
  if (_sessionCookie && Date.now() < _sessionExpiry) return _sessionCookie;
  const resp = await HTTP_NALOG.get('https://egrul.nalog.ru/index.html');
  const setCookie = resp.headers['set-cookie'] || [];
  const jsession = setCookie.find(c => c.startsWith('JSESSIONID='));
  if (!jsession) throw new Error('[FNS] Не удалось получить JSESSIONID');
  _sessionCookie = jsession.split(';')[0];
  _sessionExpiry = Date.now() + SESSION_TTL_MS;
  return _sessionCookie;
}

function invalidateSession() { _sessionCookie = null; _sessionExpiry = 0; }

/**
 * Классификация по ОКВЭД.
 * Если основной — торговля, но среди дополнительных есть 01.xx — считаем фермером.
 */
function classifyOkved(primaryOkved, extraOkveds = []) {
  const extras = extraOkveds.filter(Boolean).map(s => String(s).trim());
  const primary = String(primaryOkved || '').trim();
  const all = [primary, ...extras].filter(Boolean);
  if (!all.length) return 'unknown';

  const isFarmer = c => FARMER_PREFIXES.some(p => c.startsWith(p));
  const isTrader = c => TRADER_PREFIXES.some(p => c.startsWith(p));

  if (isFarmer(primary)) return 'farmer';
  if (isTrader(primary) && all.some(isFarmer)) return 'farmer';
  if (isTrader(primary)) return 'trader';
  if (all.some(isFarmer)) return 'farmer';
  if (all.some(isTrader)) return 'trader';
  return 'unknown';
}

/**
 * Извлекает ОКВЭД из JSON egrul.itsoft.ru.
 * Структура: {"СвЮЛ": {"СвОКВЭД": {"СвОКВЭДОсн": {"@attributes": {"КодОКВЭД": "..."}}}}}
 * Также поддерживает старый формат egrul.nalog.ru (без @attributes).
 */
function extractOkvedsFromJson(data) {
  // ЮЛ: СвЮЛ.СвОКВЭД, ИП: СвИП.СвОКВЭД (на itsoft.ru)
  const root = data?.СвЮЛ || data?.СвИП || data?.data || data?.record || data;
  const svOkved = root?.СвОКВЭД;
  if (!svOkved) return { primary: '', extras: [] };

  const osnBlock = svOkved.СвОКВЭДОсн || {};
  // egrul.itsoft.ru упаковывает атрибуты в @attributes
  const primary = String(
    osnBlock?.['@attributes']?.КодОКВЭД || osnBlock?.КодОКВЭД || ''
  ).trim();

  const dopRaw = svOkved.СвОКВЭДДоп || [];
  const dopArr = Array.isArray(dopRaw) ? dopRaw : [dopRaw];
  const extras = dopArr
    .map(d => String(d?.['@attributes']?.КодОКВЭД || d?.КодОКВЭД || '').trim())
    .filter(Boolean);

  return { primary, extras };
}

// Специальный sentinel — источник вернул 429, не кэшировать
const RATE_LIMITED = Symbol('RATE_LIMITED');

/**
 * Получить ОКВЭД по ИНН через dadata.ru (основной источник, 10k/день).
 */
async function fetchOkvedFromDadata(inn) {
  if (!DADATA_TOKEN) return null;
  const resp = await HTTP_DADATA.post(
    'https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party',
    { query: inn, count: 1 }
  );
  if (resp.status === 429) return RATE_LIMITED;
  if (resp.status !== 200) {
    if (resp.status !== 404) console.warn(`[FNS] dadata ${inn} → ${resp.status}`);
    return null;
  }
  const suggestions = resp.data?.suggestions;
  if (!suggestions || !suggestions.length) return null;

  const data = suggestions[0]?.data;
  if (!data) return null;

  const primary = String(data.okved || '').trim();
  const extras = (data.okveds || [])
    .filter(o => !o.main)
    .map(o => String(o.code || '').trim())
    .filter(Boolean);
  const name = data.name?.short_with_opf || data.name?.full_with_opf || '';

  if (primary) {
    console.log(`[FNS] dadata ИНН ${inn}: осн=${primary}, доп.(${extras.length})`);
  }
  return { name, okved: primary, okveds: extras, inn };
}

/**
 * Поиск по названию через dadata.ru suggest/party.
 * Возвращает данные (с ИНН и ОКВЭД) или null.
 */
async function findByNameDadata(name) {
  if (!DADATA_TOKEN) return null;
  const resp = await HTTP_DADATA.post(
    'https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/party',
    { query: name, count: 5 }
  );
  if (resp.status === 429) return RATE_LIMITED;
  if (resp.status !== 200) return null;

  const suggestions = resp.data?.suggestions;
  if (!suggestions || !suggestions.length) return null;

  // Нормализация для сравнения
  const normalize = s => s.toLowerCase().replace(/["\s«»()]/g, '').replace(/^(ооо|оао|зао|пао|ао|ип|кфх|сха|схп)/, '');
  const nameLower = normalize(name);
  const match =
    suggestions.find(s => normalize(s.value) === nameLower) ||
    suggestions.find(s => nameLower.length > 5 && normalize(s.value).includes(nameLower)) ||
    suggestions[0];

  const data = match?.data;
  if (!data) return null;

  const primary = String(data.okved || '').trim();
  const extras = (data.okveds || [])
    .filter(o => !o.main)
    .map(o => String(o.code || '').trim())
    .filter(Boolean);
  const foundInn = String(data.inn || '').trim();
  const foundName = data.name?.short_with_opf || match.value || '';

  if (foundInn) console.log(`[FNS] dadata name:"${name.slice(0,30)}" → ИНН:${foundInn} осн=${primary||'?'}`);
  return { name: foundName, okved: primary, okveds: extras, inn: foundInn };
}

/**
 * Получить ОКВЭД по ИНН напрямую с egrul.itsoft.ru.
 * Возвращает null (не найден/ошибка), RATE_LIMITED (429), или объект с данными.
 */
async function fetchOkvedFromItsoft(inn) {
  const resp = await HTTP.get(`https://egrul.itsoft.ru/${inn}.json`);
  if (resp.status === 429) return RATE_LIMITED;
  if (resp.status !== 200) {
    if (resp.status !== 404) console.warn(`[FNS] itsoft ${inn} → ${resp.status}`);
    return null;
  }
  const data = resp.data;
  if (!data || typeof data !== 'object') return null;

  const { primary, extras } = extractOkvedsFromJson(data);

  // Имя компании
  const юл = data?.СвЮЛ;
  const ип = data?.СвИП;
  const name =
    юл?.СвНаимЮЛ?.['@attributes']?.НаимЮЛПолн ||
    юл?.СвНаимЮЛ?.НаимЮЛПолн ||
    ип?.СвФЛ?.['@attributes']?.Фамилия ||
    '';

  if (primary) {
    console.log(`[FNS] ИНН ${inn}: основной=${primary}, доп.(${extras.length})=[${extras.slice(0, 3).join(', ')}${extras.length > 3 ? '...' : ''}]`);
  }

  return { name, okved: primary, okveds: extras, inn };
}

/**
 * Поиск ИНН по имени через egrul.nalog.ru.
 * Возвращает ИНН или null.
 */
async function findInnByName(name) {
  const cookie = await getSession();

  const r1 = await HTTP_NALOG.post(
    'https://egrul.nalog.ru/',
    new URLSearchParams({ query: name, region: '', PreventChromeAutocomplete: '' }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie } }
  );

  if (r1.status === 401 || r1.status === 403) { invalidateSession(); return null; }
  if (r1.status !== 200 || r1.data?.captchaRequired) return null;

  const searchToken = r1.data?.t;
  if (!searchToken) return null;

  await new Promise(r => setTimeout(r, 700));
  const r2 = await HTTP_NALOG.get(
    `https://egrul.nalog.ru/search-result/${searchToken}`,
    { headers: { Cookie: cookie } }
  );
  if (r2.status !== 200) return null;

  const rows = r2.data?.rows || [];
  if (!rows.length) return null;

  // Нормализация для сравнения
  const normalize = s => s.toLowerCase().replace(/["\s«»()]/g, '').replace(/^(ооо|оао|зао|пао|ао|ип|кфх|сха|схп)/, '');
  const nameLower = normalize(name);

  const match =
    rows.find(r => normalize(r.n || r.c || '') === nameLower) ||
    rows.find(r => nameLower.length > 5 && normalize(r.n || r.c || '').includes(nameLower)) ||
    rows.find(r => {
      const key = nameLower.replace(/\s/g, '');
      const rn = normalize(r.n || r.c || '').replace(/\s/g, '');
      return key.length > 6 && rn.includes(key.slice(0, Math.min(key.length, 10)));
    });

  if (!match) return null;

  const inn = String(match.i || '').trim();
  if (!/^\d{10}(\d{2})?$/.test(inn)) return null;

  console.log(`[FNS] name:"${name.slice(0, 30)}" → ИНН:${inn} ("${(match.n || '').slice(0, 30)}")`);
  return inn;
}

/**
 * Классификация по названию компании — запасной вариант когда нет ОКВЭД.
 * Использует ключевые слова в названии на русском языке.
 */
// \b не работает с кириллицей в JS — используем lookahead/lookbehind
const RU = '[А-ЯЁа-яёA-Za-z0-9]'; // "буква или цифра" — для имитации \b

function cyWord(abbr) {
  // Возвращает RegExp: аббревиатура не окружена буквами/цифрами
  return new RegExp(`(?<!${RU})${abbr}(?!${RU})`);
}

function classifyByName(name) {
  if (!name) return 'unknown';
  const n = name.toUpperCase().replace(/[«»"']/g, '"');

  // ── Фермеры ────────────────────────────────────────────────
  // КФХ / К(Ф)Х / К/Х / К.Х. / КХ / ФХ
  if (cyWord('КФХ').test(n)) return 'farmer';
  if (/К\s*\(Ф\)\s*Х/.test(n)) return 'farmer';
  if (/К\s*\/\s*Х/.test(n)) return 'farmer';
  if (/К\.Х\./.test(n)) return 'farmer';
  if (cyWord('КХ').test(n)) return 'farmer';
  if (cyWord('ФХ').test(n)) return 'farmer';
  // Глава КФХ / Глава К(Ф)Х / Глава крестьянского
  if (/ГЛАВА\s+(КФХ|К\(Ф\)|КРЕСТЬЯНСК)/.test(n)) return 'farmer';
  // Крестьянское, фермерское хозяйство
  if (/КРЕСТЬЯНСКО|ФЕРМЕРСК/.test(n)) return 'farmer';
  // Колхоз, совхоз
  if (/КОЛХОЗ|СОВХОЗ/.test(n)) return 'farmer';
  // СПК / СХПК / СПСК / СПХ / СХА / СХП — кооперативы
  if (cyWord('СПК').test(n)) return 'farmer';
  if (cyWord('СХПК').test(n)) return 'farmer';
  if (cyWord('СПСК').test(n)) return 'farmer';
  if (cyWord('СПХ').test(n)) return 'farmer';
  if (cyWord('СХА').test(n)) return 'farmer';
  if (cyWord('СХП').test(n)) return 'farmer';
  // Агрофирма / Агрокомплекс / Агрохозяйство / Агропредприятие
  if (/АГРОФИРМ|АГРОКОМПЛЕКС|АГРОХОЗЯЙСТВ|АГРОПРЕДПРИЯТИЕ/.test(n)) return 'farmer';
  // АФ "..." — агрофирма сокращённо
  if (/(?<![А-ЯЁа-яё])АФ\s+"/.test(n)) return 'farmer';
  // КХ "..." или КХ [буква] — уже покрыто cyWord('КХ'), но добавим контекст
  if (/(?<![А-ЯЁа-яё])КХ\s+[А-ЯЁ"]/.test(n)) return 'farmer';
  // Растениеводство / животноводство
  if (/РАСТЕНИЕВОДСТВО|ЖИВОТНОВОДСТВО|ЗЕРНОВОДСТВО/.test(n)) return 'farmer';

  // Агрохолдинг / Агропромышленная / Агроинвест / Агросервис
  if (/АГРОХОЛДИНГ|АГРОПРОМЫШЛЕНН|АГРОИНВЕСТ|АГРОКОМПАНИ|АГРОГРУПП|АГРОСОЮЗ/.test(n)) return 'farmer';
  // Сельхоз / Сельскохоз
  if (/СЕЛЬХОЗ|СЕЛЬСКОХОЗ/.test(n)) return 'farmer';
  // Зернопроизводство
  if (/ЗЕРНОПРОИЗВОДСТВ/.test(n)) return 'farmer';

  // ── Трейдеры ───────────────────────────────────────────────
  if (/ТОРГОВЫЙ ДОМ/.test(n)) return 'trader';
  if (/(?<![А-ЯЁа-яё])ТД\s+"/.test(n)) return 'trader';
  if (/ТРЕЙД|TRADE|ЗЕРНОТРЕЙД|ЗЕРНОТОРГ/.test(n)) return 'trader';
  // ГРЕЙН / GRAIN — торговые компании
  if (/ГРЕЙН|GRAIN/.test(n)) return 'trader';
  // Зерновой терминал / элеватор (хранение/отгрузка = торговый узел)
  if (/ЗЕРНОВОЙ ТЕРМИНАЛ|ЗЕРНОВОЙ ПОРТ/.test(n)) return 'trader';
  // Хлебопродукт / хлебоприёмный
  if (/ХЛЕБОПРОДУКТ|ХЛЕБОПРИЕМ/.test(n)) return 'trader';
  if (/ЭКСПОРТ\s+(?:ЗЕРН|АГР|ООО|АО)/.test(n)) return 'trader';

  return 'unknown';
}

/**
 * Основная функция: поиск по ИНН.
 * Порядок: dadata (10k/день) → itsoft (~145/день) → null.
 * Если dadata нашёл компанию, но ОКВЭД пустой (ликвидирована) — пробуем itsoft.
 */
async function lookupInn(inn) {
  if (DADATA_TOKEN) {
    const result = await fetchOkvedFromDadata(inn);
    if (result === RATE_LIMITED) {
      console.warn('[FNS] dadata 429, пробуем itsoft...');
    } else if (result && result.okved) {
      return result; // есть ОКВЭД — отлично
    } else if (result && !result.okved) {
      // Нашли компанию, но ОКВЭД пуст — itsoft может знать старый ОКВЭД
      const itsoft = await fetchOkvedFromItsoft(inn);
      if (itsoft && itsoft !== RATE_LIMITED && itsoft.okved) return itsoft;
      return result; // возвращаем dadata-результат (хоть без ОКВЭД)
    } else {
      return null; // не найдено
    }
  }
  return fetchOkvedFromItsoft(inn);
}

/**
 * Поиск по имени.
 * Порядок: dadata suggest (сразу ОКВЭД) → nalog.ru ИНН → dadata/itsoft.
 */
async function lookupByName(name) {
  // Сначала пробуем dadata suggest — быстро, один запрос
  if (DADATA_TOKEN) {
    const result = await findByNameDadata(name);
    if (result !== null && result !== RATE_LIMITED) return result;
    if (result === RATE_LIMITED) console.warn('[FNS] dadata suggest 429');
  }
  // Запасной вариант: наlog.ru ИНН → itsoft ОКВЭД
  const inn = await findInnByName(name);
  if (!inn) return null;
  const result = await fetchOkvedFromItsoft(inn);
  if (result === RATE_LIMITED) return RATE_LIMITED;
  return result || { name, okved: '', okveds: [], inn };
}

module.exports = { lookupInn, lookupByName, classifyOkved, classifyByName, RATE_LIMITED };
