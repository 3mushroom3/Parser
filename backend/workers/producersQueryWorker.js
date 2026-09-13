// GROUP BY producerKey не может отдавать строки потоково (SQLite обязан
// материализовать все группы прежде чем вернуть первую), поэтому
// .iterate()/setImmediate в основном процессе не спасает — весь расчёт
// (десятки секунд — минуты на 4.9M строк) блокирует единственный поток
// Node целиком, вешая сайт для всех. Выносим сам запрос в отдельный поток:
// require('../services/db') открывает независимое соединение к тому же
// файлу (миграции в db.js идемпотентны, повторный прогон безвреден).
const { parentPort, workerData } = require('worker_threads');
const db = require('../services/db');

try {
  const { dataQuery, params, orderParams } = workerData;
  const rows = db.prepare(dataQuery).all(...params, ...orderParams);
  parentPort.postMessage({ rows });
} catch (err) {
  parentPort.postMessage({ error: err.message });
}
