/**
 * Сбрасывает пароль пользователя admin на новый (случайный или заданный аргументом).
 * Использование:
 *   node scripts/reset-admin-password.js              -- генерирует случайный пароль
 *   node scripts/reset-admin-password.js myNewPass123 -- устанавливает указанный пароль
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const path = require('path');
const db = require('../services/db');

const MIN_LEN = 8;
const newPassword = process.argv[2] || crypto.randomBytes(9).toString('base64url');

if (newPassword.length < MIN_LEN) {
  console.error(`Пароль должен быть не короче ${MIN_LEN} символов`);
  process.exit(1);
}

const admin = db.prepare('SELECT id, username FROM users WHERE username = ?').get('admin');
if (!admin) {
  console.error('Пользователь admin не найден в базе данных.');
  process.exit(1);
}

const hashed = bcrypt.hashSync(newPassword, 12);
db.prepare('UPDATE users SET password = ?, sessionId = NULL WHERE username = ?').run(hashed, 'admin');

console.log('========================================================================');
console.log(`✅ Пароль admin сброшен. Новый пароль: ${newPassword}`);
console.log('⚠️  Запишите его и смените через /профиль при первом входе!');
console.log('========================================================================');
process.exit(0);
