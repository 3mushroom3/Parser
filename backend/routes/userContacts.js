const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const auth    = require('../middleware/auth');
const requireSubscription = require('../middleware/subscription');
const {
  getUploads, deleteUpload, getContactsForCompany, getPrivateCompanies,
} = require('../services/userContactsParser');
const { runImportJob } = require('../services/importJobs');

const MAX_FILE_MB = 50;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(xls|xlsx|ods|csv)$/i.test(file.originalname);
    cb(ok ? null : new Error('Поддерживаются только файлы XLS, XLSX, CSV'), ok);
  },
});

// POST /api/user/contacts/preview — шаг 1: загружает файл, возвращает превью колонок
router.post('/preview', auth, requireSubscription, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `Файл слишком большой. Максимум ${MAX_FILE_MB} МБ.`
        : err.message;
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'Файл не передан' });
    try {
      // Multer получает имя файла как latin1-байты, декодируем в utf8
      const originalname = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
      const result = await runImportJob('preview', [req.user.id, req.file.buffer, originalname]);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
});

// POST /api/user/contacts/process — шаг 2: обрабатывает с маппингом пользователя
router.post('/process', auth, requireSubscription, async (req, res) => {
  const { uploadId, mapping } = req.body;
  if (!uploadId || !mapping) return res.status(400).json({ error: 'uploadId и mapping обязательны' });
  try {
    const result = await runImportJob('process', [req.user.id, Number(uploadId), mapping]);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/user/contacts/uploads
router.get('/uploads', auth, (req, res) => {
  res.json(getUploads(req.user.id));
});

// DELETE /api/user/contacts/uploads/:id
router.delete('/uploads/:id', auth, (req, res) => {
  const ok = deleteUpload(req.user.id, Number(req.params.id));
  if (!ok) return res.status(404).json({ error: 'Загрузка не найдена' });
  res.json({ ok: true });
});

// GET /api/user/contacts/for-company?inn=...&name=...
router.get('/for-company', auth, (req, res) => {
  const { inn, name } = req.query;
  res.json(getContactsForCompany(req.user.id, inn || '', name || ''));
});

// GET /api/user/contacts/private?page=0
router.get('/private', auth, (req, res) => {
  const page = Math.max(0, parseInt(req.query.page) || 0);
  res.json(getPrivateCompanies(req.user.id, page));
});

module.exports = router;
