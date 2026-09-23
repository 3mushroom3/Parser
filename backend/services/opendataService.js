const fs = require('fs');
const path = require('path');
const db = require('./db');
const log = require('./logger');
const opendataClient = require('./opendataClient');
const { parseAndFilterCsv, mapCsvRowToDbRecord } = require('./opendataParser');

/**
 * Оркестрация импорта из открытых данных РДС: скачивает новые (ещё не
 * импортированные) месячные архивы, распаковывает, фильтрует по регламенту
 * и дозаполняет declarations — не трогая записи, уже загруженные живым API
 * (см. wild-roaming-heron plan). Источник полноты, не свежести:
 * cron запускается раз в сутки, живой парсер остаётся основным (30 мин).
 */

const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO declarations
    (id, fsaId, declNumber, source, status, productGroup, technicalReglament, regDate, endDate,
     applicantName, lastName, firstName, middleName, shortName, address, phone,
     productName, batchSize, batchTons, otherInfo, fsaUrl, fetchedAt, farmerType, inn, productionSites)
  VALUES
    (@id, @fsaId, @declNumber, @source, @status, @group, @technicalReglament, @regDate, @endDate,
     @applicantName, @lastName, @firstName, @middleName, @shortName, @address, @phone,
     @productName, @batchSize, @batchTons, @otherInfo, @fsaUrl, @fetchedAt, @farmerType, @inn, @productionSites)
`);

const markImportedStmt = db.prepare(`
  INSERT INTO opendata_imports (filename, rowsSeen, rowsMatched, rowsInserted)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(filename) DO UPDATE SET
    importedAt = CURRENT_TIMESTAMP, rowsSeen = excluded.rowsSeen,
    rowsMatched = excluded.rowsMatched, rowsInserted = excluded.rowsInserted
`);

function isImported(filename) {
  return !!db.prepare('SELECT 1 FROM opendata_imports WHERE filename = ?').get(filename);
}

/**
 * Тот же период, но с другой датой структуры. ФСА перевыпускает архив, когда
 * меняет схему выгрузки: имя файла становится другим, а срез данных тот же.
 * Сверка по полному имени считала такой архив новым и качала его каждую ночь
 * заново — гигабайт трафика впустую, тем более что записи ложатся через
 * INSERT OR IGNORE по id и ничего бы не добавили.
 */
function isPeriodImported(filename) {
  const m = /^data-(\d{8})-/.exec(filename);
  if (!m) return false;
  const row = db.prepare("SELECT filename FROM opendata_imports WHERE filename LIKE ?").get(`data-${m[1]}-%`);
  return row ? row.filename : null;
}

function rmSafe(p) {
  try { fs.rmSync(p, { force: true }); } catch (e) { log.warn(`opendata: не удалось удалить ${p}: ${e.message}`); }
}

const insertMany = db.transaction((records) => {
  let inserted = 0;
  for (const rec of records) {
    const info = insertStmt.run(rec);
    if (info.changes > 0) inserted++;
  }
  return inserted;
});

async function importOneCsv(csvPath, techRegMatch, fsaBaseUrl) {
  const { rowsSeen, rows } = await parseAndFilterCsv(csvPath, techRegMatch);
  const records = rows.map((row) => mapCsvRowToDbRecord(row, fsaBaseUrl)).filter((r) => r.id);
  const rowsInserted = insertMany(records);
  return { rowsSeen, rowsMatched: rows.length, rowsInserted };
}

/**
 * @param {object} cfg — fsaConfig (использует cfg.opendata.* и cfg.fsaBaseUrl)
 * @param {object} [opts]
 * @param {number} [opts.limit] — обработать не более N новых архивов (для теста)
 * @param {string} [opts.techRegMatch] — подстрока регламента (по умолчанию FSA_TECH_REGLAMENT)
 */
async function runOpendataImport(cfg, opts = {}) {
  const techRegMatch = (opts.techRegMatch ?? process.env.FSA_TECH_REGLAMENT ?? '').trim().toLowerCase();
  const cacheDir = cfg.opendata.cacheDir;
  const archiveDir = path.join(cacheDir, 'archives');
  const extractDir = path.join(cacheDir, 'extract');

  log.info('opendata: проверка новых архивов...');
  const archives = await opendataClient.listAvailableArchives(cfg.opendata.pageUrl);
  const pending = archives.filter((a) => {
    if (isImported(a.filename)) return false;
    const already = isPeriodImported(a.filename);
    if (already) {
      log.info(`opendata: ${a.filename} — тот же период уже загружен из ${already}, пропуск`);
      return false;
    }
    return true;
  });
  const toProcess = opts.limit ? pending.slice(0, opts.limit) : pending;

  if (!toProcess.length) {
    log.info('opendata: новых архивов нет');
    return { processed: 0 };
  }
  log.info(`opendata: к обработке ${toProcess.length} архивов (из ${pending.length} новых)`);

  let totalInserted = 0;
  for (const archive of toProcess) {
    log.info(`opendata: обработка ${archive.filename}`);
    let archivePath;
    try {
      archivePath = await opendataClient.downloadArchive(archive, archiveDir);
      const csvPaths = await opendataClient.extractArchive(archivePath, extractDir);

      // Архивы за 2022 год внутри содержат CSV в разных легаси-форматах (другой
      // разделитель/схема колонок в разные месяцы) — ошибка в одном файле не
      // должна ронять весь архив и не должна вызывать бесконечный ре-докачку
      // (сотни МБ) на каждом следующем cron-запуске.
      let seen = 0, matched = 0, inserted = 0;
      for (const csvPath of csvPaths) {
        try {
          const r = await importOneCsv(csvPath, techRegMatch, cfg.fsaBaseUrl);
          seen += r.rowsSeen; matched += r.rowsMatched; inserted += r.rowsInserted;
        } catch (e) {
          log.error(`opendata: ошибка парсинга ${path.basename(csvPath)} (пропущен): ${e.message}`);
        } finally {
          rmSafe(csvPath);
        }
      }

      markImportedStmt.run(archive.filename, seen, matched, inserted);
      totalInserted += inserted;
      log.info(`opendata: ${archive.filename} — строк: ${seen}, совпало: ${matched}, добавлено новых: ${inserted}`);
    } catch (e) {
      log.error(`opendata: ошибка обработки ${archive.filename}: ${e.message}`);
    } finally {
      if (archivePath) rmSafe(archivePath);
    }
  }

  log.info(`opendata: готово. Архивов обработано: ${toProcess.length}, новых деклараций: ${totalInserted}`);
  return { processed: toProcess.length, inserted: totalInserted };
}

module.exports = { runOpendataImport };
