/**
 * Проверка отправки писем. Регистрация завязана на код подтверждения, и пока
 * почта не настроена, /api/auth/register отвечает 503 — пользователь не может
 * завести аккаунт вовсе. Этот скрипт показывает, что именно не так: не заданы
 * переменные, не тот ключ, не подтверждён домен отправителя.
 *
 * Запуск: node scripts/test-mail.js ваш@адрес.ру
 */
require('dotenv').config();
const mailer = require('../services/mailer');

const mask = (v) => (v ? v.slice(0, 4) + '…' + v.slice(-2) + ` (${v.length} симв.)` : 'НЕ ЗАДАНО');

async function main() {
  const to = process.argv[2];

  console.log('Настройки почты:');
  console.log('  RESEND_API_KEY  :', mask(process.env.RESEND_API_KEY));
  console.log('  MAIL_FROM_EMAIL :', process.env.MAIL_FROM_EMAIL || 'НЕ ЗАДАНО');
  console.log('  MAIL_FROM_NAME  :', process.env.MAIL_FROM_NAME || '(по умолчанию KOVELIA)');
  console.log('  Сервис настроен :', mailer.isConfigured() ? 'да' : 'НЕТ — регистрация будет отвечать 503');

  if (!mailer.isConfigured()) {
    console.log('\nЗаполните RESEND_API_KEY и MAIL_FROM_EMAIL в backend/.env и перезапустите сервер.');
    process.exit(1);
  }
  if (!to) {
    console.log('\nЧтобы отправить тестовое письмо: node scripts/test-mail.js ваш@адрес.ру');
    return;
  }

  console.log(`\nОтправляю тестовый код на ${to}...`);
  try {
    const res = await mailer.sendVerificationCode(to, '123456');
    console.log('Отправлено. Ответ сервиса:', JSON.stringify(res));
    console.log('Если письмо не пришло — проверьте папку «Спам» и статус домена отправителя в Resend (Domains).');
  } catch (err) {
    console.log('ОШИБКА отправки:', err.message);
    console.log('\nЧастые причины:');
    console.log('  • «Invalid API key» — ключ неверный или отозван (Resend → API Keys).');
    console.log('  • «domain is not verified» — MAIL_FROM_EMAIL не на подтверждённом домене');
    console.log('    (Resend → Domains → Add Domain → добавить DNS-записи и дождаться проверки).');
    console.log('  • HTTP 000/timeout — сервер не отпускает исходящие запросы наружу.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Непредвиденная ошибка:', err.message);
  process.exit(1);
});
