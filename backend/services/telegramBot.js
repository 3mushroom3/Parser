/**
 * Telegram Bot API — отправка уведомлений.
 * Конфиг хранится в data/telegram_config.json: { botToken, chatId }.
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '../../data/telegram_config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (_) {}
  return { botToken: '', chatId: '' };
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

async function sendMessage(text) {
  const { botToken, chatId } = loadConfig();
  if (!botToken || !chatId) return false;
  try {
    await axios.post(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      { chat_id: chatId, text, parse_mode: 'HTML' },
      { timeout: 10000 }
    );
    return true;
  } catch (e) {
    console.warn('[TELEGRAM] Ошибка отправки:', e.response?.data?.description || e.message);
    return false;
  }
}

/**
 * Уведомление об избранных компаниях с новыми декларациями.
 * favorites — массив { inn, name } из data/favorites.json
 * newRecords — новые записи после парсинга
 */
async function notifyFavorites(newRecords) {
  const { botToken, chatId } = loadConfig();
  if (!botToken || !chatId) return;

  let favs = [];
  const FAV_FILE = path.join(__dirname, '../../data/favorites.json');
  try {
    if (fs.existsSync(FAV_FILE)) favs = JSON.parse(fs.readFileSync(FAV_FILE, 'utf8'));
  } catch (_) {}
  if (!favs.length) return;

  const favInns = new Set(favs.map(f => f.inn).filter(Boolean));
  const favNames = new Set(favs.map(f => f.name).filter(Boolean));

  const matched = newRecords.filter(r =>
    (r.inn && favInns.has(r.inn)) ||
    (r.shortName && favNames.has(r.shortName))
  );

  if (!matched.length) return;

  const lines = matched.map(r =>
    `• <b>${r.shortName || r.applicantName || '—'}</b>\n  ${r.declNumber || r.id} · ${r.regDate || '?'}\n  ${r.productName ? r.productName.slice(0, 80) : ''}`
  ).join('\n\n');

  await sendMessage(`⭐ <b>Новые декларации — избранные компании</b>\n\n${lines}`);
}

module.exports = { sendMessage, notifyFavorites, loadConfig, saveConfig };
