/**
 * Публичные превью-страницы компаний — без логина, для индексации поисковиками
 * (SEO-контур по образцу «Агро Радар»: «Просмотр бесплатно и без регистрации»).
 * Отдаём только безопасный срез: название, район/НП (не точный адрес), тип,
 * сколько деклараций и какая продукция — без телефона/email/точного адреса.
 * Обычный SPA рендерится клиентским JS и плохо индексируется — эта страница
 * специально серверная, без фронтенд-бандла.
 */
const express = require('express');
const router = express.Router();
const db = require('../services/db');

const escHtml = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const PAGE_SHELL = (title, description, body) => `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(title)}</title>
<meta name="description" content="${escHtml(description)}">
<meta property="og:title" content="${escHtml(title)}">
<meta property="og:description" content="${escHtml(description)}">
<style>
  body{font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#212829;line-height:1.5}
  .brand{font-weight:800;font-size:15px;margin-bottom:24px}
  .brand span{color:#6f8080;font-weight:600;font-size:11px;letter-spacing:.4px}
  h1{font-size:22px;margin:0 0 6px}
  .meta{color:#6f8080;font-size:13px;margin-bottom:18px}
  .card{border:1px solid #e7ecea;border-radius:10px;padding:16px 18px;margin-bottom:14px}
  .card b{display:block;font-size:12px;color:#6f8080;margin-bottom:4px}
  .cta{background:#075c44;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block;font-weight:600;margin-top:8px}
  .prod{display:inline-block;background:#d8f3e8;color:#075c44;border-radius:6px;padding:3px 9px;font-size:12px;margin:2px 4px 2px 0}
  footer{margin-top:32px;font-size:12px;color:#9ca3af}
</style>
</head>
<body>
  <div class="brand">KOVELIA <span>реестр АПК</span></div>
  ${body}
  <footer>© 2026 KOVELIA · реестр АПК · Агрегатор открытых данных pub.fsa.gov.ru, не аффилирован с Росаккредитацией</footer>
</body>
</html>`;

router.get('/company/:inn', (req, res) => {
  const inn = String(req.params.inn || '').replace(/\D/g, '');
  if (!inn) return res.status(404).send(PAGE_SHELL('Компания не найдена — KOVELIA', '', '<h1>Компания не найдена</h1>'));

  const rows = db.prepare(`
    SELECT d.productName, d.farmerType,
           g.region AS region, g.district AS district, g.label AS place,
           COALESCE(NULLIF(d.shortName,''), NULLIF(d.applicantName,''), d.lastName) AS name
    FROM declarations d
    LEFT JOIN geo_places g ON g.key = d.placeKey
    WHERE d.inn = ? AND d.status = 'active'
  `).all(inn);

  if (!rows.length) {
    res.status(404);
    return res.send(PAGE_SHELL('Компания не найдена — KOVELIA', 'В реестре действующих деклараций такая компания не найдена.',
      `<h1>Компания не найдена</h1><p>В реестре действующих деклараций компания с ИНН ${escHtml(inn)} не найдена.</p><a class="cta" href="/">Открыть реестр</a>`));
  }

  const name = rows[0].name || 'Без названия';
  const place = [rows[0].district, rows[0].place].filter(Boolean).join(', ') || rows[0].region || 'регион не определён';
  const typeLabel = { farmer: 'Производитель', farmer_trader: 'Производитель / Трейдер', trader: 'Трейдер', trader_farmer: 'Трейдер / Производитель' }[rows[0].farmerType] || '';
  const products = [...new Set(rows.map(r => r.productName).filter(Boolean))].slice(0, 12);

  const title = `${name} — ${place} — KOVELIA`;
  const description = `${name}: ${rows.length} действующих деклараций соответствия. ${products.slice(0, 3).join(', ')}. Регион: ${place}.`;

  const body = `
    <h1>${escHtml(name)}</h1>
    <div class="meta">ИНН ${escHtml(inn)} ${typeLabel ? '· ' + escHtml(typeLabel) : ''}</div>
    <div class="card">
      <b>Регион</b>${escHtml(place)}
    </div>
    <div class="card">
      <b>Действующих деклараций</b>${rows.length}
    </div>
    <div class="card">
      <b>Продукция</b>
      ${products.map(p => `<span class="prod">${escHtml(p.length > 40 ? p.slice(0, 40) + '…' : p)}</span>`).join('')}
    </div>
    <p style="color:#6b7280;font-size:13px">Контакты, точный адрес и полный список деклараций — после регистрации.</p>
    <a class="cta" href="/">Войти, чтобы увидеть контакты →</a>
  `;

  res.send(PAGE_SHELL(title, description, body));
});

module.exports = router;
