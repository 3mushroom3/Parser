const express = require('express');
const router = express.Router();
const db = require('../services/db');
const auth = require('../middleware/auth');
const { syncIntegration, findMatchingLeads, pushToBitrix24 } = require('../services/crmExport');

// Доступ к CRM-интеграции только тем, кому admin включил её вручную
// (пока нет самообслуживаемого биллинга под эту опцию, см. CLAUDE.md).
function requireCrmAccess(req, res, next) {
  const user = db.prepare('SELECT crmEnabled FROM users WHERE id = ?').get(req.user.id);
  if (!user || !user.crmEnabled) {
    return res.status(403).json({ error: 'CRM-интеграция недоступна на вашем тарифе. Обратитесь в поддержку.' });
  }
  next();
}

router.get('/integration', auth, requireCrmAccess, (req, res) => {
  const row = db.prepare('SELECT * FROM crm_integrations WHERE userId = ?').get(req.user.id);
  if (!row) return res.json(null);
  res.json({ ...row, filterJson: JSON.parse(row.filterJson || '{}'), webhookUrl: row.webhookUrl ? maskUrl(row.webhookUrl) : '' });
});

function maskUrl(url) {
  // Полный вебхук — секрет (содержит код доступа), показываем только хвост
  if (url.length <= 20) return url;
  return url.slice(0, 24) + '…' + url.slice(-6);
}

router.put('/integration', auth, requireCrmAccess, (req, res) => {
  const { provider = 'bitrix24', webhookUrl, filter } = req.body || {};
  if (!['bitrix24', 'amocrm'].includes(provider)) {
    return res.status(400).json({ error: 'Неизвестный провайдер' });
  }
  const existing = db.prepare('SELECT id, webhookUrl FROM crm_integrations WHERE userId = ?').get(req.user.id);
  // Поле вебхука на фронте замаскировано (секрет) — пустое значение при
  // сохранении означает «не менять», а не «удалить», если он уже был задан.
  const effectiveWebhook = webhookUrl || existing?.webhookUrl || '';
  if (provider === 'bitrix24' && !/^https:\/\/.+\.bitrix24\./.test(effectiveWebhook)) {
    return res.status(400).json({ error: 'Укажите корректный входящий вебхук Bitrix24 (https://ваш-портал.bitrix24.ru/rest/…/)' });
  }
  const filterJson = JSON.stringify(filter || {});
  if (existing) {
    db.prepare('UPDATE crm_integrations SET provider=?, webhookUrl=?, filterJson=?, active=1, lastError=NULL, updatedAt=CURRENT_TIMESTAMP WHERE userId=?')
      .run(provider, effectiveWebhook || null, filterJson, req.user.id);
  } else {
    db.prepare('INSERT INTO crm_integrations (userId, provider, webhookUrl, filterJson) VALUES (?, ?, ?, ?)')
      .run(req.user.id, provider, effectiveWebhook || null, filterJson);
  }
  res.json({ ok: true });
});

router.put('/integration/active', auth, requireCrmAccess, (req, res) => {
  const { active } = req.body || {};
  db.prepare('UPDATE crm_integrations SET active=?, updatedAt=CURRENT_TIMESTAMP WHERE userId=?').run(active ? 1 : 0, req.user.id);
  res.json({ ok: true });
});

router.delete('/integration', auth, requireCrmAccess, (req, res) => {
  db.prepare('DELETE FROM crm_integrations WHERE userId = ?').run(req.user.id);
  res.json({ ok: true });
});

// Тестовый лид — чтобы клиент сразу увидел, что вебхук настроен верно,
// не дожидаясь следующей новой декларации по своему фильтру.
router.post('/integration/test', auth, requireCrmAccess, async (req, res) => {
  const row = db.prepare('SELECT * FROM crm_integrations WHERE userId = ?').get(req.user.id);
  if (!row) return res.status(404).json({ error: 'Сначала сохраните настройки интеграции' });
  if (row.provider !== 'bitrix24') return res.status(400).json({ error: 'Тестовая отправка пока доступна только для Bitrix24' });

  const testLead = { id: 'test', productName: 'Тестовый лид из «База АПК»', batchSize: '100 т',
    address: 'Тестовый адрес', inn: '0000000000', shortName: 'ООО «Тест»', regDate: new Date().toISOString().slice(0, 10) };
  try {
    await pushToBitrix24(row, [testLead]);
    res.json({ ok: true, message: 'Тестовый лид отправлен — проверьте CRM' });
  } catch (e) {
    res.status(400).json({ error: 'Не удалось отправить: ' + e.message });
  }
});

// Предпросмотр: сколько деклараций за последние 24ч подошли бы под фильтр —
// чтобы клиент понимал масштаб потока лидов до сохранения.
router.post('/integration/preview', auth, requireCrmAccess, (req, res) => {
  const { filter } = req.body || {};
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const leads = findMatchingLeads(filter || {}, since, 20);
  res.json({ count: leads.length, sample: leads.slice(0, 5).map(l => ({ productName: l.productName, batchSize: l.batchSize, regDate: l.regDate })) });
});

module.exports = router;
