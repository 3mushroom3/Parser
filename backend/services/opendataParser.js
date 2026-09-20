const fs = require('fs');
const { parse } = require('csv-parse');
const parser = require('./parser');
const log = require('./logger');
const { parseBatchTons } = require('./batchSize');

/**
 * Парсинг CSV из открытых данных РДС (см. opendataClient.js) и маппинг строк
 * в ту же форму записи, что и parser.mapRecordForDb (живой API), чтобы обе
 * дорожки писали в одну таблицу declarations без расхождений по полям.
 */

/**
 * Потоково читает csvPath, отбирает строки где "Тех регламенты" содержит
 * techRegMatch (регистронезависимо) и возвращает их массивом. Сам файл (до
 * полугигабайта) в память не грузится — читается построчно потоком; в память
 * попадают только отфильтрованные строки (десятки тысяч, не миллионы).
 *
 * Матчи собираются в массив, а не пишутся в БД по одной строке за раз — так
 * вызывающий код может вставить их одной транзакцией. Вставка по одной строке
 * без транзакции у better-sqlite3 делает fsync на каждый INSERT и на ~30к
 * строк занимает единицы минут вместо долей секунды одним batch'ем.
 * @returns {Promise<{rowsSeen: number, rows: object[]}>}
 */
async function parseAndFilterCsv(csvPath, techRegMatch) {
  const needle = String(techRegMatch || '').trim().toLowerCase();
  const stream = fs.createReadStream(csvPath).pipe(
    parse({
      delimiter: ';',
      columns: true,
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
    })
  );

  let rowsSeen = 0;
  const rows = [];
  for await (const row of stream) {
    rowsSeen++;
    if (rowsSeen % 50000 === 0) log.info(`opendata: ...прочитано ${rowsSeen} строк, совпало ${rows.length}`);
    const techReg = String(row['Тех регламенты'] || '').toLowerCase();
    if (needle && !techReg.includes(needle)) continue;
    rows.push(row);
  }
  return { rowsSeen, rows };
}

function pick(row, ...keys) {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

/** Строка CSV открытых данных → запись declarations (та же форма, что parser.mapRecordForDb) */
function mapCsvRowToDbRecord(row, fsaBaseUrl) {
  const id = pick(row, 'id');
  const manufacturerName = pick(row, 'Изготовитель');
  const applicantName = pick(row, 'Заявитель');
  const manufacturerInn = pick(row, 'ИНН производителя');
  const applicantInn = pick(row, 'ИНН Заявителя');
  const manufacturerAddress = pick(row, 'Адрес изготовителя');
  const applicantAddress = pick(row, 'Адрес Заявителя');

  return {
    id,
    fsaId: id,
    declNumber: pick(row, 'Номер ДС'),
    source: 'fsa',
    status: parser.mapStatus(pick(row, 'Статус')),
    group: pick(row, 'Группа продукции'),
    technicalReglament: pick(row, 'Тех регламенты'),
    regDate: parser.fmtDateRu(pick(row, 'Дата рег')),
    endDate: parser.fmtDateRu(pick(row, 'Срок действия')),
    inn: manufacturerInn || applicantInn,
    lastName: '',
    firstName: '',
    middleName: '',
    shortName: manufacturerName || applicantName,
    fullName: manufacturerName || applicantName,
    applicantName,
    address: manufacturerAddress || applicantAddress,
    productionSites: '[]',
    phone: '',
    farmerType: 'unknown',
    productName: pick(row, 'Полное наименование'),
    batchSize: pick(row, 'Размер партии'),
    batchTons: parseBatchTons(pick(row, 'Размер партии')),
    otherInfo: [pick(row, 'Обозначение'), pick(row, 'Стандарт продукции')].filter(Boolean).join(' '),
    fsaUrl: id ? `${fsaBaseUrl}/rds/declaration/view/${id}` : '',
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { parseAndFilterCsv, mapCsvRowToDbRecord };
