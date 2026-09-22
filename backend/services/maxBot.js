/**
 * Бот в мессенджере MAX (dev.max.ru) — только MAX, без Telegram (решение
 * пользователя: см. CLAUDE.md, фаза E2). Two канала уведомлений:
 *   1. Напоминания по заметкам (notes.notifyTime).
 *   2. Подписки на новые декларации по сохранённому фильтру (saved_searches).
 *
 * Long polling (GET /updates), не вебхук — так было устроено и в прежнем
 * Telegram-боте (см. историю коммитов), не нужен публичный HTTPS-эндпоинт
 * на 443 порту специально под бота.
 *
 * Точная структура Update для message_created документацией MAX не
 * зафиксирована до символа — парсинг ниже защитный (несколько путей к
 * user_id/тексту сообщения), при первом реальном апдейте лог печатает
 * сырой объект, чтобы можно было поправить на месте после подключения
 * реального токена.
 */
const axios = require('axios');
const db = require('./db');
const logger = require('./logger');

const BASE_URL = process.env.MAX_BOT_API_URL || 'https://platform-api2.max.ru';
const TOKEN = process.env.MAX_BOT_TOKEN || '';
const BOT_USERNAME = process.env.MAX_BOT_USERNAME || '';

const http = axios.create({ baseURL: BASE_URL, timeout: 35000, validateStatus: () => true });

function isConfigured() { return !!TOKEN; }
function botUsername() { return BOT_USERNAME; }

async function sendMessage(userId, text) {
  if (!isConfigured()) throw new Error('MAX-бот не настроен (MAX_BOT_TOKEN)');
  const resp = await http.post('/messages', { user_id: Number(userId), text, notify: true },
    { headers: { Authorization: TOKEN, 'Content-Type': 'application/json' } });
  if (resp.status >= 300) throw new Error(resp.data?.message || `HTTP ${resp.status}`);
  return resp.data;
}

// ── Привязка аккаунта: пользователь пишет боту код, показанный в профиле ──
const LINK_CODE_TTL_MS = 10 * 60 * 1000;
function genLinkCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}
function issueLinkCode(userId) {
  const code = genLinkCode();
  db.prepare('UPDATE users SET maxLinkCode = ?, maxLinkCodeExpiresAt = ? WHERE id = ?')
    .run(code, new Date(Date.now() + LINK_CODE_TTL_MS).toISOString(), userId);
  return code;
}

function extractSenderAndText(update) {
  const senderId = update.message?.sender?.user_id ?? update.user?.user_id ?? update.sender?.user_id ?? null;
  const text = update.message?.body?.text ?? update.message?.text ?? '';
  return { senderId, text: String(text || '').trim() };
}

async function handleUpdate(update) {
  if (update.update_type !== 'message_created') return;
  const { senderId, text } = extractSenderAndText(update);
  if (!senderId || !text) {
    logger.info('[MAX] Не удалось разобрать update, сырой объект: %s', JSON.stringify(update).slice(0, 500));
    return;
  }

  const code = text.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const user = db.prepare(`
    SELECT id, username FROM users
    WHERE maxLinkCode = ? AND maxLinkCodeExpiresAt > datetime('now')
  `).get(code);

  if (user) {
    db.prepare('UPDATE users SET maxUserId = ?, maxLinkCode = NULL, maxLinkCodeExpiresAt = NULL WHERE id = ?').run(senderId, user.id);
    await sendMessage(senderId, `✅ Аккаунт «${user.username}» на KOVELIA привязан. Сюда будут приходить напоминания по заметкам и уведомления о новых декларациях по вашим подпискам.`).catch(() => {});
    logger.info('[MAX] Привязан аккаунт userId=%s к maxUserId=%s', user.id, senderId);
  } else {
    await sendMessage(senderId, 'Не узнал код. Возьмите код привязки в разделе «Профиль» на baza-apk и отправьте его сюда сообщением.').catch(() => {});
  }
}

let _polling = false;
let _marker = undefined;
async function pollOnce() {
  const params = { timeout: 30, limit: 100 };
  if (_marker !== undefined) params.marker = _marker;
  const resp = await http.get('/updates', { params, headers: { Authorization: TOKEN } });
  if (resp.status !== 200) throw new Error(`GET /updates → HTTP ${resp.status}`);
  const { updates = [], marker } = resp.data || {};
  if (marker !== undefined) _marker = marker;
  for (const update of updates) {
    try { await handleUpdate(update); } catch (e) { logger.warn('[MAX] Ошибка обработки update: %s', e.message); }
  }
}

async function startPolling() {
  if (!isConfigured()) { logger.info('[MAX] Бот не настроен (нет MAX_BOT_TOKEN) — polling не запущен'); return; }
  if (_polling) return;
  _polling = true;
  logger.info('[MAX] Long polling запущен');
  while (_polling) {
    try {
      await pollOnce();
    } catch (e) {
      logger.warn('[MAX] Ошибка polling: %s — пауза 10с', e.message);
      await new Promise(r => setTimeout(r, 10000));
    }
  }
}
function stopPolling() { _polling = false; }

module.exports = { isConfigured, botUsername, sendMessage, issueLinkCode, startPolling, stopPolling };
