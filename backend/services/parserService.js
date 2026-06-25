const db = require('./db');
const logger = require('./logger');
const parser = require('./parser');
const { enrichRecords } = require('./innEnricher');
const { backfillMissingInn } = require('./dedupe');
const { archiveOldDeclarations } = require('./archiver');
const telegramBot = require('./telegramBot');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runParser(apiClient, declarationService, config) {
  logger.info('Parser loop starting...');

  const CONFIG = {
    PAGE_SIZE: Math.min(100, Math.max(1, config.PAGE_SIZE || 100)),
    MAX_PAGES_PER_RUN: config.MAX_PAGES_PER_RUN || 0,
    DELAY_MS: config.DELAY_MS || 1500,
    MAX_RECORDS: config.MAX_RECORDS || 0,
    TECH_REGLAMENT: (config.TECH_REGLAMENT || '').trim().toLowerCase(),
    TECH_REG_IDS: config.TECH_REG_IDS || [32],
    DATE_FROM: config.DATE_FROM || '',
    DATE_TO: config.DATE_TO || '',
    DATE_CHUNK: config.DATE_CHUNK || 0,
  };

  const setStatus = (state, message, parsed = 0, errors = 0) => {
    db.prepare(`
      INSERT INTO status (id, state, message, parsed, errors, time)
      VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        state = excluded.state,
        message = excluded.message,
        parsed = excluded.parsed,
        errors = excluded.errors,
        time = excluded.time
    `).run(state, message, parsed, errors, new Date().toISOString());
  };

  function declarationsListPayload(pageIndex, dateFrom, dateTo) {
    return {
      page: pageIndex,
      size: CONFIG.PAGE_SIZE,
      count: 0,
      columnsSort: [{ column: 'declDate', sort: 'DESC' }],
      filter: {
        idTechReg: CONFIG.TECH_REG_IDS,
        regDate: { minDate: dateFrom || null, maxDate: dateTo || null },
        ...config.FILTERS,
      },
    };
  }

  function generateDateWindows(fromStr, toStr, chunkDays) {
    const windows = [];
    const from = new Date(fromStr);
    const to = toStr ? new Date(toStr) : new Date();
    to.setHours(23, 59, 59, 999);
    let cur = new Date(from);
    while (cur <= to) {
      const end = new Date(cur);
      end.setDate(end.getDate() + chunkDays - 1);
      if (end > to) end.setTime(to.getTime());
      windows.push({
        from: cur.toISOString().slice(0, 10),
        to: end.toISOString().slice(0, 10),
      });
      cur.setDate(cur.getDate() + chunkDays);
    }
    return windows;
  }

  async function runPageLoop(dateFrom, dateTo, newRecords, windowLabel) {
    const maxPages = CONFIG.MAX_PAGES_PER_RUN > 0 ? CONFIG.MAX_PAGES_PER_RUN : Number.MAX_SAFE_INTEGER;
    let page = 0;
    let registryTotal = null;
    let listFetchFailures = 0;
    let parsed = 0;
    let errors = 0;
    let hitApiLimit = false;

    while (page < maxPages) {
      const windowInfo = windowLabel ? ` [${windowLabel}]` : '';
      logger.info(`Parser: страница ${page + 1}${windowInfo}`);
      const payload = declarationsListPayload(page, dateFrom, dateTo);
      let pageData;
      try {
        pageData = await apiClient.postDeclarationsList(payload);
        listFetchFailures = 0;
      } catch (e) {
        const code = e.response?.status;
        const apiCode = e.response?.data?.code;
        if (code === 400 && apiCode === 'RDS-APP-9995') {
          logger.warn(`Parser: достигнут лимит страниц FSA API (стр. ${page + 1})${windowInfo} — уменьшите FSA_DATE_CHUNK`);
          hitApiLimit = true;
          break;
        }
        errors++;
        listFetchFailures++;
        logger.warn(`Parser: ошибка страницы ${page + 1}${windowInfo} (${listFetchFailures}/10): ${e.message}`);
        if (listFetchFailures >= 10) break;

        if (code === 401 || code === 403) {
          apiClient.invalidateToken();
          await apiClient.ensureAuth();
          continue;
        } else {
          await sleep(CONFIG.DELAY_MS * 2);
          continue;
        }
      }

      if (registryTotal == null && pageData?.total != null) {
        registryTotal = Number(pageData.total);
      }

      const items = pageData?.items || pageData?.content || pageData?.data || [];
      logger.info(`Parser: стр. ${page + 1}${windowInfo} — получено ${items.length} позиций`);
      if (!items.length) break;
      setStatus('running', `Стр. ${page + 1}${windowInfo}: ${items.length} позиций, новых: ${parsed}`, parsed, errors);

      for (const item of items) {
        const declId = String(item.id || item.declId || item.declarationId || '');
        if (!declId) continue;

        if (CONFIG.TECH_REGLAMENT) {
          const tr = String(item.technicalReglaments || '').toLowerCase();
          if (!tr.includes(CONFIG.TECH_REGLAMENT)) continue;
        }

        const existing = db.prepare('SELECT id FROM declarations WHERE id = ? OR fsaId = ?').get(declId, declId);
        if (existing) {
          const mappedStatus = parser.mapStatus(item.status || item.docStatus || item.idStatus);
          db.prepare('UPDATE declarations SET status = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?').run(mappedStatus, existing.id);
          continue;
        }

        let detail = null;
        try {
          detail = await apiClient.getDeclarationById(declId);
          await sleep(300);
        } catch (e) {
          if (e.response?.status !== 404) errors++;
        }

        const rec = parser.mapRecordForDb(item, detail, apiClient.getBaseUrl());

        const columns = ['id', 'fsaId', 'declNumber', 'source', 'status', 'productGroup', 'technicalReglament', 'regDate', 'endDate', 'lastName', 'firstName', 'middleName', 'shortName', 'address', 'phone', 'productName', 'batchSize', 'otherInfo', 'fsaUrl', 'fetchedAt', 'productionSites'];
        const placeholders = columns.map(() => '?').join(', ');
        const values = columns.map(col => {
          if (col === 'productGroup') return rec.group || '';
          if (col === 'productionSites') return JSON.stringify(rec.productionSites || []);
          return rec[col] || '';
        });

        try {
          db.prepare(`INSERT INTO declarations (${columns.join(', ')}) VALUES (${placeholders})`).run(...values);
          newRecords.push(rec);
          parsed++;
        } catch (err) {
          logger.error('DB Insert error: %s', err.message);
        }
      }

      if (items.length < CONFIG.PAGE_SIZE) break;
      page++;
      await sleep(CONFIG.DELAY_MS);
    }

    return { parsed, errors, hitApiLimit };
  }

  function daysBetween(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }
  function addDays(dateStr, n) {
    const d = new Date(dateStr);
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  }

  // FSA отдаёт максимум ~20 страниц на один запрос (RDS-APP-9995 на 21-й).
  // Если окно упирается в этот лимит, делим его пополам по дням и пересканируем
  // каждую половину рекурсивно — иначе декларации сверх ~2000 на окно
  // молча терялись бы на каждом прогоне навсегда.
  async function processWindow(from, to, newRecords, depth = 0) {
    if (!to) {
      // Открытое окно (без верхней границы даты) — дробить по дням нельзя,
      // оставляем как раньше: просканировать и просто предупредить при лимите.
      const { parsed, errors } = await runPageLoop(from, to, newRecords, from ? `${from}–сейчас` : null);
      return { parsed, errors };
    }

    const label = `${from}–${to}`;
    const { parsed, errors, hitApiLimit } = await runPageLoop(from, to, newRecords, label);
    const totalDays = daysBetween(from, to) + 1;

    if (hitApiLimit && totalDays > 1 && depth < 10) {
      const half = Math.floor(totalDays / 2);
      const firstTo = addDays(from, half - 1);
      const secondFrom = addDays(from, half);
      logger.warn(`Parser: окно ${label} превысило лимит страниц — делим на ${from}–${firstTo} и ${secondFrom}–${to}`);
      await sleep(CONFIG.DELAY_MS);
      const r1 = await processWindow(from, firstTo, newRecords, depth + 1);
      await sleep(CONFIG.DELAY_MS);
      const r2 = await processWindow(secondFrom, to, newRecords, depth + 1);
      return { parsed: parsed + r1.parsed + r2.parsed, errors: errors + r1.errors + r2.errors };
    }

    if (hitApiLimit) {
      logger.error(`Parser: окно ${label} (1 день) всё равно превышает лимит страниц FSA — часть деклараций за этот день может быть потеряна`);
    }
    return { parsed, errors };
  }

  let windows;
  if (CONFIG.DATE_CHUNK > 0 && CONFIG.DATE_FROM) {
    windows = generateDateWindows(CONFIG.DATE_FROM, CONFIG.DATE_TO, CONFIG.DATE_CHUNK);
  } else {
    windows = [{ from: CONFIG.DATE_FROM, to: CONFIG.DATE_TO }];
  }

  // Каждый перезапуск процесса (деплой, pm2 restart) иначе откатывал бы
  // прогон обратно к DATE_FROM — продолжаем с того места, где остановились
  // в прошлый раз, а не пересканируем уже пройденные окна с нуля.
  const forceRescan = String(process.env.FSA_FORCE_RESCAN || '').toLowerCase() === 'true';
  const prevStatus = db.prepare('SELECT lastCompletedDate FROM status WHERE id = 1').get();
  const resumeFrom = !forceRescan && prevStatus?.lastCompletedDate ? prevStatus.lastCompletedDate : null;
  if (resumeFrom) {
    const skipped = windows.filter(w => w.to && w.to <= resumeFrom).length;
    windows = windows.filter(w => !w.to || w.to > resumeFrom);
    if (skipped > 0) logger.info(`Parser: продолжаем с чекпоинта ${resumeFrom} — пропущено ${skipped} уже пройденных окон`);
  }

  setStatus('running', 'Авторизация...');
  const token = await apiClient.ensureAuth();
  if (!token) {
    setStatus('error', 'Не удалось получить токен.');
    return;
  }

  let totalParsed = 0;
  let totalErrors = 0;
  const newRecords = [];

  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    const label = `${w.from}–${w.to || 'сейчас'}`;
    setStatus('running', `Окно ${i + 1}/${windows.length}: ${label}`, totalParsed, totalErrors);

    const { parsed, errors } = await processWindow(w.from, w.to, newRecords);
    totalParsed += parsed;
    totalErrors += errors;

    // Чекпоинт: окно пройдено (даже если что-то внутри не дотянули) — при
    // следующем запуске/перезапуске не возвращаемся к нему заново.
    // Не чекпоинтим окно, которое включает сегодня — иначе декларации,
    // опубликованные позже в течение того же дня, перестанут подхватываться.
    const todayStr = new Date().toISOString().slice(0, 10);
    if (w.to && w.to < todayStr) db.prepare('UPDATE status SET lastCompletedDate = ? WHERE id = 1').run(w.to);

    if (i < windows.length - 1) await sleep(CONFIG.DELAY_MS);
  }

  const msg = `Готово. Новых: ${newRecords.length}, ошибок: ${totalErrors}`;
  setStatus('idle', msg, totalParsed, totalErrors);
  logger.info('Parser finished: %s', msg);

  setImmediate(async () => {
    try {
      if (newRecords.length > 0) {
        await enrichRecords(newRecords);
        const updateStmt = db.prepare('UPDATE declarations SET farmerType = ?, okved = ?, inn = ? WHERE id = ?');
        const transaction = db.transaction((recs) => {
          for (const r of recs) {
            updateStmt.run(r.farmerType, r.okved, r.inn, r.id);
          }
        });
        transaction(newRecords);
        await telegramBot.notifyFavorites(newRecords);
      }

      const dedupeCount = backfillMissingInn();
      if (dedupeCount > 0) logger.info('[DEDUPE] Проставлен ИНН по совпадению имя+адрес: %d записей', dedupeCount);

      const archivedCount = archiveOldDeclarations();
      if (archivedCount > 0) logger.info('[ARCHIVE] Переведено в архив (старше года, но "действует" по ФСА): %d записей', archivedCount);
    } catch (e) {
      logger.error('Post-parse step error: %s', e.message);
    }
  });
}

module.exports = { runParser };
