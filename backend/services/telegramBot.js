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

async function sendMessageTo(chatId, text) {
  const { botToken } = loadConfig();
  if (!botToken || !chatId) return false;
  try {
    await axios.post(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      { chat_id: chatId, text, parse_mode: 'HTML' },
      { timeout: 10000 }
    );
    return true;
  } catch (e) {
    console.warn('[TELEGRAM] sendMessageTo', chatId, ':', e.response?.data?.description || e.message);
    return false;
  }
}

/**
 * Уведомление об избранных компаниях с новыми декларациями.
 * Избранное читается из SQLite (таблица favorites), не из старого JSON.
 * Каждый пользователь получает уведомление на свой tgChatId если он задан.
 */
async function notifyFavorites(newRecords) {
  const { botToken } = loadConfig();
  if (!botToken || !newRecords.length) return;

  const db = require('./db');

  // Собираем всех пользователей с Telegram chatId
  const users = db.prepare("SELECT id, tgChatId FROM users WHERE tgChatId IS NOT NULL AND tgChatId != ''").all();
  if (!users.length) return;

  for (const user of users) {
    const favs = db.prepare('SELECT inn, name FROM favorites WHERE userId = ?').all(user.id);
    if (!favs.length) continue;

    const favInns = new Set(favs.map(f => f.inn).filter(Boolean));
    const favNames = new Set(favs.map(f => f.name).filter(Boolean));

    const matched = newRecords.filter(r =>
      (r.inn && favInns.has(r.inn)) ||
      (r.shortName && favNames.has(r.shortName))
    );
    if (!matched.length) continue;

    const lines = matched.map(r =>
      `• <b>${r.shortName || r.applicantName || '—'}</b>\n  ${r.declNumber || r.id} · ${r.regDate || '?'}\n  ${r.productName ? r.productName.slice(0, 80) : ''}`
    ).join('\n\n');

    await sendMessageTo(user.tgChatId, `⭐ <b>Новые декларации — избранные компании</b>\n\n${lines}`);
  }
}

/**
 * Простой поллинг входящих сообщений — отвечает на /start и /id командой с chatId.
 * Это позволяет пользователю узнать свой Chat ID прямо через бот.
 */
let _pollOffset = 0;
async function pollCommands() {
  const { botToken } = loadConfig();
  if (!botToken) return;
  try {
    const r = await axios.get(
      `https://api.telegram.org/bot${botToken}/getUpdates`,
      { params: { offset: _pollOffset, timeout: 5, limit: 10 }, timeout: 15000 }
    );
    const updates = r.data?.result || [];
    for (const upd of updates) {
      _pollOffset = upd.update_id + 1;
      const msg = upd.message;
      if (!msg?.text) continue;
      const cmd = msg.text.split('@')[0].toLowerCase();
      if (cmd === '/start' || cmd === '/id') {
        const cid = msg.chat.id;
        await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          chat_id: cid,
          parse_mode: 'HTML',
          text: `👋 Привет, <b>${msg.from?.first_name || 'пользователь'}</b>!\n\nВаш Chat ID: <code>${cid}</code>\n\nСкопируйте это число и вставьте в поле «Telegram Chat ID» в разделе Профиль на сайте.`,
        });
      }
    }
  } catch (_) {}
}

module.exports = { sendMessage, sendMessageTo, notifyFavorites, pollCommands, loadConfig, saveConfig };
