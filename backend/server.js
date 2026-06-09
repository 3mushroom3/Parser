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

const logger = require('./services/logger');
const db = require('./services/db');
const fsaConfig = require('./config/fsaConfig');
const { createFsaApiClient } = require('./services/apiClient');
const { createDeclarationService } = require('./services/declarationService');
const parser = require('./services/parser');
const { runParser } = require('./services/parserService');

// Routes
const authRoutes = require('./routes/auth');
const declarationRoutes = require('./routes/declarations');
const businessRoutes = require('./routes/business');
const folderRoutes = require('./routes/folders');
const systemRoutes = require('./routes/system');
const enrichRoutes = require('./routes/enrich');
const paymentRoutes = require('./routes/payment');
const adminRoutes = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
const isProd = process.env.NODE_ENV === 'production';

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'unpkg.com'],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'unpkg.com'],
      imgSrc: ["'self'", 'data:', '*.tile.openstreetmap.org', '*.openstreetmap.org'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
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

// Legacy/Redirect routes for frontend compatibility
app.use('/api/status', systemRoutes);
app.use('/api/stats', systemRoutes);
app.use('/api/producers', declarationRoutes);
app.use('/api/map-data', declarationRoutes);
app.use('/api/company', businessRoutes);
app.use('/api/favorites', businessRoutes);

// Parser Orchestration
const apiClient = createFsaApiClient(fsaConfig);
const declarationService = createDeclarationService(apiClient, fsaConfig);

let parserRunning = false;

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
      DATE_FROM: process.env.FSA_DATE_FROM || '',
      DATE_TO: process.env.FSA_DATE_TO || '',
      DATE_CHUNK: (() => {
        const v = (process.env.FSA_DATE_CHUNK || '').toLowerCase().trim();
        if (v === 'week') return 7;
        if (v === 'biweek') return 14;
        if (v === 'month') return 30;
        if (v === 'day') return 1;
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? n : 0;
      })(),
    });
  } catch (err) {
    logger.error('Parser execution error: %s', err.message);
  } finally {
    parserRunning = false;
  }
}

systemRoutes.setRunParser(safeRunParser);

// Initialization
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    logger.info(`Server running on http://localhost:${PORT}`);
    logger.info(`API Docs: http://localhost:${PORT}/api-docs`);

    // Create default admin if none exists
    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    if (userCount === 0) {
      const hashed = bcrypt.hashSync('admin', 12);
      db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run('admin', hashed, 'admin');
      logger.warn('⚠️  Создан дефолтный аккаунт admin/admin — НЕМЕДЛЕННО СМЕНИТЕ ПАРОЛЬ через /профиль!');
    }

    // Start cron
    cron.schedule(process.env.FSA_CRON_SCHEDULE || '*/30 * * * *', safeRunParser);

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
