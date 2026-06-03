# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

FSA Declarations Parser — автоматически собирает декларации с `pub.fsa.gov.ru` и предоставляет REST API + SPA для работы с ними.

## Commands

```bash
cd backend && npm install   # установка зависимостей
node server.js              # запуск сервера (порт 3001)
node scripts/smoke-declaration.js 16827658  # отладка одной декларации без HTTP-сервера
node scripts/probe-api.js 16827658          # диагностика сырых ответов FSA API
```

Тестов и линтера нет.

## Architecture

**Стек:** Node.js + Express, данные хранятся в `data/declarations.json` (JSON-файл как БД).

**Поток данных:**

1. `server.js` — запускает HTTP-сервер, cron-планировщик и первый парсинг через 2 секунды после старта.
2. `services/apiClient.js` — управляет сессией с FSA: анонимный логин → JWT-токен → кешируется до истечения. При 401/403 — авто-обновление. XSRF-токен извлекается из куки (`authUtils.js`) и передаётся в каждом запросе.
3. `services/declarationService.js` — батч-загрузка деклараций с контролем конкурентности (`p-limit`).
4. `services/parser.js` — нормализует ответы FSA API в единую схему.
5. `server.js` — роуты CRUD, поиск/фильтрация в памяти по загруженному JSON, дедупликация по `id`.

**Frontend:** `frontend/index.html` — единый файл (~1000+ строк), ванильный JS + CSS без фреймворков.

## Key Config (environment variables)

Все переменные имеют дефолты в `backend/config/fsaConfig.js`:

| Переменная | Дефолт | Назначение |
|---|---|---|
| `FSA_CRON_SCHEDULE` | `*/30 * * * *` | Расписание парсинга |
| `FSA_PAGE_SIZE` | `100` | Страниц за запрос (макс. 100) |
| `FSA_MAX_RECORDS` | `0` (без лимита) | Максимум записей в БД |
| `FSA_FETCH_CONCURRENCY` | `3` | Параллельных запросов деклараций |
| `FSA_DELAY_MS` | `1500` | Задержка между запросами (мс) |
| `FSA_MANUAL_TOKEN` | — | JWT вручную, минуя авто-логин |
| `FSA_TECH_REG_IDS` | — | Числовые ID техрегламентов `filter.idTechReg` (через запятую). **`32` = ТР ТС 015/2011 "О безопасности зерна"** |
| `FSA_TECH_REGLAMENT` | — | Локальный фильтр (резервный): подстрока названия регламента. Менее точен чем `FSA_TECH_REG_IDS` |
| `FSA_FILTERS` | `{}` | Доп. поля в `filter{}` FSA API (JSON, перезаписывают базовые) |
| `FSA_DATE_FROM` | — | Дата начала (YYYY-MM-DD) → `filter.regDate.minDate` (**работает в API**) |
| `FSA_DATE_TO` | — | Дата конца (YYYY-MM-DD) → `filter.regDate.maxDate` |
| `FSA_DATE_CHUNK` | — | Нарезка диапазона на окна: `week`/`biweek`/`month`/`day`/число дней. **Обязательно для полного скачивания.** |
| `PORT` | `3001` | Порт HTTP-сервера |

## Data Schema

Каждая запись в `data/declarations.json`:

```js
{
  id: string,           // fsaId (для FSA) или "manual_{timestamp}"
  declNumber: string,   // номер декларации: "ЕАЭС N RU Д-..."
  source: 'fsa' | 'manual',
  status: 'active' | 'suspended' | 'expired',
  group, technicalReglament, regDate, endDate,
  lastName, firstName, middleName, shortName, address, phone,
  productName, batchSize, otherInfo, fsaUrl, fsaId
}
```

## Non-obvious Behaviours

- При 5 последовательных ошибках загрузки страницы списка — парсинг прерывается.
- Ошибка загрузки отдельной декларации — логируется, парсинг продолжается.
- Новые записи **prepend**-ятся в массив (новейшие — первые).
- `MAX_RECORDS` обрезает массив после каждого прогона.
- CSV-экспорт отдаётся с UTF-8 BOM для корректного открытия в Excel.
- `POST /api/settoken` позволяет установить JWT вручную в runtime без перезапуска.
- **FSA API хранит регламент как полное название** (`"О безопасности зерна"`), а не код (`"ТР ТС 015/2011"`). Поиск по коду не работает — искать по подстроке названия.
- **Текстовые фильтры `technicalReglaments` FSA API игнорирует** — фильтрация реализована локально через `FSA_TECH_REGLAMENT` (срабатывает до загрузки карточки, экономя N запросов на несовпадающие записи).
- **FSA API лимит: страница 21+ возвращает HTTP 400 `RDS-APP-9995`** — жёсткий лимит на глубину пагинации. `total` в ответе всегда возвращает 1000 — это заглушка, реальный объём неизвестен. Даже один месяц содержит >2100 деклараций по зерновому регламенту. Для полного скачивания **обязательно** использовать `FSA_DATE_CHUNK=week` + `FSA_DATE_FROM`. Парсер сам нарезает диапазон на недельные окна и итерирует по ним; если окно всё равно упирается в лимит — логирует предупреждение и советует уменьшить `DATE_CHUNK`.
- **Правильный формат запроса FSA API**: тело POST использует `filter{}` (не `filters`), `columnsSort`, `count`. Текстовые фильтры API **игнорирует** — только числовые ID (`idTechReg`, `status` и др.).
