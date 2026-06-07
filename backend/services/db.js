const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = process.env.DB_PATH || path.join(__dirname, '../../data/fsa_parser.db');

// Ensure data directory exists
if (!fs.existsSync(path.dirname(dbPath))) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

const db = new Database(dbPath);

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
    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inn TEXT,
    name TEXT,
    addedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(inn, name)
  );

  CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
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
    time TEXT
  );
`);

// Migrations for existing databases
const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!userCols.includes('subscriptionUntil')) {
  db.exec('ALTER TABLE users ADD COLUMN subscriptionUntil DATETIME');
}
if (!userCols.includes('subscriptionPlan')) {
  db.exec('ALTER TABLE users ADD COLUMN subscriptionPlan TEXT');
}

module.exports = db;
