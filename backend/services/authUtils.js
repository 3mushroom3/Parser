/** JWT (три сегмента base64url) — отсекаем HTML и прочий мусор */
function isJwtString(s) {
  if (typeof s !== 'string' || !s) return false;
  const t = s.trim();
  const parts = t.split('.');
  if (parts.length !== 3) return false;
  const seg = /^[A-Za-z0-9_-]+$/;
  return parts.every((p) => p.length >= 4 && seg.test(p));
}

function mergeCookieStrings(a, b) {
  const map = new Map();
  for (const block of [a, b]) {
    if (!block) continue;
    for (const piece of block.split(';').map((x) => x.trim()).filter(Boolean)) {
      const eq = piece.indexOf('=');
      if (eq <= 0) continue;
      map.set(piece.slice(0, eq).trim(), piece.slice(eq + 1).trim());
    }
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function parseCookiesFromResponse(resp) {
  let cookieStr = '';
  for (const c of resp.headers['set-cookie'] || []) {
    const part = c.split(';')[0].trim();
    if (part) cookieStr += (cookieStr ? '; ' : '') + part;
  }
  return cookieStr;
}

/** Spring Security: cookie XSRF-TOKEN → заголовок X-XSRF-TOKEN */
function extractXsrfToken(cookieStr) {
  if (!cookieStr || typeof cookieStr !== 'string') return '';
  for (const piece of cookieStr.split(';').map((s) => s.trim()).filter(Boolean)) {
    const eq = piece.indexOf('=');
    if (eq <= 0) continue;
    const name = piece.slice(0, eq).trim();
    const un = name.toUpperCase();
    if (un !== 'XSRF-TOKEN' && un !== 'CSRF-TOKEN') continue;
    let v = piece.slice(eq + 1).trim();
    try {
      v = decodeURIComponent(v);
    } catch (_) {}
    return v;
  }
  return '';
}

module.exports = { isJwtString, mergeCookieStrings, parseCookiesFromResponse, extractXsrfToken };
