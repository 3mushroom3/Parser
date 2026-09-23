/**
 * Дозагрузка телефонов из карточек деклараций FSA API.
 *
 * Зачем: в выгрузке открытых данных РДС 57 колонок и ни одной с контактами
 * (см. structure-*.csv на странице открытых данных), поэтому у всего, что
 * пришло оттуда — а это основная масса реестра, — телефона нет вовсе. Телефон
 * отдаёт только карточка декларации в живом API, а записи из открытых данных
 * её никогда не запрашивали.
 *
 * Запрашиваем одну карточку на компанию, а найденный телефон проставляем всем
 * её действующим декларациям: на первой тысяче компаний это давало около 40
 * деклараций на запрос. API стоит за антифрод-WAF (см. CLAUDE.md), поэтому
 * прогон идёт с паузами и дневным лимитом, а не одним махом.
 */
const cfg = require('../config/fsaConfig');
const db = require('./db');
const log = require('./logger');
const parser = require('./parser');
const { createFsaApiClient } = require('./apiClient');

// Опрошенные компании помечаем, иначе те, у кого контактов в реестре нет,
// запрашивались бы на каждом прогоне заново.
db.exec(`
  CREATE TABLE IF NOT EXISTS phone_backfill (
    companyKey TEXT PRIMARY KEY,
    fsaId TEXT,
    found INTEGER DEFAULT 0,
    attemptedAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

const COMPANY_KEY = "COALESCE(NULLIF(inn, ''), shortName)";

const selectCompanies = db.prepare(`
  SELECT ${COMPANY_KEY} AS companyKey, MAX(fsaId) AS fsaId, COUNT(*) AS declCount
  FROM declarations
  WHERE status = 'active'
    AND (phone IS NULL OR phone = '')
    AND fsaId IS NOT NULL AND fsaId != ''
    AND ${COMPANY_KEY} IS NOT NULL AND ${COMPANY_KEY} != ''
    AND NOT EXISTS (SELECT 1 FROM phone_backfill p WHERE p.companyKey = ${COMPANY_KEY})
  GROUP BY companyKey
  ORDER BY declCount DESC
  LIMIT ?
`);

const updatePhone = db.prepare(`
  UPDATE declarations SET phone = ?
  WHERE status = 'active' AND (phone IS NULL OR phone = '') AND ${COMPANY_KEY} = ?
`);

const markDone = db.prepare(`
  INSERT INTO phone_backfill (companyKey, fsaId, found) VALUES (?, ?, ?)
  ON CONFLICT(companyKey) DO UPDATE SET fsaId = excluded.fsaId, found = excluded.found,
    attemptedAt = CURRENT_TIMESTAMP
`);

const phoneJob = { running: false, checked: 0, found: 0, declsUpdated: 0, startedAt: null, finishedAt: null, lastError: null };

function pendingCompanies() {
  return db.prepare(`
    SELECT COUNT(*) c FROM (
      SELECT ${COMPANY_KEY} AS k FROM declarations
      WHERE status = 'active' AND (phone IS NULL OR phone = '') AND fsaId IS NOT NULL AND fsaId != ''
      GROUP BY k
    ) WHERE k IS NOT NULL AND k != ''
  `).get().c;
}

async function runPhoneBackfill({ limit = 2000, delay = Number(process.env.FSA_DETAIL_DELAY_MS) || 400, onProgress } = {}) {
  if (phoneJob.running) {
    log.info('[PHONES] Пропуск: дозагрузка уже идёт');
    return null;
  }
  Object.assign(phoneJob, { running: true, checked: 0, found: 0, declsUpdated: 0, startedAt: new Date().toISOString(), finishedAt: null, lastError: null });

  try {
    const companies = selectCompanies.all(limit);
    if (!companies.length) {
      log.info('[PHONES] Все компании уже опрошены');
      return { checked: 0, found: 0, empty: 0, failed: 0, declsUpdated: 0 };
    }

    const api = createFsaApiClient(cfg);
    let found = 0, empty = 0, failed = 0, declsUpdated = 0, errorStreak = 0;

    for (let i = 0; i < companies.length; i++) {
      const c = companies[i];
      try {
        const detail = await api.getDeclarationById(c.fsaId);
        const mapped = parser.mapToGetDeclarationData(detail);
        const phone = (mapped && mapped.manufacturer && mapped.manufacturer.phone) || '';
        if (phone) {
          declsUpdated += updatePhone.run(phone, c.companyKey).changes;
          found++;
        } else {
          empty++;
        }
        markDone.run(c.companyKey, String(c.fsaId), phone ? 1 : 0);
        errorStreak = 0;
      } catch (err) {
        failed++;
        errorStreak++;
        // Подряд идущие ошибки означают бан или падение API — продолжать
        // бессмысленно и вредно: WAF реагирует именно на всплески.
        if (errorStreak >= 10) {
          log.warn(`[PHONES] Прервано: 10 ошибок подряд, последняя — ${err.message}`);
          break;
        }
      }
      Object.assign(phoneJob, { checked: i + 1, found, declsUpdated });
      if (onProgress && (i + 1) % 50 === 0) onProgress({ i: i + 1, total: companies.length, found, empty, failed });
      if (delay) await new Promise(r => setTimeout(r, delay));
    }

    log.info(`[PHONES] Опрошено ${found + empty + failed} компаний: с телефоном ${found}, без контактов ${empty}, ошибок ${failed}; проставлено деклараций ${declsUpdated}`);
    return { checked: found + empty + failed, found, empty, failed, declsUpdated };
  } catch (err) {
    phoneJob.lastError = err.message;
    log.error('[PHONES] Ошибка: %s', err.message);
    throw err;
  } finally {
    Object.assign(phoneJob, { running: false, finishedAt: new Date().toISOString() });
  }
}

module.exports = { runPhoneBackfill, pendingCompanies, phoneJob };
