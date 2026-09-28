/**
 * Отправка писем через Resend (транзакционные письма, не рассылки).
 * Нужны переменные окружения:
 *   RESEND_API_KEY   — ключ из личного кабинета Resend (Settings → API Keys)
 *   MAIL_FROM_EMAIL  — адрес отправителя на подтверждённом в Resend домене
 *   MAIL_FROM_NAME   — имя отправителя, по умолчанию «KOVELIA»
 * Пока переменные не заданы, send() бросает понятную ошибку — вызывающий код
 * (routes/auth.js) должен явно обработать это состояние, а не тихо глотать.
 */
const axios = require('axios');

const API_URL = 'https://api.resend.com/emails';
const API_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = process.env.MAIL_FROM_EMAIL || '';
const FROM_NAME = process.env.MAIL_FROM_NAME || 'KOVELIA';

const http = axios.create({ timeout: 15000, validateStatus: () => true });

function isConfigured() {
  return !!(API_KEY && FROM_EMAIL);
}

async function send({ to, subject, html, text }) {
  if (!isConfigured()) {
    throw new Error('Почтовый сервис не настроен (RESEND_API_KEY / MAIL_FROM_EMAIL)');
  }
  const resp = await http.post(API_URL, {
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to: [to],
    subject,
    html,
    text: text || html.replace(/<[^>]+>/g, ' '),
  }, { headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' } });

  if (resp.status >= 400 || !resp.data?.id) {
    const msg = resp.data?.message || `HTTP ${resp.status}`;
    throw new Error(`Resend: ${msg}`);
  }
  return resp.data;
}

async function sendVerificationCode(email, code) {
  return send({
    to: email,
    subject: `Код подтверждения: ${code} — KOVELIA`,
    html: `
      <div style="font-family:Arial,sans-serif;font-size:15px;color:#1a1e27">
        <p>Код для подтверждения почты на «KOVELIA»:</p>
        <p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p>
        <p style="color:#6b7280;font-size:13px">Код действует 10 минут. Если вы не запрашивали регистрацию — просто игнорируйте это письмо.</p>
      </div>`,
  });
}

module.exports = { send, sendVerificationCode, isConfigured };
