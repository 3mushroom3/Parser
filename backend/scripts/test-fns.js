/**
 * Тест egrul.nalog.ru: vyp-request возвращает новый токен — пробуем vyp-short с ним.
 */
const axios = require('axios');
const HTTP = axios.create({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Referer': 'https://egrul.nalog.ru/',
    'X-Requested-With': 'XMLHttpRequest',
  },
  timeout: 20000,
  validateStatus: () => true,
});
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  // Сессия
  const sessR = await HTTP.get('https://egrul.nalog.ru/index.html');
  const cookie = (sessR.headers['set-cookie'] || []).find(c => c.startsWith('JSESSIONID=')).split(';')[0];
  console.log('Session:', cookie);

  const INN = '7736050003'; // Газпром

  // Поиск
  const sr = await HTTP.post('https://egrul.nalog.ru/',
    new URLSearchParams({ query: INN, region: '', PreventChromeAutocomplete: '' }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie } }
  );
  const st = sr.data.t;
  await sleep(1000);
  const rr = await HTTP.get(`https://egrul.nalog.ru/search-result/${st}`, { headers: { Cookie: cookie } });
  const companyToken = rr.data.rows[0].t;
  console.log('Company token:', companyToken.slice(0, 30));

  // vyp-request с токеном компании → получаем новый токен
  await sleep(500);
  const reqR = await HTTP.get(`https://egrul.nalog.ru/vyp-request/${companyToken}`, { headers: { Cookie: cookie } });
  console.log('vyp-request status:', reqR.status, 'body:', JSON.stringify(reqR.data).slice(0, 200));
  const newToken = reqR.data?.t;
  if (!newToken) { console.log('Нет нового токена!'); return; }
  console.log('New token:', newToken.slice(0, 30));

  // Ждём готовности
  for (let i = 0; i < 5; i++) {
    await sleep(1000);
    const statR = await HTTP.get(`https://egrul.nalog.ru/vyp-status/${newToken}`, { headers: { Cookie: cookie } });
    console.log(`vyp-status attempt ${i+1}:`, statR.status, JSON.stringify(statR.data));
    if (statR.data?.status === 'ready') break;
  }

  // Пробуем vyp-short с НОВЫМ токеном
  await sleep(500);
  const shortR = await HTTP.get(`https://egrul.nalog.ru/vyp-short/${newToken}?r=${Date.now()}`, { headers: { Cookie: cookie } });
  console.log('\nvyp-short (new token) status:', shortR.status);
  if (shortR.status === 200) {
    const json = JSON.stringify(shortR.data);
    const okved = json.match(/"КодОКВЭД":"([^"]+)"/g);
    console.log('КодОКВЭД:', okved ? okved.slice(0, 5).join(', ') : 'не найдено');
    console.log('Body (500):', json.slice(0, 500));
  } else {
    console.log('Body:', JSON.stringify(shortR.data).slice(0, 300));
  }

  // Также тестируем vyp-download с новым токеном (content-type?)
  const dlR = await HTTP.get(`https://egrul.nalog.ru/vyp-download/${newToken}`, { headers: { Cookie: cookie } });
  console.log('\nvyp-download (new token) status:', dlR.status, 'content-type:', dlR.headers['content-type']);
})();
