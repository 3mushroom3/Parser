const axios = require('axios');
const crypto = require('crypto');

const SHOP_ID = process.env.YUKASSA_SHOP_ID || '';
const SECRET_KEY = process.env.YUKASSA_SECRET_KEY || '';

const client = axios.create({
  baseURL: 'https://api.yookassa.ru/v2',
  auth: { username: SHOP_ID, password: SECRET_KEY },
  headers: { 'Content-Type': 'application/json' },
  timeout: 15000,
});

async function createPayment({ amount, description, metadata, returnUrl }) {
  const idempotenceKey = crypto.randomUUID();
  const { data } = await client.post('/payments', {
    amount: { value: Number(amount).toFixed(2), currency: 'RUB' },
    confirmation: { type: 'redirect', return_url: returnUrl },
    capture: true,
    description,
    metadata,
  }, {
    headers: { 'Idempotence-Key': idempotenceKey },
  });
  return data;
}

async function getPayment(paymentId) {
  const { data } = await client.get(`/payments/${paymentId}`);
  return data;
}

function isConfigured() {
  return Boolean(SHOP_ID && SECRET_KEY);
}

module.exports = { createPayment, getPayment, isConfigured };
