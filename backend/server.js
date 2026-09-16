/**
 * Professional FSA Declarations Parser — Server Entry Point
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const path = require('path');
const cron = require('node-cron');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const logger = require('./services/logger');
const db = require('./services/db');
const fsaConfig = require('./config/fsaConfig');
const { createFsaApiClient } = require('./services/apiClient');
const { createDeclarationService } = require('./services/declarationService');
const parser = require('./services/parser');
const { runParser } = require('./services/parserService');
const { runOpendataImport } = require('./services/opendataService');

// Routes
const authRoutes = require('./routes/auth');
const declarationRoutes = require('./routes/declarations');
const businessRoutes = require('./routes/business');
const folderRoutes = require('./routes/folders');
const systemRoutes = require('./routes/system');
const enrichRoutes = require('./routes/enrich');
const paymentRoutes = require('./routes/payment');
const adminRoutes = require('./routes/admin');
const notesRoutes = require('./routes/notes');
const externalRoutes = require('./routes/external');
const feedbackRoutes    = require('./routes/feedback');
const userContactRoutes = require('./routes/userContacts');
const { enrichExisting, autoEnrichJob } = require('./services/innEnricher');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
const isProd = process.env.NODE_ENV === 'production';

// upgrade-insecure-requests (Helmet default) forces the browser to fetch CSS/JS over
// https even when the page loaded over http — breaks IP-only/no-TLS-yet deployments.
const appUsesHttps = (process.env.APP_URL || '').startsWith('https://');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'unpkg.com'],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'unpkg.com'],
      imgSrc: ["'self'", 'data:', 'server.arcgisonline.com'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      ...(appUsesHttps ? {} : { upgradeInsecureRequests: null }),
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(compression());

// CORS: allow only same origin (or APP_URL in production)
const allowedOrigin = process.env.APP_URL || (isProd ? null : 'http://localhost:3001');
app.use(cors({
  origin: allowedOrigin ? (o, cb) => cb(null, !o || o === allowedOrigin) : false,
  credentials: true,
}));

app.use(morgan('short', { stream: { write: message => logger.info(message.trim()) } }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.use('/uploads', express.static(path.join(__dirname, 'data', 'uploads')));

// Swagger Setup (only in development)
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'FSA Parser API',
      version: '6.0.0',
      description: 'Professional API for FSA Declarations Parser',
    },
    servers: [
      {
        url: `http://localhost:${PORT}`,
      },
    ],
  },
  apis: ['./routes/*.js'],
};
const swaggerSpec = swaggerJsdoc(swaggerOptions);
if (!isProd) {
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
}

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/declarations', declarationRoutes);
app.use('/api/business', businessRoutes);
app.use('/api/folders', folderRoutes);
app.use('/api/system', systemRoutes);
app.use('/api/enrich', enrichRoutes);
app.use('/api/notes', notesRoutes);
app.use('/api/external', externalRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/user/contacts', userContactRoutes);

// Legacy/Redirect routes for frontend compatibility
app.use('/api/status', systemRoutes);
app.use('/api/stats', systemRoutes);
app.use('/api/settoken', systemRoutes);
app.use('/api/producers', declarationRoutes);
app.use('/api/map-data', declarationRoutes);
app.use('/api/company', businessRoutes);
app.use('/api/favorites', businessRoutes);

// Parser Orchestration
const apiClient = createFsaApiClient(fsaConfig);
const declarationService = createDeclarationService(apiClient, fsaConfig);

let parserRunning = false;

/**
 * Открытые данные РДС (opendataService) теперь закрывают историю месячными
 * архивами без лимита пагинации — живому API больше не нужно вычитывать всё
 * с DATE_FROM на каждый прогон (это и было "постоянным парсингом"). Если
 * FSA_DATE_FROM не задан явно (нет ручного бэкафилла в разработке), по
 * умолчанию сканируем только текущий месяц — этого достаточно для свежести,
 * а historical gap-fill делает opendataService.
 */
function startOfCurrentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
}

async function safeRunParser() {
  if (parserRunning) return;
  parserRunning = true;
  try {
    await runParser(apiClient, declarationService, {
      ...fsaConfig,
      PAGE_SIZE: Math.min(100, Math.max(1, Number(process.env.FSA_PAGE_SIZE) || 100)),
      MAX_PAGES_PER_RUN: (() => {
        const a = Number(process.env.FSA_MAX_PAGES_PER_RUN);
        if (Number.isFinite(a) && a > 0) return a;
        const legacy = Number(process.env.FSA_PAGES_PER_RUN);
        if (Number.isFinite(legacy) && legacy > 0) return legacy;
        return 0;
      })(),
      DELAY_MS: Number(process.env.FSA_DELAY_MS) || 1500,
      DETAIL_DELAY_MS: Number(process.env.FSA_DETAIL_DELAY_MS) || 300,
      MAX_RECORDS: Number(process.env.FSA_MAX_RECORDS) || 0,
      TECH_REGLAMENT: (process.env.FSA_TECH_REGLAMENT || '').trim().toLowerCase(),
      TECH_REG_IDS: (() => {
        const raw = process.env.FSA_TECH_REG_IDS || '32';
        if (!raw) return [];
        return raw.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0);
      })(),
      FILTERS: (() => {
        try { return process.env.FSA_FILTERS ? JSON.parse(process.env.FSA_FILTERS) : {}; }
        catch { return {}; }
      })(),
      DATE_FROM: process.env.FSA_DATE_FROM || startOfCurrentMonth(),
      DATE_TO: process.env.FSA_DATE_TO || '',
      DATE_CHUNK: (() => {
        const v = (process.env.FSA_DATE_CHUNK || '').toLowerCase().trim();
        if (v === 'week') return 7;
        if (v === 'biweek') return 14;
        if (v === 'month') return 30;
        if (v === 'day') return 1;
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) return n;
        // Ручной бэкафилл (FSA_DATE_FROM задан явно) требует своего явного DATE_CHUNK,
        // как и раньше. Дефолтный режим "текущий месяц" сам себе выставляет неделю.
        return process.env.FSA_DATE_FROM ? 0 : 7;
      })(),
    });
  } catch (err) {
    logger.error('Parser execution error: %s', err.message);
  } finally {
    parserRunning = false;
  }
}

systemRoutes.setRunParser(safeRunParser);
systemRoutes.setApiClient(apiClient);

let opendataRunning = false;

async function safeRunOpendataImport() {
  if (opendataRunning || parserRunning) return;
  opendataRunning = true;
  try {
    await runOpendataImport(fsaConfig);
  } catch (err) {
    logger.error('Opendata import error: %s', err.message);
  } finally {
    opendataRunning = false;
  }
}

// Initialization
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    logger.info(`Server running on http://localhost:${PORT}`);
    logger.info(`API Docs: http://localhost:${PORT}/api-docs`);

    // Create default admin if none exists
    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    if (userCount === 0) {
      const tempPassword = crypto.randomBytes(9).toString('base64url'); // ~12 случайных символов
      const hashed = bcrypt.hashSync(tempPassword, 12);
      db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run('admin', hashed, 'admin');
      logger.warn('========================================================================');
      logger.warn(`⚠️  Создан аккаунт admin. Пароль (показывается только один раз): ${tempPassword}`);
      logger.warn('⚠️  Запишите его и смените через /профиль при первом входе!');
      logger.warn('========================================================================');
    }

    // Start cron
    cron.schedule(process.env.FSA_CRON_SCHEDULE || '*/30 * * * *', safeRunParser);

    // Открытые данные РДС — раз в сутки доливает то, что живой API (теперь
    // сканирующий только текущий месяц) не покрывает — предыдущие месяцы,
    // при необходимости историю с января 2022
    cron.schedule(fsaConfig.opendata.cronSchedule, safeRunOpendataImport);

    // Daily auto-enrichment at 00:05 UTC (limit 9500 API calls/day)
    cron.schedule('5 0 * * *', () => {
      if (autoEnrichJob.running) {
        logger.info('[AUTO-ENRICH] Пропуск: обогащение уже запущено');
        return;
      }
      // parserRunning намеренно не блокирует: парсер работает почти постоянно
      // во время бэкфилла и ранее из-за этого обогащение пропускалось каждый день.
      // Дефолт снижен с 9500 до 3000: при 1500ms delay 9500 записей = 4+ часа
      // непрерывной нагрузки; 3000 хватает на прирост дневных деклараций и
      // укладывается в ~75 мин, не мешая пиковому дневному трафику пользователей.
      const MAX_DAILY = parseInt(process.env.ENRICH_DAILY_LIMIT || '3000');
      // Загружаем только столько записей, сколько успеем обработать за день —
      // не весь массив целиком: на 4M+ строках это вызывает OOM.
      const records = db.prepare(
        "SELECT * FROM declarations WHERE farmerType IS NULL OR farmerType = 'unknown' LIMIT ?"
      ).all(MAX_DAILY);
      if (!records.length) {
        logger.info('[AUTO-ENRICH] Нет записей для обогащения');
        return;
      }
      Object.assign(autoEnrichJob, { running: true, done: 0, total: 0, errors: 0, apiCalls: 0, startedAt: new Date().toISOString() });
      const updateStmt = db.prepare('UPDATE declarations SET farmerType = ?, okved = ?, inn = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?');
      const saveDb = () => db.transaction(recs => recs.forEach(r => updateStmt.run(r.farmerType, r.okved, r.inn, r.id)))(records);
      setImmediate(() =>
        enrichExisting(records, autoEnrichJob, saveDb, { maxApiCalls: MAX_DAILY })
          .then(() => logger.info(`[AUTO-ENRICH] Завершено: ${autoEnrichJob.apiCalls} запросов API, обработано ${autoEnrichJob.done}/${autoEnrichJob.total}`))
          .catch(e => { logger.error('[AUTO-ENRICH] Ошибка: %s', e.message); autoEnrichJob.running = false; })
      );
      logger.info(`[AUTO-ENRICH] Запущено: ${records.length} записей без типа, лимит ${MAX_DAILY} запросов/день`);
    });

    // Run parser after 5 seconds
    setTimeout(safeRunParser, 5000);
  });
}

// Global error handler — never leak stack traces to client
app.use((err, req, res, _next) => {
  logger.error('Unhandled error: %s', err.message);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

module.exports = { app, safeRunParser };
