# Развёртывание на Linux-сервере

Инструкция для чистого Ubuntu/Debian-сервера (22.04/12 или новее). Для другого дистрибутива меняются только команды установки пакетов (шаг 1).

## 0. Что нужно заранее

- SSH-доступ к серверу с правами sudo.
- Домен, направленный на IP сервера (A-запись) — нужен для HTTPS. Без домена сайт будет работать по HTTP/IP, но это не рекомендуется для продакшена (логин/пароли будут идти в открытом виде).
- Учётные данные ЮKassa (если нужны платежи), Telegram Bot Token (если нужны уведомления) — не обязательны для первого запуска.

## 1. Системные зависимости

```bash
sudo apt update && sudo apt upgrade -y

# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git nginx p7zip-full

node -v   # проверить, что встало (v20.x)
```

`p7zip-full` даёт системный `7z`/`7za` — не обязателен (проект использует `7zip-bin`, свой бинарник внутри `node_modules`), но полезен для ручной диагностики архивов открытых данных.

## 2. Клонирование и установка

```bash
sudo mkdir -p /var/www/baza-apk
sudo chown $USER:$USER /var/www/baza-apk
git clone https://github.com/3mushroom3/Parser.git /var/www/baza-apk
cd /var/www/baza-apk/backend
npm install --omit=dev
```

## 3. Конфигурация (`.env`)

```bash
cp .env.example .env
nano .env
```

Обязательно задать:

```bash
NODE_ENV=production
PORT=3001
JWT_SECRET=<сгенерировать: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))">
APP_URL=https://ваш-домен.ру
```

Остальное (`YUKASSA_*`, `DADATA_TOKEN`, тарифы) — по необходимости, есть рабочие дефолты для всего, кроме `JWT_SECRET`.

**Важно:** без `JWT_SECRET` длиной от 32 символов сервер откажется стартовать (это специально, см. `backend/config/jwtSecret.js`) — не обходите это через `ALLOW_INSECURE_JWT_SECRET=true` на проде.

## 4. Первый запуск и пароль администратора

```bash
node server.js
```

На пустой базе создаётся аккаунт `admin` со случайным паролем — он печатается **один раз** в консоль:

```
⚠️  Создан аккаунт admin. Пароль (показывается только один раз): <пароль>
```

**Скопируйте его сразу** — больше он нигде не хранится. Если пропустили: остановите сервер, удалите пользователя из базы (`sqlite3 data/fsa_parser.db "DELETE FROM users WHERE username='admin'"`) и запустите заново.

Остановите тестовый запуск (`Ctrl+C`) — дальше сервис поднимается через PM2.

## 5. PM2 (автозапуск, автоперезапуск при падении)

```bash
sudo npm install -g pm2
cd /var/www/baza-apk/backend
pm2 start server.js --name baza-apk
pm2 save
pm2 startup   # выполнить команду, которую предложит pm2 (регистрирует автозапуск при перезагрузке сервера)
```

Полезные команды:
```bash
pm2 logs baza-apk        # логи в реальном времени
pm2 restart baza-apk     # перезапуск после обновления кода
pm2 status               # статус процесса
```

## 6. Nginx как обратный прокси

```bash
sudo nano /etc/nginx/sites-available/baza-apk
```

```nginx
server {
    listen 80;
    server_name ваш-домен.ру;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    client_max_body_size 20M;   # загрузка XLS-файлов в «Мои базы»
}
```

```bash
sudo ln -s /etc/nginx/sites-available/baza-apk /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

## 7. HTTPS (Let's Encrypt)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d ваш-домен.ру
```

Certbot сам допишет блок `listen 443 ssl` в конфиг nginx и настроит автопродление сертификата (проверить: `sudo certbot renew --dry-run`).

## 8. Файрвол

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'   # 80 + 443
sudo ufw enable
```

Порт 3001 (сам Node-процесс) **не должен** быть открыт наружу — трафик идёт только через nginx на localhost.

## 9. Первичное наполнение данными

После первого запуска база пустая. Живой парсер сам подхватит текущий месяц через 5 секунд после старта и далее каждые 30 минут. Для истории — разовый бэкафилл открытых данных РДС (может занять час+, качает архивы за все месяцы с начала 2022):

```bash
cd /var/www/baza-apk/backend
node scripts/backfill-opendata.js
```

Можно запускать сразу после `pm2 start`, независимо от него (это отдельный одноразовый скрипт, не часть постоянного процесса) — но не одновременно с активным прогоном живого парсера (проверить `pm2 logs`, дождаться идла), чтобы не создавать конкуренцию за SQLite-файл.

## 10. Обновление после изменений в коде

```bash
cd /var/www/baza-apk
git pull origin main
cd backend
npm install --omit=dev   # если менялись зависимости
pm2 restart baza-apk
```

## 11. Бэкапы

База — один файл SQLite (`backend/data/fsa_parser.db` или путь из `DB_PATH`). Достаточно копировать его целиком:

```bash
# Пример: ежедневный бэкап в cron (crontab -e)
0 3 * * * cp /var/www/baza-apk/backend/data/fsa_parser.db /var/backups/baza-apk-$(date +\%F).db
```

Через `sqlite3 .backup` безопаснее делать бэкап "на горячую" (без риска скопировать файл в момент записи):
```bash
sqlite3 /var/www/baza-apk/backend/data/fsa_parser.db ".backup /var/backups/baza-apk-$(date +%F).db"
```

Держите не больше 7-14 копий (добавить `find /var/backups -name 'baza-apk-*.db' -mtime +14 -delete` в тот же cron).

## Чек-лист перед тем как считать деплой готовым

- [ ] `pm2 status` показывает `baza-apk` в статусе `online`
- [ ] Сайт открывается по `https://ваш-домен.ру` (замок в браузере, сертификат валиден)
- [ ] Залогинились под `admin` и **сменили случайный пароль** через профиль
- [ ] `pm2 logs baza-apk` не показывает повторяющихся ошибок авторизации на FSA
- [ ] Порт 3001 не отвечает извне (`curl http://ваш-домен.ру:3001` с другой машины должен зависнуть/не подключиться)
- [ ] Настроен cron-бэкап базы
- [ ] `pm2 startup` подтверждён — процесс переживёт перезагрузку сервера
