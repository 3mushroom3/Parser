const axios = require('axios');
const crypto = require('crypto');

const SHOP_ID = process.env.YUKASSA_SHOP_ID || '';
const SECRET_KEY = process.env.YUKASSA_SECRET_KEY || '';

// Чек по 54-ФЗ (для ООО/ИП при подключённых «Чеках от ЮKassa» или своей онлайн-кассе).
// Без него ЮKassa отклоняет платёж, если фискализация включена в магазине.
// YUKASSA_RECEIPT=off — не передавать чек (самозанятые, магазин без фискализации).
// YUKASSA_VAT_CODE — код ставки НДС по справочнику ЮKassa: 1 — без НДС (УСН),
// 4 — 20%, 11 — 22% и т.д.; ставку подтверждает бухгалтер.
const RECEIPT_ENABLED = (process.env.YUKASSA_RECEIPT || 'on') !== 'off';
const VAT_CODE = Number(process.env.YUKASSA_VAT_CODE) || 1;

const client = axios.create({
  baseURL: 'https://api.yookassa.ru/v3',
  auth: { username: SHOP_ID, password: SECRET_KEY },
  headers: { 'Content-Type': 'application/json' },
  timeout: 15000,
});

// Текст ошибки ЮKassa («Invalid receipt…», «Authentication failed…») вместо
// безликого «Request failed with status code 400».
function describeError(err) {
  const d = err.response?.data;
  return d?.description ? `${d.description}${d.parameter ? ` (${d.parameter})` : ''}` : err.message;
}

async function createPayment({ amount, description, metadata, returnUrl, customerEmail, itemName }) {
  const value = Number(amount).toFixed(2);
  const body = {
    amount: { value, currency: 'RUB' },
    confirmation: { type: 'redirect', return_url: returnUrl },
    capture: true,
    description: description.slice(0, 128),
    metadata,
  };
  if (RECEIPT_ENABLED) {
    body.receipt = {
      customer: { email: customerEmail },
      items: [{
        description: (itemName || description).slice(0, 128),
        quantity: '1.00',
        amount: { value, currency: 'RUB' },
        vat_code: VAT_CODE,
        payment_subject: 'service',
        payment_mode: 'full_payment',
      }],
    };
  }
  try {
    const { data } = await client.post('/payments', body, {
      headers: { 'Idempotence-Key': crypto.randomUUID() },
    });
    return data;
  } catch (err) {
    throw new Error(describeError(err));
  }
}

async function getPayment(paymentId) {
  try {
    const { data } = await client.get(`/payments/${paymentId}`);
    return data;
  } catch (err) {
    throw new Error(describeError(err));
  }
}

function isConfigured() {
  return Boolean(SHOP_ID && SECRET_KEY);
}

// Тестовый магазин ЮKassa выдаёт секретный ключ с префиксом test_.
function isTestMode() {
  return SECRET_KEY.startsWith('test_');
}

module.exports = { createPayment, getPayment, isConfigured, isTestMode, receiptEnabled: RECEIPT_ENABLED };
