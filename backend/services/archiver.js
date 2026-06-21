/**
 * ФСА не понижает статус декларации до "истекла", даже если ей много лет —
 * формально она остаётся "действует", пока заявитель её не отозвал. Для
 * наших целей декларация старше года практически неактуальна, поэтому
 * переводим такие в собственный статус 'archived', не дожидаясь ФСА.
 */
const db = require('./db');

const ARCHIVE_AFTER_DAYS = 365;

function archiveOldDeclarations() {
  const info = db.prepare(`
    UPDATE declarations
    SET status = 'archived', updatedAt = CURRENT_TIMESTAMP
    WHERE status = 'active' AND regDate != '' AND regDate <= date('now', '-${ARCHIVE_AFTER_DAYS} days')
  `).run();
  return info.changes;
}

module.exports = { archiveOldDeclarations, ARCHIVE_AFTER_DAYS };
