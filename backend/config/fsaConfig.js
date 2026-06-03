const path = require('path');

/** Централизованные настройки ФГИС (значения по умолчанию + переменные окружения) */
module.exports = {
  fsaBaseUrl: process.env.FSA_BASE_URL || 'https://pub.fsa.gov.ru',

  paths: {
    sessionBootstrap: '/rds/declaration',
    /** Доп. запрос, если после bootstrap нет cookie XSRF-TOKEN (Spring CSRF) */
    sessionFallback: '/',
    login: '/login',
    declarationsList: '/api/v1/rds/common/declarations/get',
    /** Полная карточка декларации (JSON) */
    declarationById: (id) => `/api/v1/rds/common/declarations/${encodeURIComponent(String(id))}`,
    /** Справочник технических регламентов */
    techReglaments: '/api/v1/rds/common/nsi/techreglament',
  },

  anonymousLogin: {
    username: process.env.FSA_ANON_USERNAME || 'anonymous',
    password: process.env.FSA_ANON_PASSWORD || 'hrgesf7HDR67Bd',
  },

  http: {
    /** API после логина */
    defaultTimeoutMs: Number(process.env.FSA_HTTP_TIMEOUT_MS) || 45000,
    /** POST /login */
    loginTimeoutMs: Number(process.env.FSA_LOGIN_TIMEOUT_MS) || 60000,
    /** GET / и HTML-страницы (ФГИС часто отвечает медленно) */
    bootstrapTimeoutMs: Number(process.env.FSA_BOOTSTRAP_TIMEOUT_MS) || 90000,
  },

  /** Повторы для API (не для bootstrap — иначе 3×90s) */
  retry: {
    maxAttempts: Number(process.env.FSA_RETRY_MAX) || 3,
    baseDelayMs: Number(process.env.FSA_RETRY_BASE_MS) || 400,
    maxDelayMs: Number(process.env.FSA_RETRY_MAX_MS) || 8000,
  },

  /** Повторы только для POST /login при сетевых сбоях */
  loginRetry: {
    maxAttempts: Math.max(1, Number(process.env.FSA_LOGIN_RETRY_MAX) || 2),
    baseDelayMs: Number(process.env.FSA_LOGIN_RETRY_DELAY_MS) || 1000,
  },

  concurrency: Math.max(1, Math.min(20, Number(process.env.FSA_FETCH_CONCURRENCY) || 3)),

  dataFile: process.env.FSA_DATA_FILE || path.join(__dirname, '..', '..', 'data', 'declarations.json'),
  statusFile: process.env.FSA_STATUS_FILE || path.join(__dirname, '..', '..', 'data', 'status.json'),
};
