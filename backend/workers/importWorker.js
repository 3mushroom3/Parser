// Разбор и импорт Excel/CSV-баз — в отдельном потоке. Файл на 100 тыс. строк
// разбирается секундами, а сверка с реестром проходит по индексу всей таблицы
// declarations (≈5 млн строк): синхронно на основном потоке (better-sqlite3
// синхронный) это вешало бы все остальные запросы сайта — как было со
// статистикой, см. statsQueryWorker.js.
const { parentPort, workerData } = require('worker_threads');

// Buffer при передаче в поток превращается в Uint8Array
const toBuffer = v => (v instanceof Uint8Array && !Buffer.isBuffer(v) ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v);

(async () => {
  try {
    const { op, args } = workerData;
    let result;
    if (op === 'preview') {
      const [userId, buffer, originalName] = args;
      result = await require('../services/userContactsParser').previewUpload(userId, toBuffer(buffer), originalName);
    } else if (op === 'process') {
      const [userId, uploadId, mapping] = args;
      result = require('../services/userContactsParser').processWithMapping(userId, uploadId, mapping);
    } else if (op === 'adminImport') {
      const [buffer, options] = args;
      result = require('../services/xlsImporter').importXlsx(toBuffer(buffer), options);
    } else {
      throw new Error(`Неизвестная операция импорта: ${op}`);
    }
    parentPort.postMessage({ result });
  } catch (e) {
    parentPort.postMessage({ error: e.message });
  }
})();
