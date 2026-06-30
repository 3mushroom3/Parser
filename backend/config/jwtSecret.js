/**
 * Единая точка получения JWT_SECRET для подписи и проверки токенов.
 * Fail-closed: без заданного секрета сервер отказывается стартовать, чтобы
 * не подписывать/не проверять токены известным хардкодженным значением
 * (CWE-798). Раньше auth.js и middleware/auth.js независимо считали один
 * и тот же fallback, и предупреждение срабатывало только при
 * NODE_ENV==='production' — если NODE_ENV не выставлен в точности так
 * (частый случай при ручном запуске), секрет молча оставался публичным.
 *
 * Для локальной разработки без секрета — явный флаг ALLOW_INSECURE_JWT_SECRET=true
 * в .env (не коммитить, не использовать на сервере).
 */
const INSECURE_FALLBACK = 'dev-only-insecure-secret-change-me';

function resolveJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (secret && secret.length >= 32) return secret;

  if (process.env.ALLOW_INSECURE_JWT_SECRET === 'true') {
    console.warn('[SECURITY] JWT_SECRET не задан (или короче 32 символов) — используется небезопасный dev-секрет, т.к. явно разрешено ALLOW_INSECURE_JWT_SECRET=true. НЕ использовать на проде.');
    return INSECURE_FALLBACK;
  }

  console.error('========================================================================');
  console.error('[SECURITY] КРИТИЧНО: JWT_SECRET не задан или короче 32 символов.');
  console.error('Сервер не будет запущен — иначе токены подписывались бы известным значением.');
  console.error('Добавьте в .env: JWT_SECRET=<случайная строка>');
  console.error('Сгенерировать: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  console.error('Для локальной разработки без секрета — добавьте ALLOW_INSECURE_JWT_SECRET=true в .env.');
  console.error('========================================================================');
  process.exit(1);
}

module.exports = resolveJwtSecret();
