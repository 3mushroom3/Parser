/**
 * Выгрузка лидов в CRM клиента — платная опция по образцу конкурента
 * («Агро Радар» берёт за это 24 000 ₽/мес). MVP: один Bitrix24-вебхук на
 * пользователя, amoCRM — заглушка до получения OAuth-креда (нужна
 * регистрация интеграции в маркетплейсе amoCRM, это делает пользователь).
 *
 * filterJson — тот же формат, что фильтры /api/declarations/producers
 * (product, address, farmerType, batchMin/Max, manufacturer) — клиент
 * настраивает «свой» срез реестра, и только подходящие новые декларации
 * улетают ему как лиды.
 */
const axios = require('axios');
const db = require('./db');
const logger = require('./logger');

const http = axios.create({ timeout: 15000, validateStatus: () => true });

// Строит WHERE-условие по сохранённому фильтру интеграции + lastSyncAt —
// те же поля, что и в routes/declarations.js /producers, но без группировки:
// здесь нужны отдельные декларации, а не агрегированные производители.
function buildQuery(filterJson, sinceIso) {
  const f = filterJson || {};
  let where = "d.status = 'active' AND d.fetchedAt > ?";
  const params = [sinceIso];

  if (f.product) { where += ' AND lower_u(d.productName) LIKE ?'; params.push(`%${String(f.product).toLowerCase()}%`); }
  if (f.address) { where += ' AND lower_u(d.address) LIKE ?'; params.push(`%${String(f.address).toLowerCase()}%`); }
  if (f.manufacturer) {
    where += ' AND (lower_u(d.shortName) LIKE ? OR lower_u(d.applicantName) LIKE ? OR lower_u(d.lastName) LIKE ?)';
    const m = `%${String(f.manufacturer).toLowerCase()}%`;
    params.push(m, m, m);
  }
  if (f.farmerType === 'farmer') where += " AND d.farmerType IN ('farmer','farmer_trader')";
  else if (f.farmerType === 'trader') where += " AND d.farmerType IN ('trader','trader_farmer')";
  else if (f.farmerType) { where += ' AND d.farmerType = ?'; params.push(f.farmerType); }
  if (f.batchMin) { where += ' AND d.batchTons >= ?'; params.push(Number(f.batchMin)); }
  if (f.batchMax) { where += ' AND d.batchTons <= ?'; params.push(Number(f.batchMax)); }

  return { where, params };
}

function findMatchingLeads(filterJson, sinceIso, limit = 200) {
  const { where, params } = buildQuery(filterJson, sinceIso);
  return db.prepare(`
    SELECT d.id, d.productName, d.batchSize, d.address, d.phone, d.inn,
           d.shortName, d.applicantName, d.lastName, d.regDate, d.fetchedAt
    FROM declarations d
    WHERE ${where}
    ORDER BY d.fetchedAt ASC
    LIMIT ?
  `).all(...params, limit);
}

function leadTitle(lead) {
  const company = lead.shortName || lead.applicantName || lead.lastName || 'Без названия';
  return `${lead.productName || 'Декларация'} — ${company}`.slice(0, 250);
}

function leadComment(lead) {
  return [
    lead.batchSize ? `Объём: ${lead.batchSize}` : '',
    lead.address ? `Адрес: ${lead.address}` : '',
    lead.inn ? `ИНН: ${lead.inn}` : '',
    `Декларация: ${lead.regDate || ''} (id ${lead.id})`,
  ].filter(Boolean).join('\n');
}

async function pushToBitrix24(integration, leads) {
  const base = String(integration.webhookUrl || '').replace(/\/?$/, '/');
  let sent = 0;
  for (const lead of leads) {
    const resp = await http.post(base + 'crm.lead.add.json', {
      fields: {
        TITLE: leadTitle(lead),
        NAME: lead.shortName || lead.applicantName || lead.lastName || '',
        SOURCE_ID: 'WEB',
        SOURCE_DESCRIPTION: 'База АПК',
        COMMENTS: leadComment(lead),
        PHONE: lead.phone ? [{ VALUE: lead.phone, VALUE_TYPE: 'WORK' }] : undefined,
      },
      params: { REGISTER_SONET_EVENT: 'Y' },
    });
    if (resp.status !== 200 || resp.data?.error) {
      throw new Error(resp.data?.error_description || resp.data?.error || `HTTP ${resp.status}`);
    }
    sent++;
  }
  return sent;
}

async function pushToAmoCrm() {
  throw new Error('amoCRM пока не подключён — нужна OAuth-интеграция, зарегистрированная в маркетплейсе amoCRM');
}

/** Один прогон для одной интеграции. Возвращает {sent, error}. */
async function syncIntegration(integration) {
  const filterJson = JSON.parse(integration.filterJson || '{}');
  const since = integration.lastSyncAt || new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const leads = findMatchingLeads(filterJson, since);
  if (!leads.length) {
    db.prepare('UPDATE crm_integrations SET lastSyncAt = ?, lastError = NULL WHERE id = ?')
      .run(new Date().toISOString(), integration.id);
    return { sent: 0 };
  }

  const pusher = integration.provider === 'amocrm' ? pushToAmoCrm : pushToBitrix24;
  try {
    const sent = await pusher(integration, leads);
    const newSince = leads[leads.length - 1].fetchedAt;
    db.prepare('UPDATE crm_integrations SET lastSyncAt = ?, lastError = NULL WHERE id = ?').run(newSince, integration.id);
    return { sent };
  } catch (e) {
    logger.warn(`[CRM] Ошибка выгрузки (integration #${integration.id}, ${integration.provider}): ${e.message}`);
    db.prepare('UPDATE crm_integrations SET lastError = ? WHERE id = ?').run(e.message.slice(0, 500), integration.id);
    return { sent: 0, error: e.message };
  }
}

/** Проходит по всем активным интеграциям — вызывается по cron из server.js. */
async function runCrmSync() {
  const integrations = db.prepare(`
    SELECT ci.* FROM crm_integrations ci
    JOIN users u ON u.id = ci.userId
    WHERE ci.active = 1 AND u.crmEnabled = 1
  `).all();
  let totalSent = 0;
  for (const integration of integrations) {
    const { sent } = await syncIntegration(integration);
    totalSent += sent;
  }
  if (integrations.length) logger.info(`[CRM] Синхронизация: ${integrations.length} интеграций, ${totalSent} лидов отправлено`);
  return { integrations: integrations.length, sent: totalSent };
}

module.exports = { findMatchingLeads, syncIntegration, runCrmSync, pushToBitrix24, leadTitle, leadComment };
