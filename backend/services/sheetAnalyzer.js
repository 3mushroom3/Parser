/**
 * Автоопределение структуры произвольной Excel/CSV-базы контрагентов.
 *
 * Общий движок для «Моих баз контактов» (userContactsParser.js) и админского
 * импорта производителей (xlsImporter.js). Базы приходят в любом виде, поэтому
 * ничего не завязано на номера колонок:
 *  - лист выбирается по качеству найденных колонок (не обязательно первый);
 *  - строка заголовка ищется по ключевым словам, многоуровневые шапки
 *    (объединённые ячейки + подзаголовки) склеиваются, строка нумерации
 *    колонок «1 2 3 …» пропускается; файл может быть и вовсе без шапки;
 *  - тип колонки определяется по заголовку И по содержимому (телефоны, email,
 *    ИНН с контрольной суммой, адресные маркеры, орг.формы, ФИО);
 *  - одна ячейка может содержать сразу адрес + руководителя + телефоны + email
 *    («Адрес, директор, контактные данные») — они разбираются по частям;
 *  - строки без названия/ИНН под компанией (доп. культуры, второй телефон,
 *    вертикально объединённые ячейки) приклеиваются к предыдущей компании;
 *  - CSV читается в UTF-8/UTF-16/Windows-1251, ведущие нули ИНН сохраняются.
 */
const XLSX = require('xlsx');

const MAX_ROWS = 100_000;
const HEADER_SCAN_ROWS = 30;
const PROFILE_ROWS = 300;

const CONTACT_TYPES = ['inn', 'name', 'phone', 'phone2', 'email', 'address', 'person'];
const PRODUCER_TYPES = [...CONTACT_TYPES, 'crops', 'area'];

// ── Чтение файла ───────────────────────────────────────────────────────────

function decodeText(buffer) {
  if (buffer[0] === 0xFF && buffer[1] === 0xFE) return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  if (buffer[0] === 0xFE && buffer[1] === 0xFF) return new TextDecoder('utf-16be').decode(buffer.subarray(2));
  const body = (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) ? buffer.subarray(3) : buffer;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    // Выгрузки из 1С и старого Excel — почти всегда Windows-1251
    return new TextDecoder('windows-1251').decode(body);
  }
}

function isBinarySpreadsheet(buffer) {
  const zip = buffer[0] === 0x50 && buffer[1] === 0x4B;                     // xlsx / ods
  const ole = buffer[0] === 0xD0 && buffer[1] === 0xCF && buffer[2] === 0x11; // xls
  return zip || ole;
}

function readWorkbook(buffer, fileName = '') {
  if (!buffer || buffer.length < 8) throw new Error('Файл пустой или повреждён');
  const opts = { sheetRows: MAX_ROWS + 50 };
  // CSV/TXT и «xls», который на деле HTML-таблица, декодируем сами: SheetJS
  // читает байты как latin1 и превращает кириллицу в «ÐÐÐ». raw: true —
  // чтобы «0105012345» не стало числом 105012345.
  if (!isBinarySpreadsheet(buffer)) {
    return XLSX.read(decodeText(buffer), { ...opts, type: 'string', raw: true });
  }
  return XLSX.read(buffer, { ...opts, type: 'buffer' });
}

function sheetRows(ws) {
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: true, raw: true });
}

// ── Нормализация значений ──────────────────────────────────────────────────

const collapse = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const isEmptyCell = v => v === '' || v === null || v === undefined || (typeof v === 'string' && !v.trim());
const isEmptyRow = row => !row || row.every(isEmptyCell);

function innChecksumOk(inn) {
  const d = inn.split('').map(Number);
  const ctrl = w => (w.reduce((sum, k, i) => sum + k * d[i], 0) % 11) % 10;
  if (d.length === 10) return ctrl([2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[9];
  if (d.length === 12) {
    return ctrl([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[10] &&
           ctrl([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[11];
  }
  return false;
}

// Возвращает { inn, valid }. Числовая ячейка Excel теряет ведущий ноль
// (ИНН Адыгеи 01…) — восстанавливаем, если так сходится контрольная сумма.
function parseInn(raw) {
  if (isEmptyCell(raw)) return { inn: '', valid: false };
  const candidates = [];
  for (const g of String(raw).match(/\d+/g) || []) {
    if (g.length === 10 || g.length === 12) candidates.push(g);
    else if (typeof raw === 'number' && (g.length === 9 || g.length === 11)) candidates.push('0' + g);
  }
  const valid = candidates.find(innChecksumOk);
  return valid ? { inn: valid, valid: true } : { inn: candidates[0] || '', valid: false };
}

// Реквизиты, которые нельзя принимать за телефоны: «ИНН 9403009429» и т.п.
const REQUISITES_RE = /(?:инн|кпп|огрнип|огрн|окпо|окато|октмо|оквэд|бик|р\/с|к\/с|л\/с|сч[её]т|индекс)\s*[:№#]?\s*[\d\s\/\-]*\d/gi;
const PHONE_CHUNK_RE = /\+?\(?\d[\d\s\-.()]*/g;

// Ищет российские телефоны в произвольном тексте. Номер собирается из
// «кусков» цифр, разделённых пробелами/дефисами/скобками, пока не наберётся
// 10 или 11 цифр: так разбираются и «(86342) 6-55-04», и «+7959 222 62 99»,
// и два номера подряд через пробел. Короткий номер с дефисами после
// городского («(863) 255-85-85, ф. 261-85-79») получает тот же код города.
function findPhoneSpans(raw, { skipBareInn = false } = {}) {
  if (isEmptyCell(raw)) return [];
  const blank = m => ' '.repeat(m.length);
  const s = String(raw).replace(REQUISITES_RE, blank).replace(EMAIL_RE, blank).replace(URL_RE, blank);
  const spans = [];
  let lastNational = '';
  let chunk;
  PHONE_CHUNK_RE.lastIndex = 0;
  while ((chunk = PHONE_CHUNK_RE.exec(s)) !== null) {
    // цифры, прилипшие к латинице («id123456», «c015mn»), — не телефон
    if (/[a-z]/i.test(s[chunk.index - 1] || '')) continue;
    const found = spans.length;
    const tokens = [];
    const TOKEN_RE = /\d+/g;
    let t;
    while ((t = TOKEN_RE.exec(chunk[0])) !== null) {
      tokens.push({ digits: t[0], start: chunk.index + t.index, end: chunk.index + t.index + t[0].length });
    }
    let i = 0;
    while (i < tokens.length) {
      let digits = '';
      let best = null;
      for (let j = i; j < tokens.length && digits.length < 11; j++) {
        digits += tokens[j].digits;
        const ok11 = digits.length === 11 && /^[78][3-9]/.test(digits);
        const ok10 = digits.length === 10 && /^[3-9]/.test(digits);
        if (ok10 || ok11) best = { j, digits };
      }
      if (!best) { i++; continue; }
      const start = tokens[i].start;
      const end = tokens[best.j].end;
      const national = best.digits.length === 11 ? best.digits.slice(1) : best.digits;
      const bare = best.j === i && best.digits.length === 10 && s[start - 1] !== '+';
      if (!(skipBareInn && bare && innChecksumOk(best.digits))) {
        // «+» перед номером тоже часть телефона — чтобы вырезать его из адреса
        const from = s[start - 1] === '+' ? start - 1 : (s[start - 2] === '+' && s[start - 1] === '(' ? start - 2 : start);
        spans.push({ start: from, end, phone: '+7' + national });
        lastNational = national;
      }
      i = best.j + 1;
    }
    const local = chunk[0].trim();
    const localDigits = local.replace(/\D/g, '');
    if (spans.length === found && lastNational && !lastNational.startsWith('9') &&
        localDigits.length >= 5 && localDigits.length <= 7 && /^\d[\d\-]*\d$/.test(local) && local.includes('-') &&
        !/доб\.?\s*$/i.test(s.slice(Math.max(0, chunk.index - 6), chunk.index))) {
      const national = lastNational.slice(0, 10 - localDigits.length) + localDigits;
      const start = chunk.index + chunk[0].indexOf(local);
      spans.push({ start, end: start + local.length, phone: '+7' + national });
    }
  }
  return spans;
}

function extractPhones(raw, opts) {
  return [...new Set(findPhoneSpans(raw, opts).map(p => p.phone))];
}

const KNOWN_TLDS = ['ru', 'com', 'net', 'org', 'su', 'info', 'biz', 'pro', 'рф'];
const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9\-]+(?:\.[a-z0-9\-]+)*\.[a-z]{2,}/gi;
const URL_RE = /(?:https?:\/\/|www\.)[^\s,;]+/gi;

function extractEmails(raw) {
  if (isEmptyCell(raw)) return [];
  const out = [];
  for (let m of String(raw).match(EMAIL_RE) || []) {
    m = m.toLowerCase().replace(/[.\-]+$/, '');
    // «info@agro.rutel:8-800…» — текст прилип к домену без пробела
    const tld = m.slice(m.lastIndexOf('.') + 1);
    if (!KNOWN_TLDS.includes(tld) && tld.length > 3) {
      const known = KNOWN_TLDS.find(k => tld.startsWith(k));
      if (known) m = m.slice(0, m.length - tld.length + known.length);
    }
    if (!out.includes(m)) out.push(m);
  }
  return out;
}

// ── ФИО / руководитель ─────────────────────────────────────────────────────

const UP = 'А-ЯЁ';
const LO = 'а-яё';
const NAME_WORD = `[${UP}][${LO}]+(?:-[${UP}][${LO}]+)?`;
const INITIALS = `[${UP}]\\.\\s?[${UP}]\\.?`;
const PATRONYMIC_END = '(?:вич|вна|ична|кызы|оглы)';
const PERSON_ALTS = [
  `${NAME_WORD}\\s+[${UP}][${LO}]+\\s+[${UP}][${LO}]+${PATRONYMIC_END}`,                  // Иванов Иван Иванович
  `[${UP}]{2,}(?:-[${UP}]{2,})?\\s+[${UP}]{2,}\\s+[${UP}]{2,}(?:ВИЧ|ВНА|ИЧНА)`,          // ИВАНОВ ИВАН ИВАНОВИЧ
  `${NAME_WORD}\\s?${INITIALS}`,                                                            // Иванов И.И.
];
const ROLE = '(?:ген(?:еральный|\\.)?\\s*)?(?:директор|дир\\.|руководитель|рук\\.|глава(?:\\s+(?:к\\(?ф\\)?х|кфх|фх|хозяйства))?|председатель|управляющий|контактное\\s+лицо|конт\\.\\s*лицо|к\\.\\s?л\\.)';
const ROLE_PERSON_RE = new RegExp(
  `(?:^|[^${LO}a-z])${ROLE}\\s*[:\\-–—]?\\s*(${PERSON_ALTS[2]}|${INITIALS}\\s?${NAME_WORD}|[${UP}][${LO}${UP}\\-]+(?:\\s+[${UP}][${LO}${UP}]+){1,2})`,
  'i'
);
const PERSON_RE = new RegExp(`(?:^|[^${LO}${UP}a-zA-Z])(${PERSON_ALTS.join('|')})(?![${LO}${UP}])`);
// «ул. Юрченко П.А.», «им. Ленина В.И.» — это адрес, а не человек
const STREET_BEFORE_RE = /(?:ул|улица|пер|пр|просп|пл|бул|им|имени|пос|с|х|ст|пгт|мкр)\.?\s*$/i;

function extractPerson(raw) {
  if (isEmptyCell(raw)) return '';
  const s = String(raw).replace(/\s+/g, ' ');
  const role = s.match(ROLE_PERSON_RE);
  if (role) {
    const name = role[1].replace(/\s+(?:тел|тлф|моб|т)\.?$/i, '').trim();
    // ROLE_PERSON_RE регистронезависим — отсекаем «директор по продажам»
    if (new RegExp(`^[${UP}]`).test(name)) return name;
  }
  const re = new RegExp(PERSON_RE.source, 'g');
  let m;
  while ((m = re.exec(s)) !== null) {
    const start = m.index + m[0].length - m[1].length;
    if (!STREET_BEFORE_RE.test(s.slice(Math.max(0, start - 8), start))) return m[1].trim();
  }
  return '';
}

// ── Адрес из «смешанной» ячейки ────────────────────────────────────────────

const CONTACT_LABEL_RE = /(?:^|[^а-яёa-z])(?:тел(?:ефон[ыа]?)?|тлф|моб(?:ильный)?|сот(?:овый)?|факс|т|e-?mail|email|эл\.?\s*почта|почта|электронная почта)\s*[.:]*\s*(?=[,;()+\d]|$)/gi;

function cleanAddress(raw, { person = '' } = {}) {
  if (isEmptyCell(raw)) return '';
  let s = String(raw);
  // Формат справочников: «346770, …, Советская, 83 моб.…8-919-… e-mail: …» —
  // всё после первой метки с «…» (моб./тел./бух./дир./глава…) это контакты
  const ellipsis = s.indexOf('…');
  if (ellipsis > 0) {
    const tokens = s.slice(0, ellipsis).trimEnd().split(/\s+/);
    if (/[а-яёa-z]/i.test(tokens[tokens.length - 1] || '')) tokens.pop();
    while (tokens.length > 1 && /^(?:[а-яё]{1,6}\.|по|и)$/i.test(tokens[tokens.length - 1])) tokens.pop();
    s = tokens.join(' ');
  }
  s = s.replace(URL_RE, ' ');
  const cut = [];
  for (const p of findPhoneSpans(s)) cut.push([p.start, p.end]);
  s = cut.sort((a, b) => b[0] - a[0]).reduce((acc, [a, b]) => acc.slice(0, a) + ' ' + acc.slice(b), s);
  s = s.replace(EMAIL_RE, ' ');
  if (person) {
    const idx = s.indexOf(person);
    if (idx >= 0) {
      // вместе с должностью перед ФИО: «Директор - Иванов И.И.»
      const before = s.slice(0, idx).replace(new RegExp(`${ROLE}\\s*[:\\-–—]?\\s*$`, 'i'), '');
      s = before + ' ' + s.slice(idx + person.length);
    }
  }
  s = s.replace(CONTACT_LABEL_RE, ' ');
  return s
    .replace(/\(\s*[,;.\s]*\)/g, ' ')
    .replace(/\s+([,.;])/g, '$1')
    .replace(/([,;])(?:\s*[,;])+/g, '$1')
    .replace(/\.{2,}/g, '.')
    .replace(/[\s,;.]*[,;][\s,;.]*$/, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;.:\-–—(]+|[\s,;:\-–—(]+$/g, '')
    .trim();
}

// ── Прочие детекторы содержимого ───────────────────────────────────────────

const ORG_FORM_RE = /(?:^|[^а-яёa-z])(?:ооо|оао|зао|пао|нао|ао|ип|кфх|к\(ф\)х|кх|фх|глава\s+к\(?ф\)?х|спк|схпк|спхк|скхп|сха|схп|схк|тнв|гуп|муп|фгуп|сзао|чп|флп|ооо\s*«|агрофирма|агрохолдинг|колхоз|совхоз|племзавод|крестьянск|фермерск|индивидуальный\s+предприниматель|общество\s+с\s+ограниченной|акционерное\s+общество|сельскохозяйственн\w*\s+(?:артель|кооператив|предприятие))(?:[^а-яёa-z]|$)/i;
const ADDRESS_MARKER_RE = /(?:^|[^а-яёa-z])(?:ул|улица|пр-т|просп|пер|пл|б-р|бульвар|ш|шоссе|д|дом|кв|оф|стр|корп|г|город|гор|с|село|пос|п|пгт|рп|ст-ца|станица|х|хут|хутор|аул|дер|р-н|район|м\.?\s?р-н|обл|область|край|респ|республика|мкр|кв-л|г\.?\s?о|с\.?\s?п)\.?(?=[\s,.\d]|$)|\b\d{6}\b/gi;
const CROP_RE = /пшениц|ячмен|кукуруз|подсолнечн|рож[ьи]|(?:^|[^а-яё])рожь|овес|овёс|горох|соя|сои|рапс|гречих|просо|сорго|горчиц|(?:^|[^а-яё])л[её]н(?:[^а-яё]|$)|зернов|свекл|свёкл|нут|чечевиц|тритикале|картоф|бахч|овощ|сад/i;

const cellText = v => (typeof v === 'number' ? String(v) : String(v ?? '')).trim();
const isNumericText = t => /^-?\d[\d\s]*(?:[.,]\d+)?$/.test(t);
const isPersonCell = t => t.length <= 60 && !!extractPerson(t) && !ORG_FORM_RE.test(t) && countAddressMarkers(t) === 0;

function countAddressMarkers(t) {
  return (t.match(ADDRESS_MARKER_RE) || []).length;
}

function parseArea(raw) {
  if (isEmptyCell(raw)) return null;
  if (typeof raw === 'number') return raw;
  const m = String(raw).replace(/\s+/g, '').replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function splitCrops(raw) {
  if (isEmptyCell(raw)) return [];
  return String(raw)
    .split(/[,;\n\t]+|\s{3,}|\.\s+(?=[А-ЯЁ])/)   // «/» не режем: «кукуруза на з/к»
    .map(c => collapse(c).replace(/[.,;]+$/, ''))
    .filter(c => c && c !== '-' && c !== '—');
}

// ── Заголовки ──────────────────────────────────────────────────────────────

// Кириллица не входит в \w, поэтому \b не работает — границы слов вручную.
const B = '(?:^|[^а-яёa-z0-9])';
const E = '(?=[^а-яёa-z0-9]|$)';
const HEADER_RULES = {
  inn: {
    strong: new RegExp(`${B}инн${E}|${B}inn${E}|налогоплательщ`, 'i'),
  },
  phone: {
    strong: new RegExp(`${B}тел(?:\\.|ефон|${E})|phone|${B}моб(?:\\.|ильн|${E})|сотов|${B}сот\\.|whats\\s?app|ватсап|вотсап|viber|вайбер|номер\\s+для\\s+связи`, 'i'),
    weak: /контакт/i,
  },
  email: {
    strong: new RegExp(`e[\\s\\-]?mail|${B}(?:емейл|имейл|мейл)${E}|электронн\\w*\\s+(?:почт|адрес)|эл\\.?\\s*(?:почт|адрес)|${B}почта${E}`, 'i'),
    weak: /контакт/i,
  },
  name: {
    strong: new RegExp(`наименован|название|организаци|компани|предприяти|контрагент|клиент|фирм|хозяйств|юр\\.?\\s*лиц|заявител|покупател|поставщик|производител|${B}(?:company|organization|name)${E}`, 'i'),
    not: /продукц|товар|культур|услуг|оквэд|деятельност|отрасл|сырь|партн[её]р|заказчик|численност|инвестор|мсп|системообраз|адрес|телефон|почт|банк|площад|руководител|директор|${B}фио${E}/i,
  },
  person: {
    strong: new RegExp(`${B}ф\\.?\\s?и\\.?\\s?о\\.?${E}|руководител|директор|${B}глава${E}|контактн\\w*\\s+лиц|представител|ответственн|председател|владел|учредител|собственник|${B}(?:имя|фамилия)${E}|contact\\s+person`, 'i'),
  },
  address: {
    strong: /адрес|местонахожд|местоположен|address|почтов/i,
    weak: new RegExp(`населённ|населенн|${B}(?:город|район|регион|область|субъект|нп|city|region)${E}`, 'i'),
  },
  crops: {
    strong: new RegExp(`культур|${B}продукция${E}|вид\\s+продукц|сельхозпродукц|выращива`, 'i'),
  },
  area: {
    strong: new RegExp(`площад|${B}га${E}|гектар`, 'i'),
  },
};

function headerScores(label) {
  const t = collapse(label).toLowerCase();
  const out = {};
  if (!t) return out;
  for (const [type, rule] of Object.entries(HEADER_RULES)) {
    let score = 0;
    if (rule.strong.test(t)) score = 1;
    else if (rule.weak && rule.weak.test(t)) score = 0.5;
    if (score && rule.not && rule.not.test(t) && !(type === 'name' && /наименован|название/.test(t) && !/продукц|товар|культур|услуг/.test(t))) score = 0;
    if (score) out[type] = score;
  }
  // «Email/адрес эл. почты» — это не почтовый адрес
  if (out.email === 1 && out.address) delete out.address;
  return out;
}

function isHeaderKeyword(text) {
  return text.length <= 80 && Object.keys(headerScores(text)).length > 0;
}

// ── Поиск шапки ────────────────────────────────────────────────────────────

function looksLikeData(t) {
  return t.length > 80 ||
    findPhoneSpans(t).length > 0 ||
    extractEmails(t).length > 0 ||
    parseInn(t).valid && /^\D{0,12}\d{10,12}\D{0,20}$/.test(t);
}

function rowProfile(row) {
  const p = { nonEmpty: 0, keywords: 0, text: 0, data: 0, numeric: 0, org: 0, values: [] };
  for (const v of row || []) {
    const t = cellText(v);
    if (!t) continue;
    p.nonEmpty++;
    p.values.push(t);
    if (looksLikeData(t)) { p.data++; continue; }
    if (isNumericText(t)) { p.numeric++; continue; }
    if (ORG_FORM_RE.test(t) && !isHeaderKeyword(t)) p.org++;
    if (isHeaderKeyword(t)) p.keywords++;
    if (/[а-яёa-z]/i.test(t) && t.length <= 60) p.text++;
  }
  return p;
}

function isColumnNumberingRow(p) {
  if (p.nonEmpty < 3 || p.numeric !== p.nonEmpty) return false;
  const nums = p.values.map(Number);
  return nums.every((n, i) => Number.isInteger(n) && (i === 0 || n > nums[i - 1])) && nums[0] <= 2;
}

// Значения объединённых ячеек (merge) копируются во все ячейки диапазона —
// только для построения подписей колонок.
function mergedRows(rows, ws, from, to) {
  const out = [];
  for (let r = from; r <= to; r++) out[r] = [...(rows[r] || [])];
  for (const m of ws?.['!merges'] || []) {
    if (m.s.r > to || m.e.r < from) continue;
    const value = rows[m.s.r]?.[m.s.c];
    if (isEmptyCell(value)) continue;
    for (let r = Math.max(from, m.s.r); r <= Math.min(to, m.e.r); r++) {
      for (let c = m.s.c; c <= m.e.c; c++) {
        if (isEmptyCell(out[r][c])) out[r][c] = value;
      }
    }
  }
  return out;
}

function detectLayout(rows, ws) {
  const scan = Math.min(rows.length, HEADER_SCAN_ROWS);
  let headerRow = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < scan; i++) {
    const p = rowProfile(rows[i]);
    if (p.nonEmpty < 2 || p.data > 1 || isColumnNumberingRow(p)) continue;
    const valid = p.keywords >= 2 || (p.keywords >= 1 && p.text >= 2) || (p.text >= 3 && p.org === 0 && p.numeric === 0);
    if (!valid) continue;
    const score = p.keywords * 10 + p.text - p.data * 5 - p.org * 5;
    if (score > bestScore) { bestScore = score; headerRow = i; }
  }

  let colCount = 0;
  for (let i = 0; i < Math.min(rows.length, headerRow + 1 + PROFILE_ROWS); i++) {
    colCount = Math.max(colCount, (rows[i] || []).length);
  }

  // Без шапки: данные с первой непустой строки, колонки «Колонка N»
  if (headerRow < 0) {
    let dataStart = rows.findIndex(r => !isEmptyRow(r));
    if (dataStart < 0) dataStart = rows.length;
    return {
      headerRow: null, headerRows: [], dataStart, colCount,
      labels: Array.from({ length: colCount }, (_, i) => `Колонка ${i + 1}`),
    };
  }

  // Подзаголовки под шапкой: текстовая строка без данных и чисел, в которой
  // заполнены колонки с пустой/объединённой ячейкой шапки («Посевная площадь»
  // → «Вид культуры | Общая площадь, га»). И строка нумерации «1 2 3 …».
  const headerRows = [headerRow];
  let dataStart = headerRow + 1;
  for (let k = 0; k < 2 && dataStart < rows.length; k++) {
    const row = rows[dataStart] || [];
    const p = rowProfile(row);
    if (isEmptyRow(row)) { dataStart++; k--; if (dataStart - headerRow > 5) break; continue; }
    if (isColumnNumberingRow(p)) { dataStart++; continue; }
    const head = mergedRows(rows, ws, headerRow, headerRow)[headerRow];
    const underMergedOrEmpty = row.some((v, c) => !isEmptyCell(v) && (isEmptyCell(rows[headerRow]?.[c]) || head[c] !== rows[headerRow]?.[c]));
    const isSubHeader = p.data === 0 && p.numeric === 0 && p.org === 0 && p.values.every(t => t.length <= 60 && !isPersonCell(t)) &&
      (underMergedOrEmpty || p.keywords >= 1);
    if (!isSubHeader) break;
    headerRows.push(dataStart);
    dataStart++;
  }

  const top = Math.max(0, headerRow - 2);
  const bottom = headerRows[headerRows.length - 1];
  const filled = mergedRows(rows, ws, top, bottom);
  const labels = [];
  for (let c = 0; c < colCount; c++) {
    const parts = [];
    for (const r of headerRows) {
      const t = collapse(filled[r]?.[c]);
      if (t && !parts.includes(t)) parts.push(t);
    }
    // пусто — берём группирующую строку над шапкой («Отрасль…» в A1:A3)
    for (let r = headerRow - 1; !parts.length && r >= top; r--) {
      const t = collapse(filled[r]?.[c]);
      if (t && !looksLikeData(t)) parts.push(t);
    }
    labels.push(parts.join(' / '));
  }
  return { headerRow, headerRows, dataStart, colCount, labels };
}

// ── Определение типов колонок ──────────────────────────────────────────────

function profileColumns(rows, layout) {
  const sample = [];
  for (let r = layout.dataStart; r < rows.length && sample.length < PROFILE_ROWS; r++) {
    if (!isEmptyRow(rows[r])) sample.push(rows[r]);
  }
  const cols = [];
  for (let c = 0; c < layout.colCount; c++) {
    const st = {
      n: 0, phone: 0, email: 0, innValid: 0, innAny: 0, address: 0, org: 0,
      person: 0, personInText: 0, crops: 0, numeric: 0, totalLen: 0,
      header: headerScores(layout.labels[c]),
    };
    for (const row of sample) {
      const raw = row[c];
      const t = cellText(raw);
      if (!t) continue;
      st.n++;
      st.totalLen += t.length;
      if (findPhoneSpans(raw).length) st.phone++;
      if (extractEmails(t).length) st.email++;
      const inn = parseInn(raw);
      const innOnly = /^(?:инн|inn)?[\s:№]*\d{9,12}(?:\s*[\/\\,;]\s*\d{9})?$/i.test(t);
      if (inn.inn && innOnly) st.innAny++;
      if (inn.valid && innOnly) st.innValid++;
      if (countAddressMarkers(t) >= 2) st.address++;
      if (ORG_FORM_RE.test(t)) st.org++;
      if (isPersonCell(t)) st.person++;
      else if (t.length > 20 && extractPerson(t)) st.personInText++;
      if (CROP_RE.test(t) && !isNumericText(t) && t.length < 400) st.crops++;
      if (isNumericText(t)) st.numeric++;
    }
    const rate = k => (st.n ? st[k] / st.n : 0);
    cols.push({
      header: st.header, n: st.n, avgLen: st.n ? st.totalLen / st.n : 0,
      phone: rate('phone'), email: rate('email'), innValid: rate('innValid'), innAny: rate('innAny'),
      address: rate('address'), org: rate('org'), person: rate('person'),
      personInText: rate('personInText'), crops: rate('crops'), numeric: rate('numeric'),
    });
  }
  return cols;
}

function suggestMapping(cols, types) {
  const want = new Set(types);
  const map = {};
  for (const t of types) map[t] = -1;
  const h = (c, type) => cols[c].header[type] || 0;
  const pick = (type, candidates, score) => {
    let best = -1;
    let bestScore = -Infinity;
    for (let c = 0; c < cols.length; c++) {
      if (!candidates(c)) continue;
      const s = score(c);
      if (s > bestScore) { bestScore = s; best = c; }
    }
    if (best >= 0) map[type] = best;
    return best;
  };
  const noData = c => cols[c].n === 0;

  // ИНН: контрольная сумма почти не бывает случайной — надёжнее заголовка
  pick('inn',
    c => (h(c, 'inn') && (cols[c].innAny >= 0.3 || noData(c))) || cols[c].innValid >= 0.6,
    c => cols[c].innValid + h(c, 'inn') * 0.6);
  const innCol = map.inn;

  const phoneCandidate = c => c !== innCol && (cols[c].phone >= 0.3 || (h(c, 'phone') && (cols[c].phone >= 0.1 || noData(c))));
  const phoneCol = pick('phone', phoneCandidate, c => cols[c].phone + h(c, 'phone') * 0.5);
  if (want.has('phone2') && phoneCol >= 0) {
    pick('phone2',
      c => c !== phoneCol && phoneCandidate(c) && (cols[c].phone >= 0.2 || h(c, 'phone') === 1),
      c => cols[c].phone + h(c, 'phone') * 0.5);
  }

  pick('email',
    c => cols[c].email >= 0.2 ||
      (h(c, 'email') === 1 && (cols[c].email > 0 || noData(c))) ||
      (cols[c].email > 0 && (c === phoneCol || h(c, 'email') > 0)),
    c => cols[c].email + h(c, 'email') * 0.5);

  const contactOnly = c => cols[c].phone > 0.5 || cols[c].email > 0.5 || cols[c].innValid > 0.5 || cols[c].numeric > 0.5;
  const nameCol = pick('name',
    c => c !== innCol && !contactOnly(c) && (h(c, 'name') === 1 || cols[c].org >= 0.3),
    c => h(c, 'name') + cols[c].org - (cols[c].address >= 0.5 ? 1 : 0) - c * 0.001);

  pick('address',
    // колонка с email подходит под адрес, только если в ней есть и сам адрес
    c => c !== nameCol && !(cols[c].email >= 0.5 && cols[c].address < 0.3) && cols[c].innValid < 0.5 &&
      (h(c, 'address') === 1 || cols[c].address >= 0.3 || (h(c, 'address') && cols[c].numeric < 0.5)),
    c => h(c, 'address') + cols[c].address - c * 0.001);
  const addressCol = map.address;

  if (want.has('person')) {
    const dedicated = pick('person',
      c => c !== nameCol && c !== innCol && cols[c].phone < 0.5 && cols[c].address < 0.5 &&
        ((h(c, 'person') === 1 && cols[c].numeric < 0.5) || cols[c].person >= 0.5),
      c => h(c, 'person') + cols[c].person);
    // ФИО внутри «Адрес, директор, телефон»
    if (dedicated < 0) {
      pick('person',
        c => c !== nameCol && (c === addressCol || c === phoneCol) && cols[c].personInText >= 0.3,
        c => cols[c].personInText);
    }
  }
  // База ИП/КФХ без колонки «Наименование»: ФИО и есть название
  if (map.name < 0 && map.person >= 0 && cols[map.person].address < 0.3 && cols[map.person].phone < 0.3) {
    map.name = map.person;
    map.person = -1;
  }

  if (want.has('crops')) {
    pick('crops',
      c => c !== nameCol && cols[c].numeric < 0.5 && cols[c].phone < 0.3 &&
        (h(c, 'crops') === 1 || cols[c].crops >= 0.4),
      c => h(c, 'crops') + cols[c].crops);
  }
  if (want.has('area')) {
    pick('area',
      c => c !== map.crops && h(c, 'area') === 1 && (cols[c].numeric >= 0.5 || noData(c)),
      c => cols[c].numeric - c * 0.001);
  }
  for (const t of Object.keys(map)) if (!want.has(t)) delete map[t];
  return map;
}

const TYPE_WEIGHT = { inn: 3, phone: 3, name: 2, email: 2, address: 1, person: 1, phone2: 0.5, crops: 1, area: 0.5 };

function analyzeSheet(wb, sheetName, types) {
  const ws = wb.Sheets[sheetName];
  const rows = sheetRows(ws);
  if (!rows.some(r => !isEmptyRow(r))) return null;
  const layout = detectLayout(rows, ws);
  const cols = profileColumns(rows, layout);
  const suggested = suggestMapping(cols, types);
  let dataRows = 0;
  for (let r = layout.dataStart; r < rows.length; r++) if (!isEmptyRow(rows[r])) dataRows++;
  const score = Object.entries(suggested).reduce((s, [t, c]) => s + (c >= 0 ? TYPE_WEIGHT[t] || 0 : 0), 0) +
    Math.min(dataRows, 1000) / 1000;
  return { sheetName, rows, layout: { ...layout, dataRows }, cols, suggested, score };
}

// Выбирает лист с лучшим набором распознанных колонок
function analyzeWorkbook(wb, { types = CONTACT_TYPES } = {}) {
  let best = null;
  for (const name of wb.SheetNames) {
    const res = analyzeSheet(wb, name, types);
    if (res && (!best || res.score > best.score)) best = res;
  }
  return best;
}

// Повторно открывает тот же лист с той же разметкой, что показали в превью
function loadSheet(wb, { sheetName, headerRow, headerRows, dataStart, colCount, labels }) {
  const ws = wb.Sheets[sheetName];
  if (!ws) return null;
  return { sheetName, rows: sheetRows(ws), layout: { headerRow, headerRows, dataStart, colCount, labels } };
}

// ── Сборка записей ─────────────────────────────────────────────────────────

const TOTAL_ROW_RE = /^(?:итого|всего|total)(?:[^а-яёa-z]|$)/i;

function normalizeMapping(mapping, colCount) {
  const cols = {};
  for (const type of PRODUCER_TYPES) {
    const v = mapping?.[type];
    cols[type] = Number.isInteger(v) && v >= 0 && v < Math.max(colCount, 1) ? v : -1;
  }
  return cols;
}

function parseRow(row, cols, colTypes) {
  const rec = { inn: '', name: '', phones: [], emails: [], address: '', person: '', crops: [], area: null };
  const text = c => cellText(row[c]);
  for (const [c, types] of colTypes) {
    const raw = row[c];
    if (isEmptyCell(raw)) continue;
    const mixed = types.size > 1;
    if (types.has('inn')) rec.inn = parseInn(raw).inn;
    if (types.has('person')) rec.person = mixed ? extractPerson(raw) : collapse(cleanAddress(raw)) || collapse(raw);
    if (types.has('email')) rec.emails.push(...extractEmails(raw));
    if (types.has('crops')) rec.crops.push(...splitCrops(raw));
    if (types.has('area')) rec.area = parseArea(raw);
    // cleanAddress всегда, не только для «смешанных» колонок: в чистой колонке
    // «Адрес» тоже попадается прилипший телефон/подпись («…12 моб.…8-928-…»,
    // «15 тел. 2-34-56») — без очистки он остаётся в адресе как есть.
    if (types.has('address')) rec.address = collapse(cleanAddress(raw, { person: rec.person })) || collapse(raw);
    if (types.has('name')) {
      let name = collapse(text(c));
      // «ООО Ромашка, ИНН …, тел. …» — название до первых реквизитов
      if (mixed) name = collapse(name.split(/[,;\n]\s*(?:инн|тел|т\.|e-?mail|адрес|\+?\d{6,})/i)[0]);
      rec.name = name;
    }
  }
  // Телефоны в порядке: основная колонка, затем вторая
  for (const type of ['phone', 'phone2']) {
    const c = cols[type];
    if (c < 0 || isEmptyCell(row[c])) continue;
    const phones = extractPhones(row[c], { skipBareInn: colTypes.get(c).has('inn') });
    for (const p of phones) if (!rec.phones.includes(p)) rec.phones.push(p);
  }
  rec.emails = [...new Set(rec.emails)];
  return rec;
}

function mergeRecord(target, src) {
  for (const p of src.phones) if (!target.phones.includes(p)) target.phones.push(p);
  for (const e of src.emails) if (!target.emails.includes(e)) target.emails.push(e);
  for (const cr of src.crops) if (!target.crops.includes(cr)) target.crops.push(cr);
  if (!target.address && src.address) target.address = src.address;
  if (!target.person && src.person) target.person = src.person;
  if (!target.inn && src.inn) target.inn = src.inn;
  if (src.area !== null) target.areas.push({ crops: [...src.crops], area: src.area });
}

function newRecord(rec, rowNumber) {
  const { area, ...rest } = rec;
  return {
    ...rest,
    phones: [...rec.phones], emails: [...rec.emails], crops: [...rec.crops],
    areas: area !== null ? [{ crops: [...rec.crops], area }] : [],
    row: rowNumber,
  };
}

/**
 * Превращает строки листа в записи-компании по маппингу {тип: индекс колонки}.
 * Строка без названия и ИНН, но с телефоном/культурой/адресом — продолжение
 * предыдущей компании. Повтор ИНН в файле склеивается в одну запись.
 */
function buildRecords(rows, layout, mapping) {
  const cols = normalizeMapping(mapping, layout.colCount);
  const colTypes = new Map();
  for (const [type, c] of Object.entries(cols)) {
    if (c < 0) continue;
    if (!colTypes.has(c)) colTypes.set(c, new Set());
    colTypes.get(c).add(type);
  }
  const hasKeyColumn = cols.inn >= 0 || cols.name >= 0;
  const headerTexts = new Set(layout.labels.map(l => collapse(l).toLowerCase()).filter(Boolean));

  const records = [];
  const byInn = new Map();
  const stats = { rows: 0, merged: 0, skipped: 0 };
  let cur = null;

  for (let r = layout.dataStart; r < rows.length; r++) {
    const row = rows[r];
    if (isEmptyRow(row)) continue;
    stats.rows++;
    // повторённая шапка (склейка нескольких выгрузок в один лист)
    const nonEmpty = row.filter(v => !isEmptyCell(v));
    if (headerTexts.size && nonEmpty.filter(v => headerTexts.has(collapse(v).toLowerCase())).length >= Math.max(2, nonEmpty.length / 2)) {
      stats.skipped++;
      continue;
    }
    const rec = parseRow(row, cols, colTypes);
    if (TOTAL_ROW_RE.test(rec.name)) { stats.skipped++; continue; }

    const hasPayload = rec.phones.length || rec.emails.length || rec.address || rec.person || rec.crops.length || rec.area !== null;
    if (rec.inn || rec.name) {
      const same = rec.inn ? byInn.get(rec.inn) : (cur && !cur.inn && cur.name === rec.name ? cur : null);
      if (same) {
        mergeRecord(same, rec);
        stats.merged++;
        cur = same;
        continue;
      }
      cur = newRecord(rec, r + 1);
      records.push(cur);
      if (rec.inn) byInn.set(rec.inn, cur);
      continue;
    }
    if (!hasPayload) { stats.skipped++; continue; }
    if (hasKeyColumn) {
      if (cur) { mergeRecord(cur, rec); stats.merged++; } else stats.skipped++;
      continue;
    }
    // В базе нет ни названий, ни ИНН — каждая строка самостоятельна
    cur = newRecord(rec, r + 1);
    records.push(cur);
  }
  return { records, stats };
}

// Ключ для сравнения названий: без орг.формы, кавычек и регистра
const ORG_FORM_WORDS_RE = /(?:^|\s)(?:общество\s+с\s+ограниченной\s+ответственностью|акционерное\s+общество|публичное\s+акционерное\s+общество|закрытое\s+акционерное\s+общество|открытое\s+акционерное\s+общество|индивидуальный\s+предприниматель|крестьянское\s*\(?\s*фермерское\s*\)?\s+хозяйство|глава\s+к\(?ф\)?х|фермерское\s+хозяйство|сельскохозяйственный\s+производственный\s+кооператив|ооо|оао|зао|пао|нао|ао|ип|кфх|к\(ф\)х|кх|фх|спк|схпк|сха|тнв|гуп|муп|чп|флп)(?=\s|$)/g;
function nameKey(name) {
  return collapse(
    String(name || '').toLowerCase().replace(/ё/g, 'е')
      .replace(/[«»"'“”„`]/g, ' ')
      .replace(ORG_FORM_WORDS_RE, ' ')
      .replace(/[^а-яa-z0-9]+/g, ' ')
  );
}

/**
 * Какие ИНН и названия из файла уже есть в реестре деклараций (≈5 млн строк).
 * ИНН — пачками по индексу. Названия (только у записей без ИНН) — одним
 * проходом по индексу shortName: ключи реестра не копятся в памяти, сверяются
 * с небольшим набором ключей из файла. Раньше был LIKE '%…%' с JS-функцией
 * на каждую строку файла — полный скан таблицы на строку.
 * Названия вроде «Восход»/«Маяк» есть в десятках регионов, поэтому если у
 * записи известен индекс или регион — компания из реестра должна быть оттуда же.
 */
function regionHints(text) {
  const t = String(text || '').toLowerCase().replace(/ё/g, 'е');
  const hints = new Set();
  for (const m of t.matchAll(/(?:^|\D)(\d{6})(?!\d)/g)) hints.add('#' + m[1].slice(0, 2));
  for (const m of t.matchAll(/([а-я]{4,}(?:ская|ский|ской|ская))\s+(?:обл|край|респ)|(?:обл(?:асть|\.)?|край|респ(?:ублика|\.)?)\s+([а-я]{4,})/g)) {
    hints.add((m[1] || m[2]).slice(0, 6));
  }
  if (/(?:^|[^а-я])лнр(?:[^а-я]|$)|луганская\s+народная/.test(t)) hints.add('луганс');
  if (/(?:^|[^а-я])днр(?:[^а-я]|$)|донецкая\s+народная/.test(t)) hints.add('донецк');
  return hints;
}

function findInRegistry(db, records) {
  const inns = new Set();
  const innList = [...new Set(records.map(r => r.inn).filter(Boolean))];
  for (let i = 0; i < innList.length; i += 500) {
    const part = innList.slice(i, i + 500);
    db.prepare(`SELECT DISTINCT inn FROM declarations WHERE inn IN (${part.map(() => '?').join(',')})`)
      .all(...part).forEach(r => inns.add(r.inn));
  }

  const wanted = new Set(records.filter(r => !r.inn && r.name).map(r => nameKey(r.name)).filter(k => k.length >= 3));
  const shortNamesByKey = new Map();
  if (wanted.size) {
    const stmt = db.prepare("SELECT DISTINCT shortName FROM declarations WHERE shortName IS NOT NULL AND shortName != ''");
    for (const { shortName } of stmt.iterate()) {
      const key = nameKey(shortName);
      if (!wanted.has(key)) continue;
      if (!shortNamesByKey.has(key)) shortNamesByKey.set(key, []);
      shortNamesByKey.get(key).push(shortName);
    }
  }
  // регионы компаний-тёзок из реестра (по индексу shortName)
  const regionsByKey = new Map();
  const allShortNames = [...shortNamesByKey.values()].flat();
  const keyOf = new Map([...shortNamesByKey].flatMap(([k, list]) => list.map(n => [n, k])));
  for (let i = 0; i < allShortNames.length; i += 500) {
    const part = allShortNames.slice(i, i + 500);
    const rows = db.prepare(`SELECT DISTINCT shortName, address FROM declarations WHERE shortName IN (${part.map(() => '?').join(',')})`).all(...part);
    for (const { shortName, address } of rows) {
      const key = keyOf.get(shortName);
      if (!regionsByKey.has(key)) regionsByKey.set(key, new Set());
      for (const h of regionHints(address)) regionsByKey.get(key).add(h);
    }
  }

  return rec => {
    if (rec.inn) return inns.has(rec.inn);
    const key = rec.name ? nameKey(rec.name) : '';
    if (!shortNamesByKey.has(key)) return false;
    const own = regionHints(rec.address);
    if (!own.size) return true;
    const theirs = regionsByKey.get(key) || new Set();
    return [...own].some(h => theirs.has(h));
  };
}

module.exports = {
  MAX_ROWS, CONTACT_TYPES, PRODUCER_TYPES,
  readWorkbook, analyzeWorkbook, loadSheet, buildRecords, findInRegistry,
  extractPhones, extractEmails, extractPerson, cleanAddress, parseInn, innChecksumOk,
  splitCrops, nameKey, cellText, isEmptyRow,
};
