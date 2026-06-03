# PROJECT_STRUCTURE.md — FSA Declarations Parser

## Overview

| | |
|---|---|
| **Название** | FSA Declarations Parser |
| **Версия** | 5.0.0 |
| **Архитектура** | Client-Server монорепо: Express API + SPA (Vanilla JS) |
| **Стек** | Node.js 18+, Express 4, Axios, node-cron, p-limit |
| **Хранилище** | JSON-файлы (`data/`) — без СУБД |
| **Точка входа** | `backend/server.js` |

---

## Файловая структура

```
fsa-parser/
├── backend/
│   ├── config/
│   │   └── fsaConfig.js          # Все env-переменные и дефолты в одном месте
│   ├── services/
│   │   ├── apiClient.js          # HTTP-сессия, авторизация, retry-логика
│   │   ├── authUtils.js          # JWT-парсинг, cookies, XSRF-токен
│   │   ├── declarationService.js # Батч-загрузка с p-limit
│   │   ├── parser.js             # Нормализация ответов FSA → внутренняя схема
│   │   └── logger.js             # Timestamped-логгер
│   ├── scripts/
│   │   └── smoke-declaration.js  # CLI: загрузить одну декларацию без HTTP-сервера
│   ├── server.js                 # Express-роуты, cron, чтение/запись JSON-БД
│   └── package.json
├── frontend/
│   └── index.html                # Единый SPA-файл (~1000 строк, CSS + JS встроены)
├── data/                         # Создаётся автоматически при первом запуске
│   ├── declarations.json         # Основная БД (массив записей, новейшие первыми)
│   └── status.json               # Статус последнего парсинга
├── CLAUDE.md                     # Гайд для Claude Code
├── README.md                     # Установка и настройка (для пользователей)
└── PROJECT_STRUCTURE.md          # Этот файл
```

---

## Архитектурные слои

### `config/fsaConfig.js`
Единственный источник конфигурации. Читает env-переменные с fallback-значениями. Остальные модули импортируют его — не читают `process.env` напрямую.

### `services/apiClient.js`
Stateful HTTP-клиент ФГИС. Хранит JWT-токен, cookies и время истечения в замыкании (`createFsaApiClient(cfg)`). Логика:
- `ensureAuth()` → если токен истёк, вызывает `bootstrapSession()` → `login()`
- `withRetry()` — экспоненциальный backoff (400ms → 8s) для сетевых ошибок и 5xx
- XSRF-токен извлекается из cookie и подставляется в заголовок `X-XSRF-TOKEN`

### `services/declarationService.js`
Factory `createDeclarationService(apiClient, cfg)`. Оборачивает пакетные запросы в `p-limit(cfg.concurrency)`. При ошибке одной декларации возвращает `EMPTY_DECL`, не прерывая батч.

### `services/parser.js`
Чистая функция `mapToGetDeclarationData(detail, listItem)`. Маппит нестабильные поля FSA API в фиксированную схему. `listItem` нужен для поля `group` (оно есть только в списке, не в карточке).

### `server.js`
Содержит:
- Загрузку/сохранение `declarations.json` и `status.json`
- In-memory фильтрацию, сортировку, пагинацию (без ORM)
- Cron-планировщик: запускает `runParser()` по расписанию + через 2 сек после старта
- `runParser()`: постраничный обход API → дедупликация по `id` → prepend новых → обрезка по `MAX_RECORDS`

---

## Схема одной записи

```js
{
  id: string,              // "fsa_{fsaId}" | "manual_{timestamp}"
  source: 'fsa' | 'manual',
  status: 'active' | 'suspended' | 'expired',
  group: string,           // Группа продукции ЕАЭС (из списка API)
  technicalReglament: string,
  regDate: 'YYYY-MM-DD',
  endDate: 'YYYY-MM-DD',
  lastName, firstName, middleName: string,  // Руководитель заявителя
  shortName: string,       // Название компании
  address, phone: string,
  productName: string,
  batchSize: string,
  otherInfo: string,
  fsaUrl: string,          // Ссылка на карточку на pub.fsa.gov.ru
  fsaId: string            // Оригинальный ID в системе ФГИС
}
```

---

## API эндпоинты

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/` | Отдаёт `frontend/index.html` |
| GET | `/api/declarations` | Список с фильтрами, пагинацией, сортировкой |
| GET | `/api/declarations/:id` | Одна запись |
| POST | `/api/declarations` | Ручное добавление |
| PUT | `/api/declarations/:id` | Обновление |
| DELETE | `/api/declarations/:id` | Удаление |
| GET | `/api/status` | Статус парсера, дата последнего прогона, кол-во записей |
| POST | `/api/parse` | Запустить парсинг вручную |
| GET | `/api/stats` | Счётчики по `status` и `source` |
| GET | `/api/export/csv` | CSV с UTF-8 BOM (для Excel) |
| GET | `/api/fsa/declarations/:id/data` | Нормализованные данные одной декларации с FSA |
| POST | `/api/fsa/declarations/data-batch` | Батч-запрос деклараций |
| POST | `/api/settoken` | Установить JWT вручную в runtime |
| GET | `/api/debug/fsa` | Проверка соединения с pub.fsa.gov.ru |

### Фильтры GET `/api/declarations`

```
page, size, search, source, status, group,
manufacturer, techReglament, dateFrom, dateTo,
sortField, sortDir
```

---

## Зависимости

| Пакет | Назначение |
|---|---|
| `express` | HTTP-сервер и роутинг |
| `axios` | HTTP-запросы к FSA API |
| `node-cron` | Планировщик парсинга |
| `p-limit` | Ограничение конкурентности батч-запросов |
| `cors` | CORS-заголовки |

Dev-зависимостей нет. Тестов и сборки нет.
