/**
 * Заливка телефонов ИП и КФХ из покупных региональных баз (Excel).
 *
 * Зачем: у ИП и глав КФХ (12-значный ИНН) контактов нет ни в открытых данных
 * РДС, ни в карточке ФСА, ни в Чекко — реестры скрывают данные физлиц. А это
 * половина действующих деклараций. Единственный источник — отраслевые
 * справочники «Предприятия АПК <региона>», которые продаются таблицами.
 *
 * ИНН в этих таблицах нет, поэтому сверяем по ФИО главы + регион + район.
 * Совпадение без района берём, только если в реестре в этом регионе нет
 * тёзок, а в базе это именно КФХ или ИП (не директор ООО с тем же ФИО) и
 * запись одна; иначе не берём вовсе: чужой телефон в карточке хуже пустого поля.
 *
 * Найденное пишется в phone_imports (по ИНН), а уже оттуда — в declarations:
 * так новые декларации того же ИП, пришедшие позже из открытых данных, получают
 * телефон без повторной сверки (applyImportedPhones в ночном задании), и
 * заливку можно откатить, не трогая телефоны из ФСА.
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const db = require('./db');
const { REGIONS } = require('./addressPlace');

db.exec(`
  CREATE TABLE IF NOT EXISTS phone_imports (
    inn TEXT PRIMARY KEY,
    phone TEXT NOT NULL,
    matchedBy TEXT,
    sourceFile TEXT,
    sourceName TEXT,
    importedAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

const MAX_PHONES = 5;

const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е')
  .replace(/[^а-яa-z0-9\- ]/g, ' ').replace(/\s+/g, ' ').trim();

const normDistrict = s => norm(s)
  .replace(/ телефонный код.*$/, '')
  .replace(/ (муниципальный |городской )?(район|округ|р-н|м о|г о)$/, '')
  .replace(/^(г|город) /, '').replace(/ (г|город)$/, '').trim();

// Сокращения, которых нет в таблице корней addressPlace (там разбираются
// адреса, а не названия файлов).
const REGION_ALIASES = [['кчр', 'карачаево'], ['днр', 'донецк'], ['лнр', 'луганск'], ['кбр', 'кабардино']];

// «Волгоградская область 2025» → «волгоградская обл» — в том же виде, в каком
// регион лежит в первой части declarations.placeKey.
function regionKey(text) {
  let t = ' ' + norm(text) + ' ';
  for (const [abbr, stem] of REGION_ALIASES) t = t.replace(' ' + abbr + ' ', ' ' + stem + ' ');
  for (const [stem, label] of REGIONS) {
    if (new RegExp('(^|[^а-я])' + stem).test(t)) return label.toLowerCase().replace(/ё/g, 'е');
  }
  return '';
}

const STOP_WORDS = /(^| )(индивидуальный|предприниматель|ип|глава|главы|кфх|крестьянского|фермерского|хозяйства|ио|врио)(?= |$)/g;
const isPatronymicTail = w => /^(оглы|кызы)$/.test(w || '');

// ФИО из «Глава: Иванов Иван Иванович» (после двоеточия — первые три слова),
// «Генеральный директор Иванов Иван Иванович» (последние три) или из поля
// реестра «Глава КФХ Иванов Иван Иванович».
function fioOf(s, { fromEnd = false } = {}) {
  s = String(s || '');
  const colon = s.indexOf(':');
  let t = norm(colon >= 0 ? s.slice(colon + 1) : s);
  // Стоп-слова идут подряд («ип глава кфх»), одного прохода replace не хватает.
  for (let i = 0; i < 3; i++) t = t.replace(STOP_WORDS, ' ');
  const w = t.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (w.length < 3) return '';
  if (colon >= 0 || !fromEnd) return w.slice(0, isPatronymicTail(w[3]) ? 4 : 3).join(' ');
  return (isPatronymicTail(w[w.length - 1]) ? w.slice(-4) : w.slice(-3)).join(' ');
}

const isFarmName = n => /КФХ|(^|[^А-Яа-я])ИП([^А-Яа-я]|$)|К\(Ф\)Х/i.test(n);

// Телефоны ячейки → { mobiles, others } в виде +7XXXXXXXXXX (как хранит парсер
// ФСА). Короткие номера без кода («(47234) 7-56-05, 7-55-44», «2-13-02» под
// шапкой «Телефонный код района: 8-48448») достраиваются кодом; что до десяти
// цифр не достроилось — выбрасывается: звонить по такому номеру нельзя.
function parsePhones(raw, areaCode = '') {
  const mobiles = [], others = [];
  let code = areaCode;
  for (const part of String(raw || '').split(/[,;\n]+/)) {
    const inParens = part.match(/\((\d{3,6})\)/);
    let d = part.replace(/\D/g, '');
    if (!d) continue;
    if (d.length === 11 && (d[0] === '7' || d[0] === '8')) d = d.slice(1);
    else if (d.length < 10 && code && code.length + d.length === 10) d = code + d;
    if (d.length !== 10) continue;
    if (inParens && inParens[1].length >= 4) code = inParens[1];
    const list = d[0] === '9' ? mobiles : others;
    if (!list.includes('+7' + d)) list.push('+7' + d);
  }
  return { mobiles, others };
}

function walk(p) {
  if (!fs.statSync(p).isDirectory()) return /\.xlsx?$/i.test(p) && !path.basename(p).startsWith('~$') ? [p] : [];
  return fs.readdirSync(p).flatMap(name => walk(path.join(p, name)));
}

// Читает все таблицы из файлов/папок. Форматов два: «Название / Имя / Телефоны /
// Город» и «Наименование предприятия / Ф.И.О., должность руководителя / Телефон»
// с районами строками-разделителями (или листами). Листы без нужных колонок
// пропускаются и попадают в skipped.
function loadBase(paths) {
  const entries = [], files = [], skipped = [];
  for (const file of paths.flatMap(walk)) {
    const base = path.basename(file).replace(/\.xlsx?$/i, '');
    const fileRegion = regionKey(base);
    const year = Number((base.match(/20\d\d/) || [0])[0]);
    const wb = XLSX.readFile(file);
    let rowsRead = 0;
    for (const sheetName of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
      if (!rows.length) continue;
      // В шапках встречаются переносы строк внутри ячейки.
      const cell = c => String(c).replace(/\s+/g, ' ').trim();
      const hi = rows.findIndex(r => r.some(c => /^(Название|Наименование предприятия)$/.test(cell(c))));
      const header = hi >= 0 ? rows[hi].map(cell) : [];
      const col = re => header.findIndex(h => re.test(h));
      const cName = col(/^(Название|Наименование предприятия)$/);
      const cFio = col(/^(Имя|Ф\.И\.О)/);
      const cPhone = col(/^Телефон/);
      const cDistrict = col(/^(Город|Районы)$/);
      const cRegion = col(/^(Регион|Области)$/);
      if (cName < 0 || cFio < 0 || cPhone < 0) { skipped.push(`${base} [${sheetName}]`); continue; }

      const sectioned = header.includes('Наименование предприятия');
      let district = sectioned && wb.SheetNames.length > 1 ? normDistrict(sheetName) : '';
      let areaCode = '';
      for (const r of rows.slice(hi + 1)) {
        const name = String(r[cName] || '').trim();
        if (!name) continue;
        if (sectioned && !String(r[cFio] || '').trim() && !String(r[cPhone] || '').trim()) {
          // Строка-разделитель: «Абинский район. Телефонный код города: 8-86-150»
          if (/район|округ|город|г\./i.test(name)) district = normDistrict(name.split(/[.:]/)[0]);
          const codeDigits = (name.match(/код[^:]*:\s*([\d\s\-]+)/i) || ['', ''])[1].replace(/\D/g, '');
          areaCode = codeDigits.replace(/^8/, '');
          continue;
        }
        rowsRead++;
        const fio = fioOf(r[cFio], { fromEnd: sectioned }) || (isFarmName(name) ? fioOf(name, { fromEnd: true }) : '');
        const region = (cRegion >= 0 && regionKey(r[cRegion])) || fileRegion;
        const { mobiles, others } = parsePhones(r[cPhone], sectioned ? areaCode : '');
        if (!fio || !region || !(mobiles.length + others.length)) continue;
        entries.push({
          fio, region, mobiles, others, name, year, file: base, farm: isFarmName(name),
          district: sectioned ? district : normDistrict(r[cDistrict]),
        });
      }
    }
    files.push({ file: base, region: fileRegion, rows: rowsRead });
  }
  return { entries, files, skipped };
}

// ИП и КФХ реестра: ИНН → все написания ФИО, регионы и районы их деклараций.
function loadRegistryIndividuals() {
  const rows = db.prepare(`
    SELECT inn, lastName, firstName, middleName, shortName, applicantName, placeKey,
           MAX(address) AS address,
           SUM(status = 'active') AS active,
           SUM(status = 'active' AND (phone IS NULL OR phone = '')) AS activeNoPhone,
           SUM(phone IS NULL OR phone = '') AS noPhone
    FROM declarations
    WHERE length(COALESCE(inn, '')) = 12
    GROUP BY inn, placeKey, shortName, applicantName, lastName, firstName, middleName
  `).all();
  const people = new Map();
  for (const d of rows) {
    let p = people.get(d.inn);
    if (!p) people.set(d.inn, p = { inn: d.inn, fios: new Set(), regions: new Set(), districts: new Set(), active: 0, activeNoPhone: 0, noPhone: 0, address: d.address });
    for (const s of [`${d.lastName || ''} ${d.firstName || ''} ${d.middleName || ''}`, d.applicantName, d.shortName]) {
      const f = fioOf(s);
      if (f) p.fios.add(f);
    }
    const [region, district] = String(d.placeKey || '').split('|');
    if (region) p.regions.add(region);
    if (district) p.districts.add(normDistrict(district));
    p.active += d.active;
    p.activeNoPhone += d.activeNoPhone;
    p.noPhone += d.noPhone;
  }
  return people;
}

// Собирает итоговую строку: сначала мобильные, потом остальные; внутри каждой
// группы — сначала записи самого КФХ/ИП, затем из более свежих файлов.
function mergePhones(entries) {
  const sorted = [...entries].sort((a, b) => (b.farm - a.farm) || (b.year - a.year));
  const uniq = list => [...new Set(list)];
  return uniq([...sorted.flatMap(e => e.mobiles), ...sorted.flatMap(e => e.others)]).slice(0, MAX_PHONES).join(', ');
}

function matchBase(entries) {
  const people = loadRegistryIndividuals();
  const byKey = new Map();
  for (const e of entries) {
    const k = e.fio + '|' + e.region;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(e);
  }
  // Тёзок считаем по всему реестру, включая недействующие декларации.
  const namesakes = new Map();
  for (const p of people.values()) {
    for (const r of p.regions) for (const f of p.fios) {
      const k = f + '|' + r;
      if (!namesakes.has(k)) namesakes.set(k, new Set());
      namesakes.get(k).add(p.inn);
    }
  }

  const fileRegions = new Set(entries.map(e => e.region));
  const matches = [], perRegion = new Map();
  let ambiguous = 0;
  for (const p of people.values()) {
    // Покрытие по регионам считаем по действующим, а телефон ищем всем: ИП с
    // истёкшими декларациями в реестре тоже видны, и их в базах тысячи.
    for (const r of p.regions) {
      if (!p.active || !fileRegions.has(r)) continue;
      if (!perRegion.has(r)) perRegion.set(r, { total: 0, matched: 0 });
      perRegion.get(r).total++;
    }
    const cands = [];
    for (const r of p.regions) for (const f of p.fios) {
      for (const e of byKey.get(f + '|' + r) || []) cands.push({ e, key: f + '|' + r });
    }
    if (!cands.length) continue;

    const sameDistrict = cands.filter(c => c.e.district && p.districts.has(c.e.district));
    let used = null, matchedBy = '';
    if (sameDistrict.length) {
      used = sameDistrict; matchedBy = 'district';
    } else {
      // Без района — только записи самих КФХ/ИП: руководитель юрлица с тем же
      // ФИО в другом районе слишком часто оказывается другим человеком.
      const farms = cands.filter(c => c.e.farm);
      if (farms.length && Math.max(...farms.map(c => namesakes.get(c.key).size)) === 1
        && new Set(farms.map(c => c.e.district)).size === 1) {
        used = farms; matchedBy = 'region';
      }
    }
    if (!used) { ambiguous++; continue; }

    const phone = mergePhones(used.map(c => c.e));
    if (!phone) continue;
    const newest = used.map(c => c.e).sort((a, b) => (b.farm - a.farm) || (b.year - a.year))[0];
    if (p.active) perRegion.get(newest.region).matched++;
    matches.push({
      inn: p.inn, phone, matchedBy, sourceFile: newest.file, sourceName: newest.name,
      fio: newest.fio, address: p.address, baseDistrict: newest.district,
      active: p.active, activeNoPhone: p.activeNoPhone, noPhone: p.noPhone,
    });
  }
  return { matches, ambiguous, perRegion, individualsActive: [...people.values()].filter(p => p.active).length };
}

// Название юрлица без формы и кавычек: «Заря» ООО, ООО "ЗАРЯ" и Общество с
// ограниченной ответственностью «Заря» дают один ключ.
const LEGAL_FORMS = /(^| )(ооо|оао|зао|пао|ао|спк|сха|схпк|снт|тнв|кфх|кх|колхоз|общество с ограниченной ответственностью|акционерное общество|закрытое|открытое|публичное|сельскохозяйственный производственный кооператив|сельскохозяйственная артель|крестьянское фермерское хозяйство|крестьянское хозяйство|имени|им)(?= |$)/g;
function legalCore(name) {
  let t = norm(String(name || '').replace(/\([^)]*\)/g, ' '));
  for (let i = 0; i < 3; i++) t = t.replace(LEGAL_FORMS, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

// Юрлица (10-значный ИНН): ФИО руководителя в декларациях нет, поэтому сверка
// по названию + регион + район, и только если в реестре под таким ключом ровно
// одна организация. Берём только тех, у кого телефона нет: номер из карточки
// ФСА остаётся главным.
function matchLegalEntities(entries) {
  const rows = db.prepare(`
    SELECT inn, shortName, applicantName, placeKey, MAX(address) AS address,
           SUM(status = 'active') AS active,
           SUM(status = 'active' AND (phone IS NULL OR phone = '')) AS activeNoPhone,
           SUM(phone IS NULL OR phone = '') AS noPhone, COUNT(*) AS total
    FROM declarations
    WHERE length(COALESCE(inn, '')) = 10 AND placeKey LIKE '%|%'
    GROUP BY inn, shortName, applicantName, placeKey
  `).all();
  const orgs = new Map(), byKey = new Map();
  for (const d of rows) {
    let o = orgs.get(d.inn);
    if (!o) orgs.set(d.inn, o = { name: d.shortName || d.applicantName, address: d.address, active: 0, activeNoPhone: 0, noPhone: 0, total: 0 });
    o.total += d.total;
    o.active += d.active;
    o.activeNoPhone += d.activeNoPhone;
    o.noPhone += d.noPhone;
    const [region, district] = d.placeKey.split('|');
    for (const n of [d.shortName, d.applicantName]) {
      const core = legalCore(n);
      if (core.length < 3) continue;
      const k = core + '|' + region + '|' + normDistrict(district);
      if (!byKey.has(k)) byKey.set(k, new Set());
      byKey.get(k).add(d.inn);
    }
  }

  const found = new Map();
  let ambiguous = 0;
  for (const e of entries) {
    const core = legalCore(e.name);
    if (core.length < 3 || !e.district) continue;
    const inns = byKey.get(core + '|' + e.region + '|' + e.district);
    if (!inns) continue;
    if (inns.size > 1) { ambiguous++; continue; }
    const inn = [...inns][0];
    if (!found.has(inn)) found.set(inn, []);
    found.get(inn).push(e);
  }

  const matches = [];
  for (const [inn, list] of found) {
    const o = orgs.get(inn);
    // Телефон хоть в одной декларации уже есть (из карточки ФСА) — не трогаем,
    // иначе у одной компании в разных декларациях оказались бы разные номера.
    if (o.noPhone < o.total) continue;
    const phone = mergePhones(list);
    if (!phone) continue;
    const newest = [...list].sort((a, b) => b.year - a.year)[0];
    matches.push({
      inn, phone, matchedBy: 'name', sourceFile: newest.file, sourceName: newest.name,
      fio: o.name, address: o.address, baseDistrict: newest.district,
      active: o.active, activeNoPhone: o.activeNoPhone, noPhone: o.noPhone,
    });
  }
  return { matches, ambiguous };
}

const upsertImport = db.prepare(`
  INSERT INTO phone_imports (inn, phone, matchedBy, sourceFile, sourceName)
  VALUES (@inn, @phone, @matchedBy, @sourceFile, @sourceName)
  ON CONFLICT(inn) DO UPDATE SET phone = excluded.phone, matchedBy = excluded.matchedBy,
    sourceFile = excluded.sourceFile, sourceName = excluded.sourceName, importedAt = CURRENT_TIMESTAMP
`);

function saveMatches(matches) {
  db.transaction(list => { for (const m of list) upsertImport.run(m); })(matches);
  return matches.length;
}

// Проставляет телефоны из phone_imports декларациям без телефона — любым, не
// только действующим: компания с истёкшими декларациями в реестре тоже видна.
// Чужие телефоны (из карточки ФСА) не перезаписывает. Вызывается и после
// заливки, и ночью — для деклараций, пришедших после неё.
function applyImportedPhones() {
  return db.prepare(`
    UPDATE declarations
    SET phone = (SELECT p.phone FROM phone_imports p WHERE p.inn = declarations.inn)
    WHERE (phone IS NULL OR phone = '')
      AND inn IN (SELECT inn FROM phone_imports)
  `).run().changes;
}

// Откат: убирает из деклараций ровно те телефоны, что пришли из баз, и чистит
// phone_imports. Телефоны, отличающиеся от залитых, не трогает.
function rollbackImportedPhones() {
  return db.transaction(() => {
    const cleared = db.prepare(`
      UPDATE declarations SET phone = ''
      WHERE inn IN (SELECT inn FROM phone_imports)
        AND phone = (SELECT p.phone FROM phone_imports p WHERE p.inn = declarations.inn)
    `).run().changes;
    const removed = db.prepare('DELETE FROM phone_imports').run().changes;
    return { cleared, removed };
  })();
}

module.exports = { loadBase, matchBase, matchLegalEntities, saveMatches, applyImportedPhones, rollbackImportedPhones, parsePhones, fioOf, regionKey };
