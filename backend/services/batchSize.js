/**
 * Парсинг объёма партии из строки декларации («280 т», «2 110 тонн»,
 * «500 000 кг», «12 центнеров») в тонны числом — для фильтра по диапазону
 * в реестре. Портировано без изменений из frontend/js/app.js (parseTon) —
 * держать в синхроне при правках любой из версий.
 */
function parseBatchTons(s) {
  if (!s) return null;
  const str = String(s).replace(/\s/g, '').toLowerCase();
  const n = parseFloat(str.replace(',', '.'));
  if (isNaN(n) || n <= 0) return null;
  if (/цент|^\d+ц[^и]/.test(str)) return n / 10;
  if (/кг|кило/.test(str)) return n / 1000;
  return n;
}

module.exports = { parseBatchTons };
