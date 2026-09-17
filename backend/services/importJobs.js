const path = require('path');
const { Worker } = require('worker_threads');

const WORKER_PATH = path.join(__dirname, '../workers/importWorker.js');

// Запускает операцию импорта (preview / process / adminImport) в отдельном
// потоке, см. workers/importWorker.js. Ошибки разбора файла приходят как
// обычный Error с текстом для пользователя.
function runImportJob(op, args) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, { workerData: { op, args } });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      fn(value);
    };
    worker.once('message', msg => (msg.error ? finish(reject, new Error(msg.error)) : finish(resolve, msg.result)));
    worker.once('error', err => finish(reject, err));
    worker.once('exit', code => finish(reject, new Error(`Обработка файла прервана (код ${code})`)));
  });
}

module.exports = { runImportJob };
