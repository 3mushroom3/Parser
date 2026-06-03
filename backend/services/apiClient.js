const axios = require('axios');
const { isJwtString, mergeCookieStrings, parseCookiesFromResponse, extractXsrfToken } = require('./authUtils');
const log = require('./logger');

/**
 * HTTP-клиент ФГИС: сессия, POST /login, запросы к API с Bearer и retry.
 * Соответствует последовательности SPA (аналог открытия страницы + XHR из scrape.py).
 */
function createFsaApiClient(cfg) {
  const baseURL = cfg.fsaBaseUrl.replace(/\/$/, '');
  const http = axios.create({
    baseURL,
    timeout: cfg.http.defaultTimeoutMs,
    validateStatus: () => true,
  });

  let token = '';
  let cookies = '';
  let expiresAt = 0;
  let manualToken = '';

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function withRetry(operation, opName, attempt = 1, retryCfg = cfg.retry) {
    const { maxAttempts, baseDelayMs, maxDelayMs } = retryCfg;
    try {
      return await operation();
    } catch (err) {
      const retriable =
        !err.response ||
        err.code === 'ECONNABORTED' ||
        err.code === 'ETIMEDOUT' ||
        [502, 503, 504].includes(err.response?.status);
      if (!retriable || attempt >= maxAttempts) {
        log.error('api', `${opName} окончательно: ${err.message}`);
        throw err;
      }
      const delay = Math.min(maxDelayMs || 8000, baseDelayMs * 2 ** (attempt - 1));
      log.warn('api', `${opName} повтор ${attempt + 1}/${maxAttempts} через ${delay}ms`);
      await sleep(delay);
      return withRetry(operation, opName, attempt + 1, retryCfg);
    }
  }

  function csrfHeaders() {
    const xsrf = extractXsrfToken(cookies);
    const h = { 'X-Requested-With': 'XMLHttpRequest' };
    if (xsrf) h['X-XSRF-TOKEN'] = xsrf;
    return h;
  }

  function baseHeaders() {
    return {
      ...csrfHeaders(),
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
      Origin: baseURL,
      Referer: `${baseURL}/rds/declaration`,
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      lkId: '',
      orgId: '',
      ...(cookies ? { Cookie: cookies } : {}),
    };
  }

  function authorizedHeaders() {
    const t = manualToken || token;
    return {
      ...baseHeaders(),
      'Content-Type': 'application/json',
      Authorization: `Bearer ${t}`,
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    };
  }

  /** Один запрос без retry — иначе при медленном ФГИС сумма таймаутов умножается на maxAttempts */
  async function bootstrapSession() {
    const t = cfg.http.bootstrapTimeoutMs || cfg.http.defaultTimeoutMs;
    const r = await http.get(cfg.paths.sessionBootstrap, {
      headers: {
        'User-Agent': baseHeaders()['User-Agent'],
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.9',
        'Accept-Language': 'ru-RU,ru;q=0.9',
      },
      timeout: t,
      maxRedirects: 5,
      validateStatus: () => true,
    });
    if (r.status >= 200 && r.status < 500) {
      const c = parseCookiesFromResponse(r);
      if (c) cookies = mergeCookieStrings(cookies, c);
    }
    return cookies;
  }

  /** Без XSRF-TOKEN POST /login часто отвечает 403 (Spring Security). */
  async function ensureXsrfCookie() {
    if (extractXsrfToken(cookies)) return;
    const path = cfg.paths.sessionFallback || '/';
    const t = cfg.http.bootstrapTimeoutMs || cfg.http.defaultTimeoutMs;
    const r = await http.get(path, {
      headers: {
        'User-Agent': baseHeaders()['User-Agent'],
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.9',
        'Accept-Language': 'ru-RU,ru;q=0.9',
        ...(cookies ? { Cookie: cookies } : {}),
      },
      timeout: t,
      maxRedirects: 5,
      validateStatus: () => true,
    });
    if (r.status >= 200 && r.status < 500) {
      const c = parseCookiesFromResponse(r);
      if (c) cookies = mergeCookieStrings(cookies, c);
    }
  }

  async function loginAnonymous() {
    const loginRetryCfg = {
      maxAttempts: cfg.loginRetry?.maxAttempts ?? 2,
      baseDelayMs: cfg.loginRetry?.baseDelayMs ?? 1000,
      maxDelayMs: cfg.retry.maxDelayMs,
    };
    return withRetry(
      async () => {
        const r = await http.post(
          cfg.paths.login,
          { username: cfg.anonymousLogin.username, password: cfg.anonymousLogin.password },
          {
            headers: { ...baseHeaders(), 'Content-Type': 'application/json' },
            timeout: cfg.http.loginTimeoutMs,
          }
        );
        if (r.status !== 200) {
          const hint = extractXsrfToken(cookies) ? '' : ' (нет cookie XSRF-TOKEN — проверьте сеть/прокси)';
          const body = typeof r.data === 'string' ? r.data.slice(0, 200) : JSON.stringify(r.data || '').slice(0, 200);
          log.error('api', `POST /login статус ${r.status}${hint}`, body || '');
          return false;
        }
        const auth = r.headers?.authorization || r.headers?.Authorization || '';
        const raw = auth.replace(/^Bearer\s+/i, '').trim();
        if (!isJwtString(raw)) {
          log.error('api', 'POST /login: нет валидного JWT в Authorization');
          return false;
        }
        token = raw;
        const fromLogin = parseCookiesFromResponse(r);
        cookies = mergeCookieStrings(cookies, fromLogin);
        try {
          const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
          expiresAt = (payload.exp * 1000) - 60000;
        } catch (_) {
          expiresAt = Date.now() + 7 * 3600 * 1000;
        }
        return true;
      },
      'loginAnonymous',
      1,
      loginRetryCfg
    );
  }

  return {
    getBaseUrl: () => baseURL,

    getState: () => ({ token: manualToken || token, cookies, expiresAt, manualToken: !!manualToken }),

    setManualToken(t) {
      if (!isJwtString(t)) return false;
      manualToken = t.trim();
      try {
        const payload = JSON.parse(Buffer.from(manualToken.split('.')[1], 'base64url').toString());
        expiresAt = (payload.exp * 1000) - 60000;
      } catch (_) {
        expiresAt = Date.now() + 7 * 3600 * 1000;
      }
      return true;
    },

    clearManualToken() {
      manualToken = '';
    },

    /** Сброс кэша JWT (например после 401) */
    invalidateToken() {
      token = '';
      expiresAt = 0;
    },

    async ensureAuth() {
      if (manualToken) return manualToken;
      if (token && Date.now() < expiresAt) return token;
      log.info('auth', 'Получение сессии и JWT…');
      try {
        await bootstrapSession();
      } catch (e) {
        log.warn('auth', `GET ${cfg.paths.sessionBootstrap}: ${e.message}`);
      }
      try {
        if (!extractXsrfToken(cookies)) await ensureXsrfCookie();
      } catch (e) {
        log.warn('auth', `GET ${cfg.paths.sessionFallback || '/'}: ${e.message}`);
      }
      if (!extractXsrfToken(cookies)) {
        log.warn('auth', 'В cookies нет XSRF-TOKEN — POST /login может вернуть 403');
      }
      let ok = false;
      try {
        ok = await loginAnonymous();
      } catch (e) {
        log.error('auth', `POST /login: ${e.message}`);
        ok = false;
      }
      if (!ok) return null;
      log.info('auth', `JWT получен, истекает ${new Date(expiresAt).toLocaleTimeString('ru-RU')}`);
      return token;
    },

    buildAuthorizedHeaders() {
      return authorizedHeaders();
    },

    /** Список деклараций (как в SPA после логина) */
    async postDeclarationsList(body) {
      const authTok = await this.ensureAuth();
      if (!authTok) throw new Error('Нет авторизации');
      const r = await withRetry(
        () =>
          http.post(cfg.paths.declarationsList, body, {
            headers: authorizedHeaders(),
            timeout: cfg.http.defaultTimeoutMs,
          }),
        'postDeclarationsList'
      );
      if (r.status >= 200 && r.status < 300) return r.data;
      const err = new Error(`declarations/get ${r.status}`);
      err.response = r;
      throw err;
    },

    /** Полная карточка декларации */
    async getDeclarationById(declarationId) {
      const authTok = await this.ensureAuth();
      if (!authTok) throw new Error('Нет авторизации');
      const path = cfg.paths.declarationById(declarationId);
      const r = await withRetry(
        () =>
          http.get(path, {
            headers: authorizedHeaders(),
            timeout: cfg.http.defaultTimeoutMs,
          }),
        'getDeclarationById'
      );
      if (r.status === 200 && r.data && typeof r.data === 'object') return r.data;
      const err = new Error(`declaration ${declarationId} HTTP ${r.status}`);
      err.response = r;
      throw err;
    },

    /** Справочник технических регламентов (для поиска ID по названию) */
    async getTechReglaments() {
      const authTok = await this.ensureAuth();
      if (!authTok) throw new Error('Нет авторизации');
      const r = await withRetry(
        () =>
          http.get(cfg.paths.techReglaments, {
            headers: authorizedHeaders(),
            timeout: cfg.http.defaultTimeoutMs,
          }),
        'getTechReglaments'
      );
      if (r.status === 200) return r.data;
      const err = new Error(`techReglaments HTTP ${r.status}`);
      err.response = r;
      throw err;
    },
  };
}

module.exports = { createFsaApiClient };
