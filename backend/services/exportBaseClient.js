/**
 * Клиент export-base.ru — обогащение компаний телефонами, email, выручкой,
 * именем директора и другими данными из ЕГРЮЛ/ИП.
 * Ключ хранится в .env: EXPORT_BASE_KEY
 * Лимит: 1 запрос = 1 компания (оплачиваемый кредит).
 */
const axios = require('axios');

const BASE_URL = 'https://export-base.ru/api';
const EXPORT_BASE_KEY = process.env.EXPORT_BASE_KEY || '';

const http = axios.create({ timeout: 15000, validateStatus: () => true });

async function getBalance() {
  if (!EXPORT_BASE_KEY) return null;
  const r = await http.get(`${BASE_URL}/balance/`, { params: { key: EXPORT_BASE_KEY } });
  return r.status === 200 ? r.data : null;
}

// ИНН 10 знаков = организация (ООО, АО, ...) — API отдаёт данные напрямую.
// ИНН 12 знаков = ИП/физлицо — API не поддерживает, возвращаем специальный
// объект со ссылкой на профиль на сайте export-base.ru.
function isIp(inn) { return String(inn).length === 12; }
function profileUrl(inn) { return `https://export-base.ru/?query=${inn}`; }

async function lookupByInn(inn) {
  if (!EXPORT_BASE_KEY || !inn) return null;

  if (isIp(inn)) {
    return { _isIp: true, profileUrl: profileUrl(inn) };
  }

  const r = await http.get(`${BASE_URL}/company/`, { params: { inn, key: EXPORT_BASE_KEY } });
  if (r.status !== 200) {
    console.warn('[EB] company HTTP', r.status, r.data);
    return null;
  }
  return r.data?.companies_data?.[0] || null;
}

function extractData(c) {
  if (!c) return null;
  // ИП — данные через API недоступны, только ссылка на профиль
  if (c._isIp) return { _isIp: true, profileUrl: c.profileUrl };

  const phones = [c.stationary_phone, c.mobile_phone].filter(Boolean).join(' | ').trim() || null;
  return {
    phone:     phones,
    email:     c.email    || null,
    website:   c.site     || null,
    ceoName:   c.ceo_name || null,
    employees: c.employees ? String(c.employees) : null,
    revenue:   c.income   || null,
    revenueRaw: c.income_raw ? Number(c.income_raw) : null,
  };
}

module.exports = { getBalance, lookupByInn, extractData, isConfigured: () => !!EXPORT_BASE_KEY, isIp, profileUrl };
