const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');
const { path7za } = require('7zip-bin');
const log = require('./logger');

/**
 * Клиент открытых данных РДС (fsa.gov.ru/opendata/7736638268-rds) — статические
 * файлы, без авторизации. Помесячные (или за несколько месяцев) архивы .7z с CSV
 * внутри, без пагинации и без лимита FSA API (RDS-APP-9995).
 */

const ARCHIVE_LINK_RE = /data-(\d{8})-structure-\d{8}\.7z/g;

/** Список доступных архивов со страницы открытых данных, отсортированный по дате в имени (новые → старые — как и остальные данные в проекте, см. CLAUDE.md "новые записи prepend-ятся") */
async function listAvailableArchives(pageUrl) {
  const res = await axios.get(pageUrl, {
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; fsa-parser-opendata/1.0)' },
  });
  const html = String(res.data || '');
  const base = pageUrl.replace(/\/?$/, '/');

  const seen = new Set();
  const archives = [];
  let m;
  ARCHIVE_LINK_RE.lastIndex = 0;
  while ((m = ARCHIVE_LINK_RE.exec(html))) {
    const filename = m[0];
    if (seen.has(filename)) continue;
    seen.add(filename);
    archives.push({ filename, date: m[1], url: new URL(filename, base).toString() });
  }
  archives.sort((a, b) => b.date.localeCompare(a.date));
  return archives;
}

/** Скачивает архив в destDir, если его там ещё нет. Возвращает путь к файлу. */
async function downloadArchive(archive, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, archive.filename);
  if (fs.existsSync(dest)) {
    log.info(`opendata: ${archive.filename} уже скачан, пропуск загрузки`);
    return dest;
  }

  const tmp = dest + '.part';
  const res = await axios.get(archive.url, {
    responseType: 'stream',
    timeout: 300000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; fsa-parser-opendata/1.0)' },
  });

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp);
    res.data.pipe(out);
    res.data.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
  });
  fs.renameSync(tmp, dest);
  log.info(`opendata: скачан ${archive.filename}`);
  return dest;
}

/**
 * Распаковывает .7z в destDir, возвращает пути ко всем извлечённым .csv.
 * Вызывает 7za напрямую через spawn (не через 7zip-min): у 7zip-min stdout
 * ребёнка никто не читает, и на архивах в сотни МБ 7za блокируется на
 * заполненном pipe-буфере — процесс "зависает" навсегда (проверено эмпирически).
 */
async function extractArchive(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  await new Promise((resolve, reject) => {
    const proc = spawn(path7za, ['x', '-y', '-bd', '-bb0', `-o${destDir}`, archivePath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`7za завершился с кодом ${code}: ${stderr.slice(0, 500)}`));
    });
  });
  return fs
    .readdirSync(destDir)
    .filter((f) => f.toLowerCase().endsWith('.csv'))
    .map((f) => path.join(destDir, f));
}

module.exports = { listAvailableArchives, downloadArchive, extractArchive };
