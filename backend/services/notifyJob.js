/**
 * Два фоновых уведомления в MAX (services/maxBot.js), оба — только тем, у
 * кого привязан maxUserId:
 *   1. Напоминания по заметкам (notes.notifyTime).
 *   2. Новые декларации по сохранённым подпискам (saved_searches) — тот же
 *      фильтр и поиск, что у CRM-выгрузки (services/crmExport.js).
 */
const db = require('./db');
const logger = require('./logger');
const maxBot = require('./maxBot');
const { findMatchingLeads } = require('./crmExport');

async function runNoteReminders() {
  if (!maxBot.isConfigured()) return { sent: 0 };
  const due = db.prepare(`
    SELECT n.id, n.title, n.content, u.maxUserId
    FROM notes n
    JOIN users u ON u.id = n.userId
    WHERE n.notifyTime IS NOT NULL AND n.notifySentDate IS NULL
      AND n.notifyTime <= datetime('now') AND u.maxUserId IS NOT NULL
  `).all();

  let sent = 0;
  for (const note of due) {
    try {
      await maxBot.sendMessage(note.maxUserId, `🔔 Напоминание по заметке «${note.title}»${note.content ? '\n\n' + note.content.slice(0, 500) : ''}`);
      db.prepare('UPDATE notes SET notifySentDate = ? WHERE id = ?').run(new Date().toISOString(), note.id);
      sent++;
    } catch (e) {
      logger.warn('[MAX] Не удалось отправить напоминание по заметке #%s: %s', note.id, e.message);
    }
  }
  return { sent };
}

async function runSavedSearches() {
  if (!maxBot.isConfigured()) return { sent: 0 };
  const searches = db.prepare(`
    SELECT s.* FROM saved_searches s
    JOIN users u ON u.id = s.userId
    WHERE s.active = 1 AND u.maxUserId IS NOT NULL
  `).all();

  let sent = 0;
  for (const search of searches) {
    const user = db.prepare('SELECT maxUserId FROM users WHERE id = ?').get(search.userId);
    const filter = JSON.parse(search.filterJson || '{}');
    const since = search.lastCheckedAt || new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const matches = findMatchingLeads(filter, since, 50);
    if (!matches.length) {
      db.prepare('UPDATE saved_searches SET lastCheckedAt = ? WHERE id = ?').run(new Date().toISOString(), search.id);
      continue;
    }
    const label = search.name || 'без названия';
    const lines = matches.slice(0, 5).map(m => `• ${m.productName}${m.batchSize ? ' — ' + m.batchSize : ''}`);
    const more = matches.length > 5 ? `\n…и ещё ${matches.length - 5}` : '';
    try {
      await maxBot.sendMessage(user.maxUserId, `🔔 Подписка «${label}»: новых деклараций — ${matches.length}\n${lines.join('\n')}${more}`);
      sent++;
    } catch (e) {
      logger.warn('[MAX] Не удалось отправить подписку #%s: %s', search.id, e.message);
    }
    db.prepare('UPDATE saved_searches SET lastCheckedAt = ? WHERE id = ?').run(matches[matches.length - 1].fetchedAt, search.id);
  }
  return { sent };
}

async function runNotifyJob() {
  const [reminders, searches] = await Promise.all([runNoteReminders(), runSavedSearches()]);
  if (reminders.sent || searches.sent) {
    logger.info('[MAX] Уведомления: %s напоминаний, %s подписок', reminders.sent, searches.sent);
  }
  return { reminders: reminders.sent, searches: searches.sent };
}

module.exports = { runNotifyJob, runNoteReminders, runSavedSearches };
