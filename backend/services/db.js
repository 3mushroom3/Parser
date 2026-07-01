const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = process.env.DB_PATH || path.join(__dirname, '../../data/fsa_parser.db');

// Ensure data directory exists
if (!fs.existsSync(path.dirname(dbPath))) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

const db = new Database(dbPath);

// SQLite's built-in LOWER() only handles ASCII and leaves Cyrillic unchanged —
// register a JS-backed lowercasing function so case-insensitive search works for Cyrillic text.
db.function('lower_u', (s) => (s == null ? s : String(s).toLowerCase()));

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    subscriptionUntil DATETIME,
    subscriptionPlan TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    userId INTEGER NOT NULL,
    amount REAL NOT NULL,
    currency TEXT DEFAULT 'RUB',
    plan TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    provider TEXT DEFAULT 'yukassa',
    providerPaymentId TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (userId) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS declarations (
    id TEXT PRIMARY KEY,
    fsaId TEXT,
    declNumber TEXT,
    source TEXT,
    status TEXT,
    productGroup TEXT,
    technicalReglament TEXT,
    regDate TEXT,
    endDate TEXT,
    applicantName TEXT,
    lastName TEXT,
    firstName TEXT,
    middleName TEXT,
    shortName TEXT,
    address TEXT,
    phone TEXT,
    productName TEXT,
    batchSize TEXT,
    otherInfo TEXT,
    fsaUrl TEXT,
    fetchedAt TEXT,
    farmerType TEXT,
    okved TEXT,
    inn TEXT,
    productionSites TEXT, -- Store as JSON string
    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS companies (
    id TEXT PRIMARY KEY, -- inn or name
    inn TEXT,
    name TEXT,
    description TEXT,
    notes TEXT,
    regDate TEXT,
    autoNote TEXT,
    phone TEXT,     -- телефоны из export-base.ru (стац. + моб.)
    email TEXT,     -- email из export-base.ru
    website TEXT,   -- сайт из export-base.ru
    ceoName TEXT,   -- имя директора из export-base.ru
    employees TEXT, -- кол-во сотрудников из export-base.ru
    revenue TEXT,   -- выручка форматированная (тыс. руб.)
    revenueRaw INTEGER, -- выручка числом (тыс. руб.)
    ebEnrichedAt DATETIME, -- дата последнего обогащения через export-base
    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL DEFAULT 1,
    inn TEXT,
    name TEXT,
    addedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(userId, inn, name)
  );

  CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    userId INTEGER NOT NULL DEFAULT 1,
    name TEXT NOT NULL,
    parentId TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS folder_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    folderId TEXT NOT NULL,
    type TEXT NOT NULL, -- 'inn', 'decl', 'name'
    value TEXT NOT NULL,
    label TEXT,
    FOREIGN KEY (folderId) REFERENCES folders(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS status (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    state TEXT,
    message TEXT,
    parsed INTEGER,
    errors INTEGER,
    time TEXT,
    lastCompletedDate TEXT
  );

  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT DEFAULT '',
    links TEXT DEFAULT '[]',
    notifyTime TEXT,
    notifySentDate TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    companyId TEXT NOT NULL,
    name TEXT,
    role TEXT,
    phone TEXT,
    comment TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL,
    label TEXT,
    active INTEGER DEFAULT 1,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    lastUsedAt DATETIME
  );

  CREATE TABLE IF NOT EXISTS dedupe_ignored (
    nameKey TEXT NOT NULL,
    addrKey TEXT NOT NULL,
    ignoredAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (nameKey, addrKey)
  );

  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL,
    username TEXT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    imagePath TEXT,
    status TEXT DEFAULT 'new',
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status);

  CREATE INDEX IF NOT EXISTS idx_contacts_companyId ON contacts(companyId);
  CREATE INDEX IF NOT EXISTS idx_decl_regDate ON declarations(regDate);
  CREATE INDEX IF NOT EXISTS idx_decl_status ON declarations(status);
  CREATE INDEX IF NOT EXISTS idx_decl_farmerType ON declarations(farmerType);
  CREATE INDEX IF NOT EXISTS idx_decl_inn ON declarations(inn);
  CREATE INDEX IF NOT EXISTS idx_decl_fsaId ON declarations(fsaId);
`);

// Migrations for existing databases
const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!userCols.includes('subscriptionUntil')) {
  db.exec('ALTER TABLE users ADD COLUMN subscriptionUntil DATETIME');
}
if (!userCols.includes('subscriptionPlan')) {
  db.exec('ALTER TABLE users ADD COLUMN subscriptionPlan TEXT');
}
if (!userCols.includes('tgChatId')) {
  db.exec('ALTER TABLE users ADD COLUMN tgChatId TEXT');
}
const statusCols = db.prepare("PRAGMA table_info(status)").all().map(c => c.name);
if (!statusCols.includes('lastCompletedDate')) {
  db.exec('ALTER TABLE status ADD COLUMN lastCompletedDate TEXT');
}
const companiesCols = db.prepare("PRAGMA table_info(companies)").all().map(c => c.name);
if (!companiesCols.includes('regDate')) {
  db.exec('ALTER TABLE companies ADD COLUMN regDate TEXT');
}
if (!companiesCols.includes('autoNote')) {
  db.exec('ALTER TABLE companies ADD COLUMN autoNote TEXT');
}
const favCols = db.prepare("PRAGMA table_info(favorites)").all().map(c => c.name);
if (!favCols.includes('userId')) {
  db.exec('ALTER TABLE favorites ADD COLUMN userId INTEGER NOT NULL DEFAULT 1');
  // сбрасываем UNIQUE, т.к. он изменился (теперь userId+inn+name)
  // в SQLite нельзя ALTER UNIQUE — пересоздаём через временную таблицу
  db.exec(`
    CREATE TABLE favorites_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL DEFAULT 1,
      inn TEXT, name TEXT,
      addedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(userId, inn, name)
    );
    INSERT OR IGNORE INTO favorites_new (id, userId, inn, name, addedAt)
      SELECT id, userId, inn, name, addedAt FROM favorites;
    DROP TABLE favorites;
    ALTER TABLE favorites_new RENAME TO favorites;
  `);
}
const folderCols = db.prepare("PRAGMA table_info(folders)").all().map(c => c.name);
if (!folderCols.includes('userId')) {
  db.exec('ALTER TABLE folders ADD COLUMN userId INTEGER NOT NULL DEFAULT 1');
}
if (!userCols.includes('sessionId')) {
  db.exec('ALTER TABLE users ADD COLUMN sessionId TEXT');
}
if (!userCols.includes('groupId')) {
  db.exec('ALTER TABLE users ADD COLUMN groupId TEXT');
}

// Миграции таблицы companies (export-base поля)
const companiesExCols = db.prepare("PRAGMA table_info(companies)").all().map(c => c.name);
for (const col of ['phone','email','website','ceoName','employees','revenue','revenueRaw','ebEnrichedAt']) {
  if (!companiesExCols.includes(col)) {
    const type = col === 'revenueRaw' ? 'INTEGER' : 'TEXT';
    db.exec(`ALTER TABLE companies ADD COLUMN ${col} ${type}`);
  }
}

// Таблица групповых подписок (1 подписка — несколько пользователей компании)
db.exec(`
  CREATE TABLE IF NOT EXISTS group_subscriptions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    ownerId INTEGER NOT NULL,
    maxUsers INTEGER NOT NULL DEFAULT 5,
    subscriptionUntil DATETIME,
    subscriptionPlan TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (ownerId) REFERENCES users(id)
  );
`);

module.exports = db;
