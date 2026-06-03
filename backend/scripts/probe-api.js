/**
 * Диагностика: печатает сырой ответ FSA API (список + карточка).
 * Запуск: node scripts/probe-api.js [declarationId]
 *         node scripts/probe-api.js --tech-regs   # найти ID регламентов
 */
const fsaConfig = require('../config/fsaConfig');
const { createFsaApiClient } = require('../services/apiClient');

(async () => {
  const arg = process.argv[2] || '16827658';
  const client = createFsaApiClient(fsaConfig);

  await client.ensureAuth();

  // --- Режим поиска ID технических регламентов ---
  if (arg === '--tech-regs') {
    const query = (process.argv[3] || 'зерн').toLowerCase();
    console.log(`\n=== TECH REGLAMENTS (поиск idTechReg для: "${query}") ===`);

    // Сканируем idTechReg 1..100 через основной list API
    // Если список вернул результат с нужным регламентом — нашли ID
    const baseFilter = {
      status: [], idDeclType: [], idCertObjectType: [], idProductType: [],
      idGroupRU: [], idGroupEEU: [],
      idDeclScheme: [], idApplicantType: [], idProductEEU: [], idProductOrigin: [], idProductRU: [],
      regDate: { minDate: null, maxDate: null },
      endDate: { minDate: null, maxDate: null },
      columnsSearch: [], awaitForApprove: null, awaitOperatorCheck: null,
      checkerAIProtocolsMistakes: null, checkerAIProtocolsResults: null, checkerAIResult: null,
      editApp: null, hiddenFromOpen: null, isProtocolInvalid: null, violationSendDate: null,
    };

    console.log('Сканирую idTechReg от 1 до 100...');
    const found = [];
    for (let id = 1; id <= 100; id++) {
      try {
        const r = await client.postDeclarationsList({
          page: 0, size: 1, count: 0,
          columnsSort: [{ column: 'declDate', sort: 'DESC' }],
          filter: { ...baseFilter, idTechReg: [id] },
        });
        const total = r?.total ?? 0;
        const name = r?.items?.[0]?.technicalReglaments || '';
        const hits = Number(total);
        if (hits > 0 && name.toLowerCase().includes(query)) {
          console.log(`  ✓ idTechReg=${id} → total=${total} | "${name}"`);
          found.push({ id, name, total });
        } else if (hits > 0) {
          process.stdout.write(`  [${id}] total=${total} | "${name.slice(0, 60)}"\n`);
        }
        // небольшая пауза чтобы не перегружать API
        await new Promise(r => setTimeout(r, 150));
      } catch (e) {
        if (e.response?.status === 400) {
          // Невалидный ID — пропускаем молча
        } else {
          console.warn(`  [${id}] ошибка: ${e.message}`);
        }
      }
    }

    if (found.length) {
      console.log(`\n=== РЕЗУЛЬТАТ ===`);
      for (const f of found) {
        console.log(`FSA_TECH_REG_IDS=${f.id}  # ${f.name}`);
      }
    } else {
      console.log('\nНе найдено. Попробуйте расширить диапазон поиска (сейчас 1-100).');
    }
    process.exit(0);
  }

  // 1. Первые 2 записи из списка — смотрим структуру полей
  console.log('\n=== LIST (page 0, size 2, новый формат) ===');
  const list = await client.postDeclarationsList({
    page: 0,
    size: 2,
    count: 0,
    columnsSort: [{ column: 'declDate', sort: 'DESC' }],
    filter: {
      status: [], idDeclType: [], idCertObjectType: [], idProductType: [],
      idGroupRU: [], idGroupEEU: [], idTechReg: [],
      idDeclScheme: [], idApplicantType: [], idProductEEU: [], idProductOrigin: [], idProductRU: [],
      regDate: { minDate: null, maxDate: null },
      endDate: { minDate: null, maxDate: null },
      columnsSearch: [],
      awaitForApprove: null, awaitOperatorCheck: null,
      checkerAIProtocolsMistakes: null, checkerAIProtocolsResults: null, checkerAIResult: null,
      editApp: null, hiddenFromOpen: null, isProtocolInvalid: null, violationSendDate: null,
    },
  });
  console.log(`total=${list?.total}`);
  console.log(JSON.stringify(list?.items?.[0], null, 2));

  // 2. Карточка декларации — печатаем ВСЕ поля верхнего уровня
  console.log(`\n=== DETAIL id=${arg} (все поля) ===`);
  const detail = await client.getDeclarationById(arg);
  // Только скалярные / массивные поля — без вложенных объектов чтобы не засорять вывод
  const topLevel = {};
  for (const [k, v] of Object.entries(detail)) {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) topLevel[k] = v;
  }
  console.log(JSON.stringify(topLevel, null, 2));
  // Вложенные объекты — только ключи и первый уровень значений
  for (const [k, v] of Object.entries(detail)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      console.log(`  [obj] ${k}:`, JSON.stringify(v).slice(0, 200));
    }
  }

  // 3. Быстрая проверка кандидатов idTechReg для "О безопасности зерна"
  console.log('\n=== FILTER TEST (idTechReg candidates) ===');
  const candidates = process.argv[3]
    ? process.argv[3].split(',').map(Number)
    : [27, 32, 97161];
  const baseFilter2 = {
    status: [], idDeclType: [], idCertObjectType: [], idProductType: [],
    idGroupRU: [], idGroupEEU: [],
    idDeclScheme: [], idApplicantType: [], idProductEEU: [], idProductOrigin: [], idProductRU: [],
    regDate: { minDate: null, maxDate: null }, endDate: { minDate: null, maxDate: null },
    columnsSearch: [], awaitForApprove: null, awaitOperatorCheck: null,
    checkerAIProtocolsMistakes: null, checkerAIProtocolsResults: null, checkerAIResult: null,
    editApp: null, hiddenFromOpen: null, isProtocolInvalid: null, violationSendDate: null,
  };
  for (const id of candidates) {
    try {
      const r = await client.postDeclarationsList({
        page: 0, size: 1, count: 0,
        columnsSort: [{ column: 'declDate', sort: 'DESC' }],
        filter: { ...baseFilter2, idTechReg: [id] },
      });
      console.log(`idTechReg=[${id}] → total=${r?.total}, technicalReglaments="${r?.items?.[0]?.technicalReglaments ?? 'N/A'}"`);
      await new Promise(res => setTimeout(res, 1000));
    } catch (e) {
      console.log(`idTechReg=[${id}] → ERROR ${e.response?.status}: ${e.message}`);
    }
  }

  // 4. Тест фильтра по дате с правильным форматом
  console.log('\n=== FILTER TEST (regDate, правильный формат) ===');
  const base = await client.postDeclarationsList({
    page: 0, size: 2, count: 0,
    columnsSort: [{ column: 'declDate', sort: 'DESC' }],
    filter: {
      status: [], idDeclType: [], idCertObjectType: [], idProductType: [],
      idGroupRU: [], idGroupEEU: [], idTechReg: [],
      idDeclScheme: [], idApplicantType: [], idProductEEU: [], idProductOrigin: [], idProductRU: [],
      regDate: { minDate: null, maxDate: null },
      endDate: { minDate: null, maxDate: null },
      columnsSearch: [], awaitForApprove: null, awaitOperatorCheck: null,
      checkerAIProtocolsMistakes: null, checkerAIProtocolsResults: null, checkerAIResult: null,
      editApp: null, hiddenFromOpen: null, isProtocolInvalid: null, violationSendDate: null,
    },
  });
  console.log(`Без фильтра → total=${base?.total}, first declDate=${base?.items?.[0]?.declDate}`);

  const filtered = await client.postDeclarationsList({
    page: 0, size: 2, count: 0,
    columnsSort: [{ column: 'declDate', sort: 'DESC' }],
    filter: {
      status: [], idDeclType: [], idCertObjectType: [], idProductType: [],
      idGroupRU: [], idGroupEEU: [], idTechReg: [],
      idDeclScheme: [], idApplicantType: [], idProductEEU: [], idProductOrigin: [], idProductRU: [],
      regDate: { minDate: '2024-01-01', maxDate: '2024-01-31' },
      endDate: { minDate: null, maxDate: null },
      columnsSearch: [], awaitForApprove: null, awaitOperatorCheck: null,
      checkerAIProtocolsMistakes: null, checkerAIProtocolsResults: null, checkerAIResult: null,
      editApp: null, hiddenFromOpen: null, isProtocolInvalid: null, violationSendDate: null,
    },
  });
  console.log(`regDate 2024-01 → total=${filtered?.total}, first declDate=${filtered?.items?.[0]?.declDate}`);

  console.log('\n=== HINT ===');
  console.log('Найти ID регламента "О безопасности зерна":');
  console.log('  node scripts/probe-api.js --tech-regs зерна');

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
