// ── App State ─────────────────────────────────────────────────────────────
const State = {
  token: localStorage.getItem('fsa_token') || null,
  user: JSON.parse(localStorage.getItem('fsa_user') || 'null'),
  curPage: 0,
  editingId: null,
  mapInstance: null,
  mapInitialized: false,
  mapAllCities: [],
  mapFilter: '',
  curFarmerFilter: '',
  curFolderOpen: null,
  producerDataCache: new Map(),
  lastUpdatedAt: null,
  foldersCache: [],
  favsCache: [],
  folderBreadcrumb: [],
  curCompDecls: [],
  curCompContacts: [],
  curCropTab: 'all',
  detailRecord: null,
  // Навигация по производителям (текущая страница таблицы)
  navItems: [],
  navIndex: -1,
  // Навигация по декларациям внутри карточки компании
  navDeclIds: [],
  navDeclIndex: -1,
  // Мои базы
  mydbPrivatePage: 0,
  mydbPreview: null,   // данные превью от сервера
  mydbMapping: {},     // colIdx → тип ('inn'|'name'|'phone'|'phone2'|'email'|'address'|'')
};

const CITY_COORDS = {
  'Москва':[55.7558,37.6176],'Санкт-Петербург':[59.9343,30.3351],'Новосибирск':[54.9924,82.8138],
  'Екатеринбург':[56.8519,60.6122],'Казань':[55.7887,49.1221],'Нижний Новгород':[56.2965,43.9361],
  'Челябинск':[55.1644,61.4368],'Самара':[53.2038,50.15],'Уфа':[54.7388,55.9721],
  'Ростов-на-Дону':[47.2357,39.7015],'Краснодар':[45.0355,38.9753],'Воронеж':[51.672,39.1843],
  'Пермь':[58.0104,56.2502],'Волгоград':[48.708,44.5133],'Красноярск':[56.0153,92.8672],
  'Саратов':[51.5462,46.0154],'Тюмень':[57.1553,68.9683],'Тольятти':[53.5303,49.3461],
  'Омск':[54.9885,73.3242],'Барнаул':[53.3547,83.7695],'Ижевск':[56.8527,53.2116],
  'Иркутск':[52.2869,104.289],'Хабаровск':[48.4802,135.0719],'Ярославль':[57.6261,39.8845],
  'Владивосток':[43.1332,131.9113],'Махачкала':[42.9849,47.5047],'Томск':[56.4977,84.9744],
  'Оренбург':[51.7883,55.1023],'Кемерово':[55.3904,86.0427],'Новокузнецк':[53.7596,87.1152],
  'Рязань':[54.6296,39.743],'Астрахань':[46.3497,48.0408],'Набережные Челны':[55.7391,52.4049],
  'Пенза':[53.1959,45.0186],'Липецк':[52.6031,39.5708],'Тула':[54.1961,37.6182],
  'Киров':[58.5977,49.6583],'Чебоксары':[56.1439,47.2489],'Улан-Удэ':[51.8279,107.6063],
  'Курск':[51.7373,36.1873],'Ставрополь':[45.05,41.9734],'Белгород':[50.5956,36.5872],
  'Мурманск':[68.9585,33.0827],'Архангельск':[64.5405,40.5154],'Калининград':[54.7104,20.4522],
  'Сочи':[43.5855,39.7231],'Волжский':[48.7883,44.7636],'Чита':[52.0336,113.4994],
  'Орёл':[52.9651,36.0785],'Владимир':[56.129,40.407],'Брянск':[53.2434,34.3634],
  'Магнитогорск':[53.4153,58.9946],'Тверь':[56.8587,35.9176],'Иваново':[57.0005,40.9739],
  'Калуга':[54.5293,36.2754],'Нижнекамск':[55.6374,51.816],'Смоленск':[54.7818,32.0401],
  'Тамбов':[52.7212,41.4525],'Сургут':[61.2501,73.4201],'Симферополь':[44.9521,34.1024],
  'Грозный':[43.3178,45.6984],'Кострома':[57.7678,40.9268],'Шахты':[47.7094,40.2149],
  'Сыктывкар':[61.6689,50.8365],'Нижний Тагил':[57.9214,59.9707],'Петрозаводск':[61.7849,34.3469],
  'Элиста':[46.3072,44.2552],'Нальчик':[43.4846,43.6029],'Владикавказ':[43.0362,44.6677],
  'Черкесск':[44.2286,42.0578],'Майкоп':[44.6088,40.1073],'Новороссийск':[44.723,37.7694],
  'Таганрог':[47.209,38.9371],'Батайск':[47.1395,39.7538],'Новочеркасск':[47.4182,40.0939],
  'Волгодонск':[47.5168,42.162],'Армавир':[44.9936,41.1261],'Пятигорск':[44.0417,43.0631],
  'Кисловодск':[43.9054,42.731],'Ессентуки':[44.0465,42.8602],'Минеральные Воды':[44.2185,43.1398],
  'Кропоткин':[45.4354,40.5779],'Тихорецк':[45.8531,40.1218],'Темрюк':[45.2796,37.3835],
  'Ейск':[46.71,38.2716],'Анапа':[44.8879,37.3195],'Геленджик':[44.5558,38.0747],
  'Абинск':[44.8626,38.1615],'Крымск':[44.9264,37.9899],'Тимашевск':[45.6136,38.9441],
  'Зерноград':[46.8497,40.3172],'Сальск':[46.4797,41.5394],'Белая Калитва':[48.1826,40.8017],
  'Гулькевичи':[45.3586,40.6916],'Усть-Лабинск':[45.2166,39.6913],'Лабинск':[44.6339,40.7288],
  'Апшеронск':[44.4647,39.731],'Лиски':[50.9889,39.5142],'Борисоглебск':[51.3723,42.0806],
  'Острогожск':[50.8643,39.0695],'Россошь':[50.1972,39.5731],'Старый Оскол':[51.2974,37.8416],
  'Губкин':[51.2808,37.5372],'Алексеевка':[50.627,38.6973],'Мичуринск':[52.9,40.5],
  'Моршанск':[53.4281,41.8148],'Котовск':[52.5927,41.5023],'Уварово':[51.9853,42.2545],
  'Балаково':[51.9956,47.8026],'Вольск':[52.0469,47.3869],'Энгельс':[51.5009,46.1237],
  'Балашов':[51.5519,43.168],'Аткарск':[51.87,44.9905],'Орск':[51.229,58.4696],
  'Бузулук':[52.788,52.2576],'Бугуруслан':[53.654,52.431],'Бугульма':[54.5384,52.797],
  'Альметьевск':[54.9001,52.3019],'Курган':[55.4484,65.3391],'Шадринск':[56.0832,63.6326],
  'Миасс':[54.9881,60.1112],'Троицк':[54.0803,61.5669],'Копейск':[55.1177,61.6254],
  'Новотроицк':[51.2014,60.0821],'Бийск':[52.5408,85.2092],'Рубцовск':[51.5,81.2],
  'Ачинск':[56.2697,90.4996],'Абакан':[53.7209,91.4424],'Бердск':[54.7603,82.981],
  'Псков':[57.8194,28.332],'Великий Новгород':[58.5241,31.2699],'Вологда':[59.2181,39.8886],
  'Череповец':[59.1257,37.9059],'Ухта':[63.5593,53.6831],'Нижневартовск':[60.9347,76.5696],
  'Стерлитамак':[53.6254,55.9376],'Чебаркуль':[54.9849,60.3624],'Октябрьский':[54.4755,53.4671],
  'Туапсе':[44.1073,39.0815],'Новоалтайск':[53.3835,83.9412],'Заринск':[53.7019,84.9309],
  'Куйбышев':[55.4614,78.3239],'Северск':[56.6012,84.8802],'Искитим':[54.6325,83.3043],
  'Камышин':[50.0989,45.4018],'Михайловка':[50.0608,43.2436],'Урюпинск':[50.7957,42.0124],
  'Николаевск':[50.0235,45.4485],'Фролово':[49.7697,43.6629],'Новоаннинский':[50.5272,42.6822],
  'Серпухов':[54.9158,37.4167],'Подольск':[55.431,37.5444],'Коломна':[55.0833,38.7667],
  'Электросталь':[55.7935,38.4455],'Мытищи':[55.9135,37.7306],'Химки':[55.8883,37.4304],
  'Балашиха':[55.7959,37.9385],'Люберцы':[55.6792,37.8931],'Домодедово':[55.4406,37.7715],
  'Одинцово':[55.6728,37.2797],'Красногорск':[55.8244,37.3484],'Пушкино':[56.0146,37.8609],
  'Щёлково':[55.9183,38.0211],'Раменское':[55.5702,38.2294],'Орехово-Зуево':[55.8058,38.9844],
  'Ногинск':[55.8573,38.4396],'Воскресенск':[55.3246,38.6744],'Клин':[56.3348,36.7275],
  'Дмитров':[56.3441,37.5241],'Наро-Фоминск':[55.3896,36.7298],'Жуковский':[55.5975,38.1167],
  'Реутов':[55.7611,37.8619],'Королёв':[55.9226,37.8423],'Долгопрудный':[55.9383,37.5126],
  'Фрязево':[55.8711,38.2239],'Ивантеевка':[55.9747,37.922],'Видное':[55.5562,37.7022],
  'Дзержинск':[56.2346,43.4601],'Арзамас':[55.3897,43.8401],'Саров':[54.9267,35.8389],
  'Выкса':[55.3205,42.1735],'Кстово':[56.1451,44.1987],'Бор':[56.3594,44.0671],
  'Бузулук':[52.788,52.2576],'Соль-Илецк':[51.1587,55.0013],'Медногорск':[51.4082,57.5875],
  'Ртищево':[52.2639,43.7919],'Павловск':[50.4567,40.1318],'Новый Оскол':[50.7614,37.8784],
  'Валуйки':[50.2118,38.1061],'Бирюч':[50.6279,38.3988],'Обоянь':[51.2127,36.2725],
  'Льгов':[51.6674,35.2642],'Железногорск':[52.3353,35.3639],'Дмитриев':[52.1271,35.0813],
  'Рыльск':[51.5705,34.6845],'Суджа':[51.1911,35.2683],'Щигры':[51.8664,36.9012],
  'Фатеж':[52.0874,36.0624],'Конотоп':[51.2367,33.1988],'Путивль':[51.3344,33.8722],
  'Сумы':[50.9077,34.7981],'Харьков':[49.9808,36.2527],'Белгород-Днестровский':[46.1925,30.3478],
  'Семилуки':[51.6847,39.0264],'Иланский':[56.2397,96.0417],
  'Горняк':[50.9869,81.4556],'Ершов':[51.3628,48.2814],'Новокубанск':[45.1178,41.0333],
  'Тетюши':[54.9278,48.8408],'Гурьевск':[54.3019,85.9453],'Новопавловск':[43.9572,43.6253],
  'Мелеуз':[52.9608,55.9217],'Зарайск':[54.7653,38.8731],'Дигора':[43.1526,44.1597],
  'Красный Сулин':[47.8903,40.0731],'Ялта':[44.4980,34.1558],
  'Донецк':[48.0059,37.8028],'Луганск':[48.5740,39.3070],'Мариуполь':[47.0966,37.5494],
  'Макеевка':[47.9961,37.9603],'Горловка':[48.2954,37.9728],'Енакиево':[48.2306,38.1986],
  'Алчевск':[48.4757,38.7971],'Краснодон':[48.2898,39.7348],'Стаханов':[48.5586,38.6563],
  'Херсон':[46.6354,32.6169],'Скадовск':[46.1111,32.9111],'Геническ':[46.1694,34.8264],
  'Запорожье':[47.8388,35.1396],'Мелитополь':[46.8481,35.3617],'Энергодар':[47.5014,34.6553],
  'Бердянск':[46.7639,36.8058],'Токмак':[47.2667,35.7167],
};

// ── API Helper ────────────────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(State.token ? { 'Authorization': `Bearer ${State.token}` } : {}),
    ...opts.headers
  };

  const response = await fetch(path, { ...opts, headers });

  if (response.status === 401 && State.token) {
    const body = await response.json().catch(() => ({}));
    handleLogout();
    if (body.code === 'SESSION_INVALIDATED') {
      throw new Error('Выполнен вход с другого устройства. Войдите снова.');
    }
    throw new Error('Сессия истекла. Войдите снова.');
  }

  if (response.status === 403) {
    const error = await response.json().catch(() => ({}));
    if (error.code === 'SUBSCRIPTION_REQUIRED') {
      openModal('noAccessModal');
      throw new Error('SUBSCRIPTION_REQUIRED');
    }
    throw new Error(error.error || 'Доступ запрещён');
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Ошибка запроса');
  }

  return response.json();
}

// ── Auth ──────────────────────────────────────────────────────────────────
function switchAuthTab(tab) {
  document.getElementById('loginForm').style.display    = tab === 'login'    ? '' : 'none';
  document.getElementById('registerForm').style.display = tab === 'register' ? '' : 'none';
  document.getElementById('tabLogin').classList.toggle('active', tab === 'login');
  document.getElementById('tabRegister').classList.toggle('active', tab === 'register');
  document.getElementById('loginError').style.display    = 'none';
  document.getElementById('registerError').style.display = 'none';
}

const AUTH_ERRORS = {
  'Invalid credentials':            'Неверный логин или пароль',
  'Username and password are required': 'Заполните все поля',
  'Username already exists':        'Этот логин уже занят',
};
function authMsg(msg) { return AUTH_ERRORS[msg] || msg; }

async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPass').value;
  const errorEl  = document.getElementById('loginError');
  const btn      = document.getElementById('loginBtn');

  errorEl.style.display = 'none';
  btn.disabled = true;
  btn.textContent = 'Вход…';

  try {
    const data = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    State.token = data.token;
    State.user  = data.user;
    localStorage.setItem('fsa_token', data.token);
    localStorage.setItem('fsa_user', JSON.stringify(data.user));
    checkAuth();
  } catch (err) {
    errorEl.textContent   = authMsg(err.message);
    errorEl.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Войти';
  }
}

async function handleRegister(e) {
  e.preventDefault();
  const username  = document.getElementById('regUser').value.trim();
  const password  = document.getElementById('regPass').value;
  const password2 = document.getElementById('regPass2').value;
  const errorEl   = document.getElementById('registerError');
  const btn       = document.getElementById('registerBtn');

  errorEl.style.display = 'none';

  if (password !== password2) {
    errorEl.textContent   = 'Пароли не совпадают';
    errorEl.style.display = 'block';
    return;
  }
  if (password.length < 4) {
    errorEl.textContent   = 'Пароль должен содержать минимум 4 символа';
    errorEl.style.display = 'block';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Регистрация…';

  try {
    await apiFetch('/api/auth/register', { method: 'POST', body: JSON.stringify({ username, password }) });
    const data = await apiFetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    State.token = data.token;
    State.user  = data.user;
    localStorage.setItem('fsa_token', data.token);
    localStorage.setItem('fsa_user', JSON.stringify(data.user));
    checkAuth();
  } catch (err) {
    errorEl.textContent   = authMsg(err.message);
    errorEl.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Зарегистрироваться';
  }
}

function handleLogout() {
  State.token = null;
  State.user = null;
  localStorage.removeItem('fsa_token');
  localStorage.removeItem('fsa_user');
  checkAuth();
}

function checkAuth() {
  const loginPage = document.getElementById('pg-login');
  const appContainer = document.getElementById('app');

  if (!State.token) {
    loginPage.style.display = 'flex';
    appContainer.style.display = 'none';
  } else {
    loginPage.style.display = 'none';
    appContainer.style.display = 'block';
    initApp();
  }
}

// ── Navigation ────────────────────────────────────────────────────────────
function toggleSidebar() {
  const body = document.querySelector('.body');
  const btn  = document.getElementById('sidebarToggle');
  const collapsed = body.classList.toggle('sidebar-collapsed');
  document.getElementById('mainSidebar').classList.toggle('collapsed', collapsed);
  btn.textContent = collapsed ? '›' : '‹';
  try { localStorage.setItem('sidebarCollapsed', collapsed ? '1' : '0'); } catch(_) {}
}

function showPage(name) {
  document.getElementById('pg-registry').style.display  = name === 'registry'  ? '' : 'none';
  document.getElementById('pg-map').style.display       = name === 'map'       ? 'block' : 'none';
  document.getElementById('pg-favorites').className     = 'panel-page' + (name === 'favorites' ? ' active' : '');
  document.getElementById('pg-notes').className         = 'panel-page' + (name === 'notes'     ? ' active' : '');
  document.getElementById('pg-folders').className       = 'panel-page' + (name === 'folders'   ? ' active' : '');
  document.getElementById('pg-admin').className         = 'panel-page' + (name === 'admin'     ? ' active' : '');
  document.getElementById('pg-profile').className       = 'panel-page' + (name === 'profile'   ? ' active' : '');
  document.getElementById('pg-feedback').className      = 'panel-page' + (name === 'feedback'  ? ' active' : '');
  document.getElementById('pg-mydb').className          = 'panel-page' + (name === 'mydb'      ? ' active' : '');

  document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.page === name));

  if (name === 'map') {
    if (!State.mapInitialized) {
      State.mapInitialized = true;
      setTimeout(initMap, 150);
    } else if (State.mapInstance) {
      setTimeout(() => State.mapInstance.invalidateSize(), 50);
    }
  }

  if (name === 'favorites') loadFavorites();
  if (name === 'notes') loadNotes();
  if (name === 'folders') loadFolders();
  if (name === 'admin') loadAdminData();
  if (name === 'profile') loadProfile();
  if (name === 'feedback') loadFeedback();
  if (name === 'mydb') loadMydbPage();
}

// ── Registry ──────────────────────────────────────────────────────────────
let _tableLoadSeq = 0;
async function loadTable() {
  const seq = ++_tableLoadSeq;
  const tbody = document.getElementById('tblBody');
  if (!tbody.childElementCount) showSkeleton();

  try {
    const filters = getFilters();
    const data = await apiFetch('/api/declarations/producers' + buildQS(filters));
    if (seq !== _tableLoadSeq) return; // ответ устарел — пришёл более новый запрос
    renderTable(data);
  } catch (err) {
    if (seq === _tableLoadSeq) showAlert(err.message, 'err');
  }
}

function getFilters() {
  return {
    page: State.curPage,
    size: document.getElementById('pgSize').value || 20,
    search: document.getElementById('globalQ').value || '',
    dateFrom: document.getElementById('flDateF').value || '',
    dateTo: document.getElementById('flDateT').value || '',
    manufacturer: document.getElementById('csManuf').value || '',
    address: document.getElementById('csAddress').value || '',
    product: document.getElementById('csProduct').value || '',
    sortField: document.getElementById('sortF').value || 'regDate',
    sortDir: document.getElementById('sortD').value || 'desc',
    farmerType: State.curFarmerFilter
  };
}

function buildQS(p) {
  return '?' + Object.entries(p).filter(([,v]) => v !== '').map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

function applyFilters() {
  State.curPage = 0;
  loadTable();
}

let _applyFiltersDebounceTimer = null;
function applyFiltersDebounced() {
  clearTimeout(_applyFiltersDebounceTimer);
  _applyFiltersDebounceTimer = setTimeout(applyFilters, 400);
}

function clearColSearch() {
  ['csManuf','csAddress','csProduct'].forEach(id => document.getElementById(id).value = '');
  applyFilters();
}

function resetFilters() {
  ['flDateF','flDateT','globalQ'].forEach(id => document.getElementById(id).value = '');
  ['csManuf','csAddress','csProduct'].forEach(id => document.getElementById(id).value = '');
  State.curFarmerFilter = '';
  document.querySelectorAll('.ftf-btn').forEach(b => b.classList.toggle('act', b.dataset.ft === ''));
  applyFilters();
}

function setFarmerFilter(btn, val) {
  State.curFarmerFilter = val;
  document.querySelectorAll('.ftf-btn').forEach(b => b.classList.toggle('act', b === btn));
  State.curPage = 0;
  loadTable();
}

function showSkeleton() {
  const rows = Array(8).fill(0).map(() =>
    '<tr>' + [20,180,200,160,60].map(w =>
      `<td><span class="skel" style="width:${w*(.5+Math.random()*.5)|0}px;height:13px"> </span></td>`
    ).join('') + '</tr>'
  ).join('');
  document.getElementById('tblBody').innerHTML = rows;
}

function renderTable(data) {
  const { items, total, pages, page } = data;
  const tbody = document.getElementById('tblBody');

  // Запоминаем текущую страницу для навигации стрелками внутри карточки компании
  State.navItems = items || [];
  State.navIndex = -1;

  items.forEach(p => {
    const key = p.inn || p.name;
    if (key) State.producerDataCache.set(key, p);
  });

  document.getElementById('tblCount').textContent = (total || 0).toLocaleString('ru') + ' компаний';
  document.getElementById('pgNow').textContent = (page || 0) + 1;
  document.getElementById('pgOf').textContent  = pages || 1;
  document.getElementById('emptyState').style.display = total === 0 ? 'block' : 'none';

  const q = (document.getElementById('globalQ').value || '').trim();
  const _csManuf = (document.getElementById('csManuf').value || '').trim();
  const _csAddr  = (document.getElementById('csAddress').value || '').trim();
  const _csProd  = (document.getElementById('csProduct').value || '').trim();
  function hl(t, extra) {
    let s = t || '';
    const terms = [q, extra].filter(Boolean);
    terms.forEach(term => {
      s = s.replace(new RegExp('(' + term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + ')','gi'),
        '<mark style="background:#FEF3C7;border-radius:2px;padding:0 1px">$1</mark>');
    });
    return s;
  }

  const ftLabel = {
    farmer:        '<span class="ft ft-farmer">Производитель</span>',
    farmer_trader: '<span class="ft ft-farmer">Производитель/Трейдер</span>',
    trader:        '<span class="ft ft-trader">Трейдер</span>',
    trader_farmer: '<span class="ft ft-trader">Трейдер/Производитель</span>',
    unknown: ''
  };

  tbody.innerHTML = (items || []).map((p, idx) => {
    const hasMany = p.decls.length > 1;
    const firstProduct = (p.decls[0]?.productName || '—').slice(0, 60);
    const badge = ftLabel[p.farmerType] || '';
    const dormantBadge = p.dormant ? `<span class="ft" style="background:#F1F1F3;color:var(--muted)" title="Последняя декларация: ${p.lastDeclDate||'—'}">⏸ &gt;1.5 года без деклараций</span>` : '';
    const innHint = p.inn ? `<span style="font-size:10px;color:var(--muted);display:block">ИНН: ${p.inn}</span>` : '';
    const isFav = isFavorite(p.inn, p.name);
    const safeInn = (p.inn||'').replace(/'/g,"\\'");
    const safeName = (p.name||'').replace(/'/g,"\\'").replace(/"/g,'&quot;');

    const subRows = p.decls.map(d => `
      <tr class="decl-sub-row" id="sub_${page}_${idx}_${d.id}" style="display:none">
        <td></td>
        <td style="padding-left:20px;font-size:12px;color:var(--muted);white-space:nowrap">${d.regDate||'—'}</td>
        <td style="font-size:12px" title="${(d.productName||'').replace(/"/g,'&quot;')}">${hl(d.productName||'—', _csProd)}</td>
        <td style="font-size:12px;color:var(--muted)">${d.batchSize||'—'}</td>
        <td style="text-align:center;display:flex;align-items:center;justify-content:center;gap:3px">
          <button class="btn btn-sm" style="padding:2px 5px;font-size:11px" onclick="event.stopPropagation();addDeclToFolder('${d.id}','${(d.declNumber||'').replace(/'/g,"\\'").replace(/"/g,'&quot;')}')" title="В папку">📁</button>
          <button class="btn btn-sm" style="padding:2px 8px;font-size:11px" onclick="event.stopPropagation();openDetail('${d.id}')">↗</button>
        </td>
      </tr>`).join('');

    return `
      <tr class="producer-row" id="prod_${page}_${idx}" onclick="toggleProducer(${page},${idx},${p.decls.length})" style="cursor:${hasMany?'pointer':'default'}">
        <td style="text-align:center;color:var(--muted);font-size:11px;user-select:none" id="arr_${page}_${idx}">${hasMany?'▶':''}</td>
        <td title="${(p.name).replace(/"/g,'&quot;')}" style="font-weight:500">
          <span class="comp-name-link" onclick="event.stopPropagation();openCompany('${safeInn}','${safeName}')">${hl(p.name, _csManuf)}${badge}${dormantBadge}</span>${innHint}
        </td>
        <td title="${(p.address||'').replace(/"/g,'&quot;')}" style="font-size:12px;color:var(--muted)">${hl(p.address||'—', _csAddr)}</td>
        <td style="font-size:12px" title="${firstProduct}">${hl(firstProduct, _csProd)}${p.decls.length>1?' <span style="color:var(--muted)">+ещё '+(p.decls.length-1)+'</span>':''}</td>
        <td class="actions" style="text-align:center;display:flex;align-items:center;justify-content:center;gap:3px">
          <button class="star-btn ${isFav?'on':''}" onclick="event.stopPropagation();toggleFavorite('${safeInn}','${(p.name||'').replace(/'/g,"\\'").replace(/"/g,'&quot;')}',this)" title="${isFav?'Убрать из избранного':'Добавить в избранное'}">★</button>
          <button class="btn btn-sm" style="padding:2px 5px;font-size:12px" onclick="event.stopPropagation();addToFolder('${safeInn}','${(p.name||'').replace(/'/g,"\\'").replace(/"/g,'&quot;')}',this)" title="В папку">📁</button>
          ${p.decls.length === 1
            ? `<button class="btn btn-sm" style="padding:2px 7px;font-size:11px" onclick="event.stopPropagation();openDetail('${p.decls[0].id}')">↗</button>`
            : `<span style="background:var(--acl);color:var(--accent);padding:2px 8px;border-radius:12px;font-size:12px;font-weight:600">${p.decls.length}</span>`}
        </td>
      </tr>${subRows}`;
  }).join('');

  renderPagination(page || 0, pages || 1);
}

function toggleProducer(page, idx, count) {
  if (count <= 1) return;
  const arr = document.getElementById('arr_' + page + '_' + idx);
  const tbody = document.getElementById('tblBody');
  const allSubs = tbody.querySelectorAll(`[id^="sub_${page}_${idx}_"]`);
  const expanded = arr && arr.textContent === '▼';
  allSubs.forEach(r => r.style.display = expanded ? 'none' : '');
  if (arr) arr.textContent = expanded ? '▶' : '▼';
}

function renderPagination(page, pages) {
  const bar = document.getElementById('pgBar');
  if (pages <= 1) { bar.innerHTML = ''; return; }
  let h = `<button class="pg-btn" onclick="goPage(${page-1})" ${page===0?'disabled':''}>&lsaquo;</button>`;
  for (let p = 0; p < pages; p++) {
    if (p===0||p===pages-1||Math.abs(p-page)<=2)
      h += `<button class="pg-btn ${p===page?'act':''}" onclick="goPage(${p})">${p+1}</button>`;
    else if (Math.abs(p-page)===3)
      h += `<span style="padding:0 4px;color:var(--muted)">…</span>`;
  }
  h += `<button class="pg-btn" onclick="goPage(${page+1})" ${page===pages-1?'disabled':''}>&rsaquo;</button>`;
  bar.innerHTML = h;
}

function goPage(p) { State.curPage = p; loadTable(); }

// ── Status & Stats ────────────────────────────────────────────────────────
async function loadStats() {
  try {
    const s = await apiFetch('/api/system/stats');
    document.getElementById('stTotal').textContent  = (s.total || 0).toLocaleString('ru');
    document.getElementById('stTotalDecls').textContent = (s.totalDecls || 0).toLocaleString('ru') + ' деклараций';
    document.getElementById('stActive').textContent = (s.activeProducers || 0).toLocaleString('ru');
    document.getElementById('stActiveDecls').textContent = (s.active || 0).toLocaleString('ru') + ' деклараций';
    document.getElementById('stFarmers').textContent = (s.farmerProducers || 0).toLocaleString('ru');
    document.getElementById('stFarmerDecls').textContent = (s.farmerDecls || 0).toLocaleString('ru') + ' деклараций';
    document.getElementById('stTraders').textContent = (s.traderProducers || 0).toLocaleString('ru');
    document.getElementById('stTraderDecls').textContent = (s.traderDecls || 0).toLocaleString('ru') + ' деклараций';
    document.getElementById('sideTotalRec').textContent = (s.total || 0).toLocaleString('ru');
  } catch(_) {}
}

let _statusPollTimer = null;

async function pollStatus() {
  try {
    const s = await apiFetch('/api/system/status');
    const running = s.state === 'running';
    document.getElementById('stDot').className =
      'dot ' + (running ? 'dot-run' : s.state === 'error' ? 'dot-err' : 'dot-live');
    document.getElementById('stText').textContent = s.message || '—';
    const bar = document.getElementById('stBar');
    bar.style.width = running ? '60%' : '100%';
    bar.style.background = running ? 'var(--acm)' : s.state === 'error' ? 'var(--dng)' : 'var(--succ)';
    // "Обновлено" должно показывать время самого статуса (особенно важно при
    // ошибке — иначе видно лишь время последней записи в БД, что вводит в
    // заблуждение, будто ошибка "старая"), а не время последней правки данных.
    if (s.time) {
      const st = new Date(s.time);
      document.getElementById('stTime').textContent = 'Обновлено: ' + st.toLocaleString('ru-RU');
    }
    if (s.lastUpdated) {
      const d = new Date(s.lastUpdated);
      document.getElementById('sideLastUpd').textContent = d.toLocaleTimeString('ru-RU');
      document.getElementById('hdrStatus').textContent = d.toLocaleTimeString('ru-RU');
    }
    if (!running && s.lastUpdated !== State.lastUpdatedAt) {
      State.lastUpdatedAt = s.lastUpdated;
      await loadStats();
      await loadTable();
    }
    // Auto-poll faster while running, slower when idle
    clearTimeout(_statusPollTimer);
    _statusPollTimer = setTimeout(pollStatus, running ? 2000 : 15000);
  } catch(_) {
    clearTimeout(_statusPollTimer);
    _statusPollTimer = setTimeout(pollStatus, 10000);
  }
}

async function triggerParse() {
  try {
    const r = await apiFetch('/api/system/parse', { method: 'POST' });
    showAlert(r.message, r.ok ? 'ok' : 'warn');
  } catch(e) { showAlert('Ошибка: ' + e.message, 'err'); }
}

// ── Map ───────────────────────────────────────────────────────────────────
function getCityCoords(name) {
  if (!name) return null;
  if (CITY_COORDS[name]) return CITY_COORDS[name];
  const low = name.toLowerCase();
  const found = Object.keys(CITY_COORDS).find(k => k.toLowerCase() === low);
  return found ? CITY_COORDS[found] : null;
}

function markerColor(count) {
  if (count >= 200) return '#0C3B7A';
  if (count >= 51)  return '#185FA5';
  if (count >= 11)  return '#378ADD';
  return '#7DB9E8';
}

function markerColorByType(ft) {
  if (ft === 'farmer') return '#2d6a0f';
  if (ft === 'trader') return '#A32D2D';
  return '#378ADD';
}

async function initMap() {
  State.mapInstance = L.map('map', { zoomControl: true, preferCanvas: true, attributionControl: false }).setView([55, 55], 4);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
  }).addTo(State.mapInstance);

  setTimeout(() => State.mapInstance.invalidateSize(), 100);
  await loadMapData();
}

async function loadMapData(retry = 0) {
  const loaderEl = document.getElementById('mapLoader');
  loaderEl.innerHTML = 'Загрузка данных...';
  loaderEl.style.display = 'block';
  try {
    const data = await apiFetch('/api/declarations/map-data');
    State.mapAllCities = data.cities || [];
    renderMarkers(State.mapAllCities, data.total);
    loaderEl.style.display = 'none';
  } catch(e) {
    console.error('[map-data]', e.message);
    if (State.mapAllCities.length > 0) {
      loaderEl.style.display = 'none';
      return;
    }
    if (retry < 2) {
      loaderEl.innerHTML = `Загрузка данных... (${retry + 2}/3)`;
      setTimeout(() => loadMapData(retry + 1), 4000);
    } else {
      loaderEl.innerHTML = `Ошибка загрузки: ${e.message || 'нет ответа от сервера'} <button class="btn btn-sm" onclick="loadMapData()" style="margin-left:8px">Повторить</button>`;
    }
  }
}

function setMapFilter(btn, ft) {
  State.mapFilter = ft;
  document.querySelectorAll('.map-fc').forEach(b => {
    b.className = 'map-fc' + (b === btn ? (ft === 'farmer' ? ' farmer-act' : ft === 'trader' ? ' trader-act' : ' act') : '');
  });
  if (State.mapInstance) {
    State.mapInstance.eachLayer(l => { if (l instanceof L.CircleMarker) State.mapInstance.removeLayer(l); });
    const total = State.mapAllCities.reduce((s, c) => s + c.count, 0);
    renderMarkers(State.mapAllCities, total);
  }
}

function renderMarkers(cities, totalDecl) {
  let mapped = 0, unmapped = 0, mappedDecl = 0;

  for (const c of cities) {
    const coords = getCityCoords(c.city);
    if (!coords) { unmapped++; continue; }

    let orgs = c.orgs;
    let count = c.count;
    if (State.mapFilter === 'farmer') {
      orgs = orgs.filter(o => o.farmerType === 'farmer');
      count = c.farmers || orgs.reduce((s, o) => s + o.count, 0);
    } else if (State.mapFilter === 'trader') {
      orgs = orgs.filter(o => o.farmerType === 'trader');
      count = c.traders || orgs.reduce((s, o) => s + o.count, 0);
    }
    if (State.mapFilter && count === 0) continue;

    mapped++;
    mappedDecl += count;
    const r = Math.max(8, Math.min(40, 8 + Math.sqrt(count) * 2.8));
    const color = State.mapFilter ? markerColorByType(State.mapFilter) : markerColor(count);

    const marker = L.circleMarker(coords, {
      radius: r,
      fillColor: color,
      fillOpacity: 0.75,
      color: '#fff',
      weight: 2.5,
      interactive: true,
    }).addTo(State.mapInstance);

    marker.bindTooltip(`<b>${c.city}</b>: ${count} декл.`, { permanent: false, direction: 'top' });
    marker.bindPopup(buildMapPopup({ ...c, orgs, count }), { maxWidth: 320, className: 'map-popup' });
  }

  document.getElementById('mapCityCount').textContent = mapped;
  document.getElementById('mapDeclCount').textContent = mappedDecl.toLocaleString('ru');
  document.getElementById('mapUnknown').textContent = (totalDecl - mappedDecl).toLocaleString('ru');

  if (mapped === 0) document.getElementById('mapEmpty').style.display = 'block';
}

function buildMapPopup(c) {
  const orgsHtml = (c.orgs || []).map(o => {
    const declsHtml = (o.decls || []).map(d => {
      const label = escHtml(d.product || 'Декларация');
      const safeId = d.id.replace(/'/g, '');
      return `<div onclick="mapOpenDecl('${safeId}')" style="cursor:pointer;padding:3px 8px;margin:2px 0;border-radius:4px;font-size:11px;color:#185FA5;background:#eef4ff;line-height:1.4" onmouseover="this.style.background='#d9e8ff'" onmouseout="this.style.background='#eef4ff'">${label}</div>`;
    }).join('');
    return `
      <div style="padding:7px 0;border-bottom:1px solid #f0f2f5">
        <div style="font-size:13px;font-weight:600;color:#1a1e27;margin-bottom:4px;white-space:normal">${escHtml(o.name)} <span style="font-weight:400;color:#6b7280">${o.count > 1 ? '(' + o.count + ')' : ''}</span></div>
        ${declsHtml}
      </div>`;
  }).join('');
  return `
    <div style="font-family:'Segoe UI',system-ui,sans-serif;min-width:280px">
      <div style="font-size:16px;font-weight:700;margin-bottom:2px">${c.city}</div>
      <div style="font-size:12px;color:#6b7280;margin-bottom:10px;padding-bottom:10px;border-bottom:2px solid #185FA5">${c.count} деклараций</div>
      <div style="max-height:340px;overflow-y:auto;padding-right:2px">${orgsHtml}</div>
    </div>`;
}

function mapOpenDecl(id) {
  if (State.mapInstance) State.mapInstance.closePopup();
  openDetail(id);
}

// ── Favorites ─────────────────────────────────────────────────────────────
async function loadFavsCache() {
  try { State.favsCache = await apiFetch('/api/business/favorites'); } catch(_) { State.favsCache = []; }
}

function isFavorite(inn, name) {
  const key = inn || name;
  return State.favsCache.some(f => (f.inn || f.name) === key);
}

async function toggleFavorite(inn, name, btn) {
  const was = isFavorite(inn, name);
  try {
    if (was) {
      await apiFetch('/api/business/favorites', { method: 'DELETE', body: JSON.stringify({ inn, name }) });
    } else {
      await apiFetch('/api/business/favorites', { method: 'POST', body: JSON.stringify({ inn, name }) });
    }
    await loadFavsCache();
    if (btn) btn.classList.toggle('on', !was);
    showAlert(was ? 'Убрано из избранного' : 'Добавлено в избранное', 'ok');
    updateCompFavBtn(inn, name);
  } catch(e) { showAlert('Ошибка: ' + e.message, 'err'); }
}

async function loadFavorites() {
  await loadFavsCache();
  const list = State.favsCache;
  const el = document.getElementById('favList');
  const empty = document.getElementById('favEmpty');
  empty.style.display = list.length ? 'none' : 'block';
  el.innerHTML = list.map(f => {
    const safeInn = (f.inn||'').replace(/'/g,"\\'");
    const safeName = (f.name||'').replace(/'/g,"\\'").replace(/"/g,'&quot;');
    return `
    <div class="item-card">
      <span style="font-size:22px">⭐</span>
      <div class="item-card-info">
        <div class="item-card-name">${f.name||'—'}</div>
        <div class="item-card-sub">${f.inn ? 'ИНН: ' + f.inn + ' · ' : ''}Добавлено: ${f.addedAt ? new Date(f.addedAt).toLocaleDateString('ru-RU') : '—'}</div>
      </div>
      <button class="btn btn-sm" onclick="openCompany('${safeInn}','${safeName}')">→ Карточка</button>
      <button class="btn btn-dng btn-sm" onclick="removeFav('${safeInn}','${safeName}')">✕</button>
    </div>`;
  }).join('');
}

async function removeFav(inn, name) {
  await apiFetch('/api/business/favorites', { method: 'DELETE', body: JSON.stringify({ inn, name }) });
  await loadFavorites();
  showAlert('Убрано из избранного', 'ok');
}

// ── Folders ───────────────────────────────────────────────────────────────
async function loadFolders() {
  try { State.foldersCache = await apiFetch('/api/folders'); } catch(_) { State.foldersCache = []; }
  renderFolderGrid();
}

function renderFolderGrid() {
  cancelFolderCreate();
  State.curFolderOpen = null;
  State.folderBreadcrumb = [];
  const grid = document.getElementById('folderGrid');
  const empty = document.getElementById('foldersEmpty');
  document.getElementById('folderContent').style.display = 'none';
  grid.style.display = '';
  document.getElementById('folderCreateBtn').textContent = '+ Новая папка';
  const topLevel = State.foldersCache.filter(f => !f.parentId);
  empty.style.display = topLevel.length ? 'none' : 'block';
  grid.innerHTML = topLevel.map(f => {
    const childCount = State.foldersCache.filter(c => c.parentId === f.id).length;
    const total = (f.items?.length || 0) + childCount;
    return `
    <div class="folder-card" onclick="openFolder('${f.id}')">
      <div style="font-size:28px;margin-bottom:6px">📁</div>
      <div class="folder-card-name">${f.name}</div>
      <div class="folder-card-count">${total} элем.</div>
      <button class="folder-del" onclick="event.stopPropagation();deleteFolder('${f.id}')" title="Удалить папку">✕</button>
    </div>`;
  }).join('');
}

function openFolder(id, push = true) {
  const folder = State.foldersCache.find(f => f.id === id);
  if (!folder) return;
  if (push) State.folderBreadcrumb.push({ id, name: folder.name });

  State.curFolderOpen = id;
  document.getElementById('folderGrid').style.display = 'none';
  document.getElementById('foldersEmpty').style.display = 'none';
  document.getElementById('folderContent').style.display = 'block';
  document.getElementById('folderCreateBtn').textContent = '+ Подпапка';
  renderFolderBreadcrumb();

  const children = State.foldersCache.filter(f => f.parentId === id);
  const subGrid = document.getElementById('subFolderGrid');
  subGrid.style.display = children.length ? '' : 'none';
  subGrid.innerHTML = children.map(c => `
    <div class="folder-card" onclick="openFolder('${c.id}')">
      <div style="font-size:28px;margin-bottom:6px">📁</div>
      <div class="folder-card-name">${c.name}</div>
      <div class="folder-card-count">${c.items?.length || 0} элем.</div>
      <button class="folder-del" onclick="event.stopPropagation();deleteFolder('${c.id}')" title="Удалить папку">✕</button>
    </div>`).join('');

  renderFolderItems(id, folder.items || []);
}

function renderFolderBreadcrumb() {
  const el = document.getElementById('folderBreadcrumbEl');
  const parts = [`<button class="btn btn-sm" style="font-size:12px;padding:3px 8px" onclick="renderFolderGrid()">📁 Все папки</button>`];
  State.folderBreadcrumb.forEach((crumb, i) => {
    parts.push(`<span class="breadcrumb-sep">›</span>`);
    if (i < State.folderBreadcrumb.length - 1) {
      parts.push(`<button class="btn btn-sm" style="font-size:12px;padding:3px 8px" onclick="navBreadcrumb(${i})">${crumb.name}</button>`);
    } else {
      parts.push(`<span style="font-weight:600;font-size:13px">${crumb.name}</span>`);
    }
  });
  el.innerHTML = parts.join('');
}

function navBreadcrumb(idx) {
  State.folderBreadcrumb = State.folderBreadcrumb.slice(0, idx + 1);
  openFolder(State.folderBreadcrumb[idx].id, false);
}

function renderFolderItems(id, items) {
  const emptyEl = document.getElementById('folderItemsEmpty');
  const listEl = document.getElementById('folderItems');
  emptyEl.style.display = items.length ? 'none' : 'block';
  listEl.innerHTML = items.map(item => {
    const safeVal = (item.value||'').replace(/'/g,"\\'").replace(/"/g,'&quot;');
    const isInn = item.type === 'inn';
    const isDecl = item.type === 'decl';
    const icon = isInn ? '🏢' : '📄';
    const displayName = escHtml(item.label || item.value);
    return `
    <div class="item-card">
      <span style="font-size:18px">${icon}</span>
      <div class="item-card-info">
        <div class="item-card-name">${displayName}</div>
        <div class="item-card-sub">${isInn ? 'Компания' : (isDecl ? 'Декларация' : 'Компания (название)')}</div>
      </div>
      ${isInn ? `<button class="btn btn-sm" onclick="openCompany('${safeVal}','')">→ Карточка</button>` : ''}
      ${isDecl ? `<button class="btn btn-sm" onclick="openDetail('${safeVal}')">↗ Открыть</button>` : ''}
      <button class="btn btn-dng btn-sm" onclick="removeFolderItem('${id}','${item.type}','${safeVal}')">✕</button>
    </div>`;
  }).join('');
}

function openFolderCreate() {
  const form = document.getElementById('folderCreateForm');
  const btn = document.getElementById('folderCreateBtn');
  form.style.display = 'flex';
  btn.style.display = 'none';
  const inp = document.getElementById('folderCreateInput');
  inp.value = '';
  inp.placeholder = State.curFolderOpen ? 'Название подпапки…' : 'Название папки…';
  inp.focus();
}

function cancelFolderCreate() {
  document.getElementById('folderCreateForm').style.display = 'none';
  document.getElementById('folderCreateBtn').style.display = '';
}

async function submitFolderCreate() {
  const name = document.getElementById('folderCreateInput').value.trim();
  if (!name) { document.getElementById('folderCreateInput').focus(); return; }
  try {
    const body = { name };
    if (State.curFolderOpen) body.parentId = State.curFolderOpen;
    await apiFetch('/api/folders', { method: 'POST', body: JSON.stringify(body) });
    cancelFolderCreate();
    await loadFolders();
    if (State.curFolderOpen) openFolder(State.curFolderOpen, false);
  } catch(e) { showAlert(e.message, 'err'); }
}

// оставляем для обратной совместимости (вызывается из renderFolderGrid)
async function createFolderCtx() { openFolderCreate(); }

async function deleteFolder(id) {
  if (!confirm('Удалить папку?')) return;
  try {
    await apiFetch('/api/folders/' + id, { method: 'DELETE' });
    await loadFolders();
  } catch(e) { showAlert(e.message, 'err'); }
}

async function removeFolderItem(folderId, type, value) {
  await apiFetch('/api/folders/' + folderId + '/items', { method: 'DELETE', body: JSON.stringify({ type, value }) });
  await loadFolders();
  openFolder(folderId, false);
}

// ── Модалка "В папку" ─────────────────────────────────────────────────────
let _atfPending = null; // { type, value, label }

async function addToFolder(inn, name, _btn) {
  if (!State.foldersCache.length) await loadFolders();
  _atfPending = { type: inn ? 'inn' : 'name', value: inn || name, label: name || inn };
  document.getElementById('atfItemLabel').textContent = name || inn || '';
  document.getElementById('atfNewName').value = '';
  document.getElementById('atfSearch').value = '';
  atfRenderList();
  openModal('addToFolderModal');
}

async function addDeclToFolder(id, declNumber) {
  if (!State.foldersCache.length) await loadFolders();
  _atfPending = { type: 'decl', value: id, label: declNumber || id };
  document.getElementById('atfItemLabel').textContent = declNumber || id;
  document.getElementById('atfNewName').value = '';
  document.getElementById('atfSearch').value = '';
  atfRenderList();
  openModal('addToFolderModal');
}

function atfRenderList() {
  const q = (document.getElementById('atfSearch').value || '').trim().toLowerCase();
  const folders = State.foldersCache.filter(f => !q || f.name.toLowerCase().includes(q));
  const list = document.getElementById('atfFolderList');
  const empty = document.getElementById('atfEmpty');
  if (!folders.length) {
    list.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  list.innerHTML = folders.map(f => {
    const count = (f.items || []).length;
    return `<div onclick="atfPickFolder('${f.id}')" style="display:flex;align-items:center;gap:10px;padding:9px 12px;border:1px solid var(--border);border-radius:var(--r);cursor:pointer;background:var(--surface);transition:background .12s" onmouseover="this.style.background='var(--acl)'" onmouseout="this.style.background='var(--surface)'">
      <span style="font-size:20px">📁</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(f.name)}</div>
        <div style="font-size:11px;color:var(--muted)">${count} элем.</div>
      </div>
    </div>`;
  }).join('');
}

async function atfPickFolder(folderId) {
  if (!_atfPending) return;
  try {
    await apiFetch('/api/folders/' + folderId + '/items', {
      method: 'POST', body: JSON.stringify(_atfPending)
    });
    closeModal('addToFolderModal');
    showAlert('Добавлено в папку');
    loadFolders();
  } catch(e) { showAlert(e.message, 'err'); }
}

async function atfCreateAndAdd() {
  const name = document.getElementById('atfNewName').value.trim();
  if (!name) { document.getElementById('atfNewName').focus(); return; }
  try {
    const folder = await apiFetch('/api/folders', { method: 'POST', body: JSON.stringify({ name }) });
    await loadFolders();
    if (_atfPending) {
      await apiFetch('/api/folders/' + folder.id + '/items', {
        method: 'POST', body: JSON.stringify(_atfPending)
      });
    }
    closeModal('addToFolderModal');
    showAlert('Папка создана и добавлено');
  } catch(e) { showAlert(e.message, 'err'); }
}

// ── Навигация по производителям и декларациям ─────────────────────────────
function navProducer(delta) {
  const next = State.navIndex + delta;
  if (next < 0 || next >= State.navItems.length) return;
  const p = State.navItems[next];
  openCompany(p.inn, p.name);
}

function navDecl(delta) {
  const next = State.navDeclIndex + delta;
  if (next < 0 || next >= State.navDeclIds.length) return;
  State.navDeclIndex = next;
  openDetail(State.navDeclIds[next], true);
}

function _updateCompNavButtons() {
  const prev = document.getElementById('compNavPrev');
  const next = document.getElementById('compNavNext');
  const pos  = document.getElementById('compNavPos');
  if (!prev) return;
  prev.disabled = State.navIndex <= 0;
  next.disabled = State.navIndex < 0 || State.navIndex >= State.navItems.length - 1;
  if (pos && State.navIndex >= 0)
    pos.textContent = `${State.navIndex + 1} / ${State.navItems.length}`;
}

function _updateDeclNavButtons() {
  const prev = document.getElementById('declNavPrev');
  const next = document.getElementById('declNavNext');
  const pos  = document.getElementById('declNavPos');
  if (!prev) return;
  prev.disabled = State.navDeclIndex <= 0;
  next.disabled = State.navDeclIndex < 0 || State.navDeclIndex >= State.navDeclIds.length - 1;
  if (pos && State.navDeclIndex >= 0)
    pos.textContent = `${State.navDeclIndex + 1} / ${State.navDeclIds.length}`;
}

// Глобальный обработчик стрелок: работает пока открыта соответствующая модалка
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const compOpen = document.getElementById('compModal')?.classList.contains('open');
  const detOpen  = document.getElementById('detModal')?.classList.contains('open');
  if (e.key === 'ArrowLeft')  { if (detOpen) navDecl(-1); else if (compOpen) navProducer(-1); }
  if (e.key === 'ArrowRight') { if (detOpen) navDecl(+1); else if (compOpen) navProducer(+1); }
});

// ── Company Card ──────────────────────────────────────────────────────────
async function openCompany(inn, name) {
  // Запоминаем позицию в списке
  const idx = State.navItems.findIndex(p => (inn && p.inn && p.inn === inn) || p.name === name);
  State.navIndex = idx;
  // Сбрасываем навигацию по декларациям (откроем при клике на конкретную)
  State.navDeclIds = [];
  State.navDeclIndex = -1;

  const key = inn || name;
  document.getElementById('compModalName').textContent = name || inn || 'Загрузка...';
  document.getElementById('compModalSub').textContent = inn ? 'ИНН: ' + inn + '  Загрузка...' : 'Загрузка...';
  document.getElementById('compModalBody').innerHTML = '<div style="color:var(--muted);padding:20px 0;text-align:center">Загрузка данных...</div>';
  document.getElementById('compModalFoot').innerHTML = '';
  openModal('compModal');

  let p;
  try {
    const qs = inn ? '?inn=' + encodeURIComponent(inn) : '?name=' + encodeURIComponent(name);
    p = await apiFetch('/api/business/company' + qs);
  } catch(e) {
    p = State.producerDataCache.get(key) || null;
    if (!p) { document.getElementById('compModalBody').innerHTML = '<div class="empty"><p>Не удалось загрузить данные</p></div>'; return; }
    p = { found: true, inn: p.inn||'', name: p.name||name, address: p.address||'', phone: p.phone||'',
           farmerType: p.farmerType||'unknown', okved: p.okved||'', notes: '', description: '', contacts: [], decls: p.decls||[] };
  }

  document.getElementById('compModalName').textContent = p.name || name || '—';
  document.getElementById('compModalSub').innerHTML = [
    p.inn  ? 'ИНН: <b>' + p.inn + '</b>'   : '',
    p.companyRegDate ? 'Зарегистрирована: <b>' + p.companyRegDate + '</b>' : '',
    p.dormant ? `<span style="color:var(--warn)">⏸ &gt;1.5 года без деклараций (с ${p.lastDeclDate||'—'})</span>` : '',
  ].filter(Boolean).join(' &nbsp;·&nbsp; ');

  State.curCompDecls = p.decls || [];
  State.curCompContacts = p.contacts || [];
  State.curCropTab = 'all';

  const fioStr = [p.lastName, p.firstName, p.middleName].filter(Boolean).join(' ');
  const applicantHtml = (p.applicantName && p.applicantName !== p.name)
    ? `<div class="df full"><div class="df-l">Заявитель</div><div class="df-v" style="font-size:12px">${p.applicantName}</div></div>` : '';
  const safeDesc  = (p.description||'').replace(/</g,'&lt;').replace(/"/g,'&quot;');
  const safeInn   = (p.inn||'').replace(/'/g,"\\'");
  const safeName  = (p.name||name||'').replace(/'/g,"\\'").replace(/"/g,'&quot;');

  const autoNoteHtml = p.autoNote
    ? `<div style="padding:7px 12px;background:#FEF3C7;border:1px solid #F2D272;border-radius:var(--r);font-size:12px;color:#7A5B00;margin-bottom:8px">⚠ ${(p.autoNote||'').replace(/</g,'&lt;')}</div>`
    : '';

  document.getElementById('compModalBody').innerHTML = `
    <div id="compDescArea" style="margin-bottom:14px">
      ${autoNoteHtml}
      <div id="compDescShow" style="cursor:pointer;padding:8px 12px;background:var(--surf2);border-radius:var(--r);border:1px solid var(--border);font-size:13px;color:${p.description?'var(--text)':'var(--muted)'}" onclick="editCompDesc()" title="Нажмите для редактирования">${p.description ? safeDesc : '+ Добавить описание компании...'}</div>
      <div id="compDescEdit" style="display:none">
        <input id="compDescInput" type="text" class="fi" placeholder="Краткое описание компании..." value="${safeDesc}">
        <div style="display:flex;gap:6px;margin-top:6px">
          <button class="btn btn-sm btn-p" onclick="saveCompanyDesc('${safeInn}','${safeName}')">💾 Сохранить</button>
          <button class="btn btn-sm" onclick="cancelCompDesc()">Отмена</button>
        </div>
      </div>
    </div>
    <div class="dg" style="margin-bottom:18px;gap:10px 20px">
      <div class="df"><div class="df-l">Телефон</div><div class="df-v">${p.phone || p.ebPhone || '—'}</div></div>
      ${(p.ebCeoName && !fioStr) ? `<div class="df full"><div class="df-l">Директор</div><div class="df-v">${escHtml(p.ebCeoName)}</div></div>` : ''}
      ${fioStr ? `<div class="df full"><div class="df-l">ФИО</div><div class="df-v">${fioStr}</div></div>` : ''}
      ${applicantHtml}
      ${p.ebEmail ? `<div class="df full"><div class="df-l">Email</div><div class="df-v" style="font-size:12px">${escHtml(p.ebEmail)}</div></div>` : ''}
      ${p.ebWebsite ? `<div class="df"><div class="df-l">Сайт</div><div class="df-v"><a href="https://${escHtml(p.ebWebsite)}" target="_blank">${escHtml(p.ebWebsite)}</a></div></div>` : ''}
      ${p.ebRevenue ? `<div class="df"><div class="df-l">Выручка</div><div class="df-v">${escHtml(p.ebRevenue)} тыс. ₽</div></div>` : ''}
      ${p.address ? `<div class="df full"><div class="df-l">Адрес</div><div class="df-v" style="font-size:12px">${p.address}</div></div>` : ''}
    </div>
    <div id="compUserContacts"></div>
    <div class="dsec">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap">
        <h4 style="margin:0">Декларации (${(p.decls||[]).length})</h4>
        <select id="compPeriodSel" onchange="updateCropTabs()" style="font-size:12px;padding:3px 7px;border:1px solid var(--border);border-radius:var(--r);background:var(--surface);cursor:pointer">
          <option value="0">Текущий год</option>
          <option value="1">Прошлый год</option>
          <option value="2">2 года назад</option>
          <option value="all" selected>Всё время</option>
        </select>
      </div>
      <div class="tab-strip" id="cropTabStrip"></div>
      <div id="cropTabContent"></div>
    </div>
    <div class="dsec" style="margin-top:16px">
      <h4>Контакты</h4>
      <div id="compContactsList"></div>
      <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
        <input id="ccName" class="fi" style="flex:1;min-width:110px" placeholder="Имя">
        <input id="ccRole" class="fi" style="flex:1;min-width:110px" placeholder="Должность/отдел">
        <input id="ccPhone" class="fi" style="flex:1;min-width:130px" placeholder="Телефон">
        <input id="ccComment" class="fi" style="flex:1;min-width:130px" placeholder="Комментарий">
        <button class="btn btn-sm btn-p" onclick="addCompContact('${safeInn}','${safeName}')">+ Добавить</button>
      </div>
    </div>
    <div class="dsec" style="margin-top:16px">
      <h4>Заметки</h4>
      <textarea id="compNotes" class="fi" style="width:100%;min-height:70px;resize:vertical" placeholder="Заметки о компании...">${(p.notes||'').replace(/</g,'&lt;')}</textarea>
      <button class="btn btn-sm" style="margin-top:6px" onclick="saveCompanyNotes('${safeInn}','${safeName}')">💾 Сохранить заметку</button>
    </div>`;

  renderCompContacts();
  updateCropTabs();
  loadUserContactsForCard(p.inn, p.name || name);

  const isFav = isFavorite(p.inn, p.name || name);
  const compLabel = (p.name || name || inn || '').replace(/'/g,"\\'").replace(/"/g,'&quot;');
  const compInnHint = p.inn ? ` (ИНН ${p.inn})` : '';
  const hasNav = State.navItems.length > 1;
  document.getElementById('compModalFoot').innerHTML = `
    <div style="width:100%;display:flex;flex-direction:column;gap:10px">
      ${hasNav ? `<div style="display:flex;align-items:center;justify-content:center;gap:6px;padding-bottom:6px;border-bottom:1px solid var(--border)">
        <button class="btn btn-sm" id="compNavPrev" onclick="navProducer(-1)" style="min-width:90px">‹ Предыд.</button>
        <span id="compNavPos" style="font-size:12px;color:var(--muted);min-width:56px;text-align:center;font-weight:600"></span>
        <button class="btn btn-sm" id="compNavNext" onclick="navProducer(+1)" style="min-width:90px">Следующ. ›</button>
      </div>` : ''}
      <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
        <button class="btn btn-sm" id="compFavBtn" onclick="toggleFavorite('${safeInn}','${safeName}',null);updateCompFavBtn('${safeInn}','${safeName}')">${isFav?'★ В избранном':'☆ В избранное'}</button>
        <button class="btn btn-sm" onclick="addToFolder('${safeInn}','${safeName}')">📁 В папку</button>
        <button class="btn btn-sm" onclick="openAddToNoteModal('${compLabel}${compInnHint.replace(/'/g,"\\'")}','')">📝 В заметку</button>
        <button class="btn btn-p btn-sm" onclick="closeModal('compModal')">Закрыть</button>
      </div>
    </div>`;
  _updateCompNavButtons();
}

function updateCompFavBtn(inn, name) {
  const btn = document.getElementById('compFavBtn');
  if (!btn) return;
  const isFav = isFavorite(inn, name);
  btn.textContent = isFav ? '★ В избранном' : '☆ В избранное';
}

function editCompDesc() {
  document.getElementById('compDescShow').style.display = 'none';
  document.getElementById('compDescEdit').style.display = 'block';
  document.getElementById('compDescInput').focus();
}

function cancelCompDesc() {
  document.getElementById('compDescEdit').style.display = 'none';
  document.getElementById('compDescShow').style.display = '';
}

async function saveCompanyDesc(inn, name) {
  const desc = document.getElementById('compDescInput').value.trim();
  try {
    await apiFetch('/api/business/company/notes', { method: 'PUT', body: JSON.stringify({ inn, name, description: desc }) });
    closeModal('compModal');
    showAlert('Сохранено');
  } catch(e) { showAlert(e.message, 'err'); }
}

function renderCompContacts() {
  const el = document.getElementById('compContactsList');
  if (!el) return;
  const contacts = State.curCompContacts || [];
  if (!contacts.length) {
    el.innerHTML = '<div style="color:var(--muted);font-size:12px">Контактов пока нет</div>';
    return;
  }
  el.innerHTML = contacts.map(c => `
    <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px">
      <div style="flex:1;min-width:0">
        <b>${escHtml(c.name||'—')}</b>${c.role ? ' · ' + escHtml(c.role) : ''}
        ${c.phone ? `<div style="color:var(--text)">${escHtml(c.phone)}</div>` : ''}
        ${c.comment ? `<div style="color:var(--muted);font-size:12px">${escHtml(c.comment)}</div>` : ''}
      </div>
      <button class="btn btn-sm" onclick="deleteCompContact(${c.id})" title="Удалить">✕</button>
    </div>`).join('');
}

async function addCompContact(inn, name) {
  const contactName = document.getElementById('ccName').value.trim();
  const role = document.getElementById('ccRole').value.trim();
  const phone = document.getElementById('ccPhone').value.trim();
  const comment = document.getElementById('ccComment').value.trim();
  if (!contactName && !phone) { showAlert('Укажите имя или телефон', 'err'); return; }
  try {
    const created = await apiFetch('/api/business/company/contacts', {
      method: 'POST',
      body: JSON.stringify({ inn, name, contactName, role, phone, comment })
    });
    State.curCompContacts.unshift(created);
    renderCompContacts();
    ['ccName','ccRole','ccPhone','ccComment'].forEach(id => document.getElementById(id).value = '');
  } catch(e) { showAlert(e.message, 'err'); }
}

async function deleteCompContact(id) {
  try {
    await apiFetch('/api/business/company/contacts/' + id, { method: 'DELETE' });
    State.curCompContacts = (State.curCompContacts || []).filter(c => c.id !== id);
    renderCompContacts();
  } catch(e) { showAlert(e.message, 'err'); }
}



async function saveCompanyNotes(inn, name) {
  const notes = document.getElementById('compNotes').value;
  try {
    await apiFetch('/api/business/company/notes', { method: 'PUT', body: JSON.stringify({ inn, name, notes }) });
    showAlert('Сохранено');
  } catch(e) { showAlert(e.message, 'err'); }
}

// ── Crop Classification ───────────────────────────────────────────────────
// Порядок важен: первое совпадение выигрывает.
// Пшеница твёрдая проверяется ДО мягкой — всё что не твёрдая = мягкая.
const CROPS = [
  // ── Зерновые ────────────────────────────────────────────────────────────
  { key:'пшеница-твердая', label:'Пшеница твёрдая (дурум)',
    re:/тв[её]рд[а-я\s]*пшениц|пшениц[а-я\s]*тв[её]рд|дурум|durum/i,        ys:{m:5,d:25} },
  { key:'пшеница-мягкая',  label:'Пшеница мягкая',
    re:/пшениц/i,                                                              ys:{m:5,d:25} },
  { key:'ячмень',          label:'Ячмень',           re:/ячмен/i,             ys:{m:5,d:25} },
  { key:'рожь',            label:'Рожь',             re:/рожь|ржи|ржан/i,     ys:{m:5,d:25} },
  { key:'тритикале',       label:'Тритикале',        re:/тритикал/i,          ys:{m:5,d:25} },
  { key:'овёс',            label:'Овёс',             re:/овёс|овса|овсян/i,   ys:{m:7,d:1}  },
  { key:'гречиха',         label:'Гречиха',          re:/гречих/i,            ys:{m:8,d:1}  },
  { key:'рис',             label:'Рис',              re:/(?<![а-яёА-ЯЁ])рис(?:[аое]|ов|[^а-яёА-ЯЁa-zA-Z]|$)/i, ys:{m:10,d:1} },
  { key:'просо',           label:'Просо',            re:/просо|проса/i,        ys:{m:9,d:1}  },
  { key:'сорго',           label:'Сорго',            re:/сорго/i,             ys:{m:9,d:1}  },
  { key:'кукуруза',        label:'Кукуруза',         re:/кукуруз/i,           ys:{m:10,d:1} },
  // ── Масличные ───────────────────────────────────────────────────────────
  { key:'подсолнечник',    label:'Подсолнечник',     re:/подсолнеч/i,         ys:{m:9,d:1}  },
  { key:'соя',             label:'Соя',              re:/соя|сои|соев/i,      ys:{m:9,d:1}  },
  { key:'рапс',            label:'Рапс',             re:/рапс/i,              ys:{m:7,d:1}  },
  { key:'лён-семена',      label:'Семена льна',      re:/семен[а-я\s]*льн|льн[а-я\s]*семен|льносемен|масличн[а-я\s]*лён/i, ys:{m:8,d:1} },
  { key:'лён',             label:'Лён (общее)',      re:/лён|льна|льно/i,     ys:{m:8,d:1}  },
  { key:'горчица',         label:'Горчица',          re:/горчиц/i,            ys:{m:7,d:1}  },
  { key:'кунжут',          label:'Кунжут',           re:/кунжут|sesam/i,      ys:{m:9,d:1}  },
  { key:'арахис',          label:'Арахис',           re:/арахис/i,            ys:{m:9,d:1}  },
  { key:'сафлор',          label:'Сафлор',           re:/сафлор/i,            ys:{m:9,d:1}  },
  { key:'хлопчатник',      label:'Хлопчатник',       re:/хлопчатник|хлопок|хлопков/i, ys:{m:10,d:1} },
  // ── Зернобобовые ────────────────────────────────────────────────────────
  { key:'горох',           label:'Горох',            re:/горох/i,             ys:{m:7,d:1}  },
  { key:'фасоль',          label:'Фасоль',           re:/фасол/i,             ys:{m:9,d:1}  },
  { key:'нут',             label:'Нут',              re:/нут(?:[аов]|$|\s|,)/i, ys:{m:7,d:1}  },
  { key:'чечевица',        label:'Чечевица',         re:/чечевиц/i,           ys:{m:7,d:1}  },
  { key:'маш',             label:'Маш',              re:/(?<![а-яё])маш(?![а-яё])/i, ys:{m:8,d:1}  },
  { key:'чина',            label:'Чина',             re:/(?<![а-яё])чин[аыу]/i, ys:{m:7,d:1}  },
  { key:'люпин',           label:'Люпин',            re:/люпин/i,             ys:{m:7,d:1}  },
  { key:'вика',            label:'Вика',             re:/вика|вики|виков/i,   ys:{m:7,d:1}  },
];
const CROP_OTHER = { key:'прочее', label:'Прочее', ys:{m:1,d:1} };

function classifyProd(name) {
  for (const c of CROPS) if (c.re.test(name||'')) return c;
  return CROP_OTHER;
}

function parseTon(s) {
  if (!s) return 0;
  const str = String(s).replace(/\s/g,'').toLowerCase();
  const n = parseFloat(str.replace(',','.'));
  if (isNaN(n) || n <= 0) return 0;
  if (/цент|^\d+ц[^и]/.test(str)) return n / 10;
  if (/кг|кило/.test(str)) return n / 1000;
  return n;
}

function fmtTon(t) {
  if (!t) return '—';
  if (t >= 1000000) return (t / 1000000).toFixed(2) + ' млн т';
  if (t >= 1000)    return (t / 1000).toFixed(1) + ' тыс.т';
  return Math.round(t).toLocaleString('ru') + ' т';
}

function harvestYearOf(regDate, ys) {
  const date = new Date(regDate);
  const cut = new Date(date.getFullYear(), ys.m - 1, ys.d);
  return date >= cut ? date.getFullYear() : date.getFullYear() - 1;
}

// Среднее за год урожая: сумма объёма за каждый год / кол-во лет, в которых
// реально есть декларации (года без деклараций не размывают среднее вниз).
function computeYearlyAverage(decls, ys) {
  const yearTotals = new Map();
  for (const d of decls) {
    if (!d.regDate) continue;
    const year = harvestYearOf(d.regDate, ys);
    yearTotals.set(year, (yearTotals.get(year) || 0) + parseTon(d.batchSize));
  }
  const years = [...yearTotals.keys()].sort((a, b) => b - a);
  const totalSum = [...yearTotals.values()].reduce((a, b) => a + b, 0);
  return { avg: years.length ? totalSum / years.length : 0, years };
}

function getCropYearRange(ys, yearsAgo = 0) {
  const now = new Date();
  const cut = new Date(now.getFullYear(), ys.m - 1, ys.d);
  const base = now >= cut ? now.getFullYear() : now.getFullYear() - 1;
  const y = base - yearsAgo;
  const p2 = n => String(n).padStart(2, '0');
  return { from: `${y}-${p2(ys.m)}-${p2(ys.d)}`, to: `${y+1}-${p2(ys.m)}-${p2(ys.d)}` };
}

function updateCropTabs() {
  const periodEl = document.getElementById('compPeriodSel');
  if (!periodEl) return;
  const period = periodEl.value;

  const groups = new Map();
  groups.set('all', { crop: { key:'all', label:'Все', ys:{m:1,d:1} }, decls: [...State.curCompDecls] });
  for (const d of State.curCompDecls) {
    const c = classifyProd(d.productName);
    if (!groups.has(c.key)) groups.set(c.key, { crop: c, decls: [] });
    groups.get(c.key).decls.push(d);
  }

  function filterPeriod(decls, ys) {
    if (period === 'all') return decls;
    const r = getCropYearRange(ys, parseInt(period) || 0);
    return decls.filter(d => d.regDate >= r.from && d.regDate < r.to);
  }

  const strip = document.getElementById('cropTabStrip');
  if (!strip) return;
  const tabs = [];
  for (const [key, g] of groups) {
    const fd = filterPeriod(g.decls, g.crop.ys);
    const ton = fd.reduce((s, d) => s + parseTon(d.batchSize), 0);
    const badge = ton > 0 ? fmtTon(ton) : String(fd.length);
    tabs.push({ key, label: g.crop.label, badge, hasData: g.decls.length > 0 });
  }
  const showAll = groups.size > 2;
  strip.innerHTML = tabs
    .filter(t => t.key === 'all' ? showAll : t.hasData)
    .map(t => `<button class="tab-btn${State.curCropTab === t.key ? ' active' : ''}" onclick="selectCropTab('${t.key}')">${t.label}<span class="tab-badge">${t.badge}</span></button>`)
    .join('');

  const g = groups.get(State.curCropTab) || groups.get('all');
  if (!g) return;

  // Подписи периодов считаем по сезону урожая именно выбранной культуры
  // (у разных культур разные границы года — пшеница с 25 мая, кукуруза с 1 окт. и т.д.)
  [0, 1, 2].forEach(yearsAgo => {
    const opt = periodEl.querySelector(`option[value="${yearsAgo}"]`);
    if (opt) opt.textContent = 'Урожай ' + getCropYearRange(g.crop.ys, yearsAgo).from.slice(0, 4);
  });

  const fd = filterPeriod(g.decls, g.crop.ys);
  const { avg, years } = computeYearlyAverage(g.decls, g.crop.ys);
  const avgHtml = avg > 0
    ? `<div style="font-size:12px;color:var(--muted);margin-bottom:10px">Среднее за год урожая: <b style="color:var(--text)">${fmtTon(avg)}</b> (за ${years.length} ${years.length === 1 ? 'год' : 'года'}: ${years.join(', ')})</div>`
    : '';
  const sbadge = { active: '<span style="color:var(--succ)">● Действует</span>', suspended: '<span style="color:var(--warn)">● Приостановлена</span>', expired: '<span style="color:var(--muted)">● Истекла</span>', archived: '<span style="color:var(--muted)">● В архиве</span>' };
  const rows = fd.length ? fd.map(d => `
    <tr>
      <td style="color:var(--muted);white-space:nowrap">${d.regDate||'—'}</td>
      <td>${(d.declNumber||'').slice(0,28)||'—'}</td>
      <td title="${(d.productName||'').replace(/"/g,'&quot;')}">${(d.productName||'—').slice(0,45)}</td>
      <td style="color:var(--muted)">${parseTon(d.batchSize) > 0 ? fmtTon(parseTon(d.batchSize)) : (d.batchSize||'—')}</td>
      <td>${sbadge[d.status] || d.status || '—'}</td>
      <td><button class="btn btn-sm" style="padding:2px 8px;font-size:11px" onclick="closeModal('compModal');openDetail('${d.id}',true)">↗</button></td>
    </tr>`).join('')
    : `<tr><td colspan="6" style="color:var(--muted);padding:12px 0">Нет деклараций за выбранный период</td></tr>`;

  document.getElementById('cropTabContent').innerHTML = `
    ${avgHtml}
    <div class="comp-decls tab-content"><table>
      <thead><tr><th>Дата рег.</th><th>Номер</th><th>Продукция</th><th>Объём</th><th>Статус</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

function selectCropTab(key) {
  State.curCropTab = key;
  updateCropTabs();
}

// ── Detail Modal ──────────────────────────────────────────────────────────
async function openDetail(id, fromCompany = false) {
  // Настраиваем контекст навигации по декларациям
  if (fromCompany && State.curCompDecls.length > 0) {
    State.navDeclIds = State.curCompDecls.map(d => d.id);
    State.navDeclIndex = State.navDeclIds.indexOf(id);
  } else if (!fromCompany) {
    // Открытие без контекста компании — сбрасываем навигацию
    State.navDeclIds = [];
    State.navDeclIndex = -1;
  }

  try {
    const r = await apiFetch('/api/declarations/' + id);
    State.detailRecord = r;

    document.getElementById('detBody').innerHTML = `
      <div class="dsec"><h4>Основные сведения</h4>
        <div class="dg">
          <div class="df full"><div class="df-l">Группа ЕАЭС</div><div class="df-v">${r.group||'—'}</div></div>
          <div class="df"><div class="df-l">Дата регистрации</div><div class="df-v">${r.regDate||'—'}</div></div>
          <div class="df"><div class="df-l">Дата окончания</div><div class="df-v">${r.endDate||'—'}</div></div>
          <div class="df full"><div class="df-l">Заявитель</div><div class="df-v">${r.applicantName||'—'}</div></div>
        </div>
      </div>
      <div class="dsec"><h4>Изготовитель</h4>
        <div class="dg">
          <div class="df full"><div class="df-l">Наименование</div><div class="df-v">${r.shortName||'—'}</div></div>
          ${r.inn ? `<div class="df"><div class="df-l">ИНН</div><div class="df-v">${r.inn}</div></div>` : ''}
          ${r.farmerType && r.farmerType !== 'unknown' ? `<div class="df"><div class="df-l">Тип компании</div><div class="df-v">${
            r.farmerType === 'farmer'        ? '<span class="ft ft-farmer">Производитель</span>' :
            r.farmerType === 'farmer_trader' ? '<span class="ft ft-farmer">Производитель/Трейдер</span>' :
            r.farmerType === 'trader_farmer' ? '<span class="ft ft-trader">Трейдер/Производитель</span>' :
                                               '<span class="ft ft-trader">Трейдер</span>'
          }</div></div>` : ''}
          <div class="df"><div class="df-l">Телефон</div><div class="df-v">${r.phone||'—'}</div></div>
          <div class="df full"><div class="df-l">Адрес</div><div class="df-v">${r.address||'—'}</div></div>
        </div>
      </div>
      <div class="dsec"><h4>Продукция</h4>
        <div class="dg">
          <div class="df full"><div class="df-l">Наименование</div><div class="df-v">${r.productName||'—'}</div></div>
          <div class="df"><div class="df-l">Партия</div><div class="df-v">${r.batchSize||'—'}</div></div>
        </div>
      </div>`;

    const isFav = isFavorite(r.inn, r.shortName);
    const declLabel = (r.declNumber || r.id).replace(/'/g,"\\'");
    const declUrl = (r.fsaUrl || '').replace(/'/g,"\\'");
    const isAdmin = State.user?.role === 'admin';
    const hasDeclNav = State.navDeclIds.length > 1;
    // Навигация вынесена отдельной строкой над кнопками — иначе при нескольких
    // кнопках они вылазят за край flex-контейнера без переноса.
    document.getElementById('detFoot').innerHTML = `
      <div style="width:100%;display:flex;flex-direction:column;gap:10px">
        ${hasDeclNav ? `<div style="display:flex;align-items:center;justify-content:center;gap:6px;padding-bottom:6px;border-bottom:1px solid var(--border)">
          <button class="btn btn-sm" id="declNavPrev" onclick="navDecl(-1)" style="min-width:80px">‹ Предыд.</button>
          <span id="declNavPos" style="font-size:12px;color:var(--muted);min-width:56px;text-align:center;font-weight:600"></span>
          <button class="btn btn-sm" id="declNavNext" onclick="navDecl(+1)" style="min-width:80px">Следующ. ›</button>
        </div>` : ''}
        <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
          ${isAdmin ? `<button class="btn btn-dng btn-sm" onclick="deleteCurrentDetail()">Удалить</button>` : ''}
          ${isAdmin ? `<button class="btn btn-sm" onclick="closeModal('detModal');openAdd('${r.id}',State.detailRecord)">✎ Редактировать</button>` : ''}
          <button class="btn btn-sm ${isFav?'':'btn-p'}" id="detFavBtn" onclick="toggleFavCurrentDetail()">${isFav?'★ В избранном':'☆ В избранное'}</button>
          <button class="btn btn-sm" onclick="addDeclToFolder('${r.id}','${(r.declNumber||'').replace(/'/g,"\\'").replace(/"/g,'&quot;')}')">📁 В папку</button>
          <button class="btn btn-sm" onclick="openAddToNoteModal('${declLabel}','${declUrl}')">📝 В заметку</button>
          <button class="btn btn-p btn-sm" onclick="closeModal('detModal')">Закрыть</button>
        </div>
      </div>`;
    _updateDeclNavButtons();

    openModal('detModal');
  } catch(e) { showAlert(e.message, 'err'); }
}

async function deleteCurrentDetail() {
  const r = State.detailRecord;
  if (!r || !confirm('Удалить эту запись?')) return;
  try {
    await apiFetch('/api/declarations/' + r.id, { method: 'DELETE' });
    showAlert('Запись удалена', 'ok');
    closeModal('detModal');
    loadTable();
    loadStats();
  } catch(e) { showAlert('Ошибка: ' + e.message, 'err'); }
}

async function toggleFavCurrentDetail() {
  const r = State.detailRecord;
  if (!r) return;
  const inn = r.inn || '';
  const name = r.shortName || r.applicantName || '';
  await toggleFavorite(inn, name, null);
  const isFav = isFavorite(inn, name);
  const btn = document.getElementById('detFavBtn');
  if (btn) btn.textContent = isFav ? '★ В избранном' : '☆ В избранное';
}

// ── Profile ───────────────────────────────────────────────────────────────
// ── Feedback (обращения) ────────────────────────────────────────────────────
let _fbImageBlob = null;
let _fbListenersBound = false;

function openFeedbackForm() {
  document.getElementById('feedbackForm').style.display = 'block';
  document.getElementById('fbTitle').value = '';
  document.getElementById('fbDescription').value = '';
  clearFeedbackImage();
  bindFeedbackPasteListener();
  document.getElementById('fbTitle').focus();
}

function bindFeedbackPasteListener() {
  if (_fbListenersBound) return;
  _fbListenersBound = true;
  const zone = document.getElementById('fbDropZone');
  zone.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items || [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        onFeedbackFileSelected(item.getAsFile());
        e.preventDefault();
        break;
      }
    }
  });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.style.borderColor = 'var(--accent)'; });
  zone.addEventListener('dragleave', () => { zone.style.borderColor = 'var(--border)'; });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.style.borderColor = 'var(--border)';
    const file = e.dataTransfer?.files?.[0];
    if (file && file.type.startsWith('image/')) onFeedbackFileSelected(file);
  });
}

function onFeedbackFileSelected(file) {
  if (!file) return;
  _fbImageBlob = file;
  const reader = new FileReader();
  reader.onload = () => {
    document.getElementById('fbPreview').src = reader.result;
    document.getElementById('fbPreviewWrap').style.display = 'block';
  };
  reader.readAsDataURL(file);
}

function clearFeedbackImage() {
  _fbImageBlob = null;
  document.getElementById('fbPreviewWrap').style.display = 'none';
  document.getElementById('fbFileInput').value = '';
}

async function submitFeedback() {
  const title = document.getElementById('fbTitle').value.trim();
  if (!title) { showAlert('Опишите проблему коротко в заголовке', 'err'); return; }

  const fd = new FormData();
  fd.append('title', title);
  fd.append('description', document.getElementById('fbDescription').value);
  if (_fbImageBlob) fd.append('image', _fbImageBlob, _fbImageBlob.name || 'screenshot.png');

  try {
    const res = await fetch('/api/feedback', {
      method: 'POST',
      headers: State.token ? { 'Authorization': `Bearer ${State.token}` } : {},
      body: fd,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Ошибка отправки');
    }
    document.getElementById('feedbackForm').style.display = 'none';
    showAlert('Отправлено, спасибо!');
    loadFeedback();
  } catch (e) { showAlert(e.message, 'err'); }
}

const FB_STATUS_LABEL = { new: '🆕 Новое', in_progress: '🔧 В работе', resolved: '✅ Решено' };

async function loadFeedback() {
  const isAdmin = State.user?.role === 'admin';
  try {
    const items = await apiFetch(isAdmin ? '/api/feedback' : '/api/feedback/mine');
    const listEl = document.getElementById('feedbackList');
    document.getElementById('feedbackEmpty').style.display = items.length ? 'none' : 'block';
    listEl.innerHTML = items.map(it => `
      <div class="item-card" style="align-items:flex-start;flex-wrap:wrap">
        ${it.imagePath ? `<a href="${it.imagePath}" target="_blank"><img src="${it.imagePath}" style="width:64px;height:64px;object-fit:cover;border-radius:var(--r);border:1px solid var(--border)"></a>` : '<span style="font-size:24px">🐞</span>'}
        <div class="item-card-info" style="min-width:200px">
          <div class="item-card-name">${escHtml(it.title)}</div>
          ${it.description ? `<div class="item-card-sub" style="white-space:pre-wrap">${escHtml(it.description)}</div>` : ''}
          <div class="item-card-sub">${isAdmin ? escHtml(it.username || '') + ' · ' : ''}${new Date(it.createdAt).toLocaleString('ru-RU')}</div>
        </div>
        ${isAdmin ? `
          <select class="fi" style="width:auto;font-size:12px" onchange="updateFeedbackStatus(${it.id}, this.value)">
            ${Object.entries(FB_STATUS_LABEL).map(([v, l]) => `<option value="${v}" ${it.status === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
          <button class="btn btn-dng btn-sm" onclick="deleteFeedback(${it.id})">✕</button>
        ` : `<span class="ft" style="background:#F1F1F3;color:var(--text)">${FB_STATUS_LABEL[it.status] || it.status}</span>`}
      </div>`).join('');
  } catch (e) { showAlert(e.message, 'err'); }
}

async function updateFeedbackStatus(id, status) {
  try {
    await apiFetch('/api/feedback/' + id, { method: 'PATCH', body: JSON.stringify({ status }) });
  } catch (e) { showAlert(e.message, 'err'); }
}

async function deleteFeedback(id) {
  if (!confirm('Удалить обращение?')) return;
  try {
    await apiFetch('/api/feedback/' + id, { method: 'DELETE' });
    loadFeedback();
  } catch (e) { showAlert(e.message, 'err'); }
}

async function loadProfile() {
  try {
    const [me, sub] = await Promise.all([
      apiFetch('/api/auth/me'),
      apiFetch('/api/payment/subscription').catch(() => ({ active: false })),
    ]);
    document.getElementById('profUsername').textContent = me.username || '—';
    document.getElementById('profRole').textContent = me.role === 'admin' ? 'Администратор' : 'Пользователь';
    document.getElementById('profCreatedAt').textContent = me.created_at
      ? new Date(me.created_at).toLocaleDateString('ru-RU') : '—';
    document.getElementById('profTgChatId').value = me.tgChatId || '';

    const subEl = document.getElementById('profileSubStatus');
    if (sub.isAdmin) {
      subEl.innerHTML = '<span style="color:var(--accent);font-weight:600">👑 Администратор — полный доступ</span>';
    } else if (sub.active) {
      const d = new Date(sub.subscriptionUntil);
      const days = Math.ceil((d - new Date()) / 86400000);
      subEl.innerHTML = `<span style="color:var(--succ);font-weight:600">✓ Активна до ${d.toLocaleDateString('ru-RU')}</span><br><span style="color:var(--muted);font-size:12px">Осталось ${days} дн. · Тариф: ${sub.plan || '—'}</span>`;
    } else {
      subEl.innerHTML = '<span style="color:var(--dng);font-weight:600">🔒 Нет активной подписки</span>';
    }
  } catch(e) {
    showAlert(e.message, 'err');
  }
}

async function changePassword() {
  const cur = document.getElementById('profCurPass').value;
  const nw  = document.getElementById('profNewPass').value;
  const nw2 = document.getElementById('profNewPass2').value;
  if (!cur || !nw) return showAlert('Заполните все поля', 'err');
  if (nw !== nw2) return showAlert('Пароли не совпадают', 'err');
  try {
    await apiFetch('/api/auth/password', { method: 'PUT', body: JSON.stringify({ currentPassword: cur, newPassword: nw }) });
    document.getElementById('profCurPass').value = '';
    document.getElementById('profNewPass').value = '';
    document.getElementById('profNewPass2').value = '';
    showAlert('Пароль успешно изменён', 'ok');
  } catch(e) { showAlert(e.message, 'err'); }
}

async function saveTgChatId() {
  const tgChatId = document.getElementById('profTgChatId').value.trim();
  try {
    await apiFetch('/api/auth/telegram', { method: 'PUT', body: JSON.stringify({ tgChatId }) });
    showAlert('Chat ID сохранён', 'ok');
  } catch(e) { showAlert(e.message, 'err'); }
}

async function testTgNotification() {
  try {
    await apiFetch('/api/auth/telegram-test', { method: 'POST' });
    showAlert('Тестовое сообщение отправлено', 'ok');
  } catch(e) { showAlert('Ошибка: ' + e.message, 'err'); }
}

// ── Settings ──────────────────────────────────────────────────────────────
let _enrichPollTimer = null;

async function openSettings() {
  try {
    const cfg = await apiFetch('/api/system/telegram-config');
    document.getElementById('tgBotToken').value = cfg.botToken || '';
    document.getElementById('tgChatId').value = cfg.chatId || '';
    openModal('settingsModal');
    refreshEnrichStatus();
    refreshEnrichCacheStats();
  } catch(e) { showAlert(e.message, 'err'); }
}

async function saveTelegramConfig() {
  const botToken = document.getElementById('tgBotToken').value.trim();
  const chatId = document.getElementById('tgChatId').value.trim();
  try {
    await apiFetch('/api/system/telegram-config', { method: 'POST', body: JSON.stringify({ botToken, chatId }) });
    showAlert('Сохранено');
  } catch(e) { showAlert(e.message, 'err'); }
}

async function testTelegram() {
  try {
    await apiFetch('/api/system/telegram-test', { method: 'POST' });
    showAlert('Тест отправлен');
  } catch(e) { showAlert(e.message, 'err'); }
}

async function refreshEnrichStatus() {
  try {
    const s = await apiFetch('/api/enrich/enrich-status');
    const el = document.getElementById('enrichStatus');
    if (!el) return;
    if (s.running) {
      const pct = s.total > 0 ? Math.round(100 * s.done / s.total) : 0;
      el.innerHTML = `⏳ Работает: ${s.done.toLocaleString('ru')} / ${s.total.toLocaleString('ru')} (${pct}%)` +
        (s.apiCalls ? ` · API-запросов: ${s.apiCalls}` : '') +
        (s.errors ? ` · ошибок: ${s.errors}` : '');
    } else {
      el.innerHTML = `Ожидают обогащения: <b>${(s.pending||0).toLocaleString('ru')}</b> деклараций`;
    }
    document.getElementById('enrichStartBtn').style.display = s.running ? 'none' : '';
    document.getElementById('enrichStopBtn').style.display = s.running ? '' : 'none';

    // живой polling пока работает
    clearTimeout(_enrichPollTimer);
    if (s.running && document.getElementById('settingsModal')?.classList.contains('open')) {
      _enrichPollTimer = setTimeout(refreshEnrichStatus, 4000);
    }
  } catch(_) {}
}

async function refreshEnrichCacheStats() {
  try {
    const c = await apiFetch('/api/enrich/cache-stats');
    const el = document.getElementById('enrichCacheStatus');
    if (!el) return;
    el.innerHTML = c.total > 0
      ? `Кэш: <b>${c.known.toLocaleString('ru')}</b> классифицировано · <b>${c.unknownWithOkved.toLocaleString('ru')}</b> не-аграрные (навсегда) · <b>${c.unknownEmpty.toLocaleString('ru')}</b> не найдены (можно переспросить, из них устарело: ${c.staleEmpty})`
      : 'Кэш пуст или не найден';
  } catch(_) {}
}

async function startEnrich() {
  try {
    await apiFetch('/api/enrich/enrich', { method: 'POST' });
    setTimeout(refreshEnrichStatus, 300);
  } catch(e) { showAlert(e.message, 'err'); }
}

async function stopEnrich() {
  await apiFetch('/api/enrich/enrich/stop', { method: 'POST' });
  clearTimeout(_enrichPollTimer);
  refreshEnrichStatus();
}

async function purgeStaleCache() {
  if (!confirm('Удалить из кэша записи без ОКВЭД старше 30 дней? Они будут переспрошены при следующем обогащении.')) return;
  try {
    const r = await apiFetch('/api/enrich/purge-stale', { method: 'POST' });
    showAlert(`Сброшено ${r.removed} устаревших записей из кэша`);
    refreshEnrichCacheStats();
  } catch(e) { showAlert(e.message, 'err'); }
}

// ── Modal helpers ─────────────────────────────────────────────────────────
function openModal(id) {
  const el = document.getElementById(id);
  if (el) { el.style.display = 'flex'; el.classList.add('open'); }
}
function closeModal(id) {
  const el = document.getElementById(id);
  if (el) { el.classList.remove('open'); el.style.display = 'none'; }
}

// ── Add / Edit Record ─────────────────────────────────────────────────────
function openAdd(id, record) {
  State.editingId = id || null;
  document.getElementById('modalTitle').textContent = id ? 'Редактировать запись' : 'Добавить запись вручную';
  ['group','regDate','endDate','applicantName','lastName','firstName','middleName','shortName','address','phone','productName','batchSize','otherInfo'].forEach(f => {
    const el = document.getElementById('f_' + f);
    if (el) el.value = (record && record[f] != null) ? record[f] : '';
  });
  openModal('addModal');
}

async function saveRecord() {
  const fields = ['group','regDate','endDate','applicantName','lastName','firstName','middleName','shortName','address','phone','productName','batchSize','otherInfo'];
  const data = {};
  fields.forEach(f => { data[f] = document.getElementById('f_' + f).value; });
  try {
    if (State.editingId) {
      await apiFetch('/api/declarations/' + State.editingId, { method: 'PUT', body: JSON.stringify(data) });
      showAlert('Запись обновлена', 'ok');
    } else {
      await apiFetch('/api/declarations', { method: 'POST', body: JSON.stringify(data) });
      showAlert('Запись добавлена', 'ok');
    }
    closeModal('addModal');
    loadTable();
    loadStats();
  } catch(e) { showAlert(e.message, 'err'); }
}

// ── Utils ─────────────────────────────────────────────────────────────────
function showAlert(msg, type = 'ok') {
  const el = document.getElementById('alertBox');
  const txt = document.getElementById('alertTxt');
  txt.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 3500);
}

['addModal','detModal','settingsModal','compModal','subscriptionModal','tosModal','addToFolderModal','addToNoteModal','dedupeModal'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', function(e) { if (e.target === this) closeModal(id); });
});

function openTos() {
  openModal('tosModal');
}

function togglePw(inputId, btn) {
  const inp = document.getElementById(inputId);
  const show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  btn.textContent = show ? '🙈' : '👁';
  btn.classList.toggle('visible', show);
}

// ── Subscription ──────────────────────────────────────────────────────────
function applyAdminVisibility(isAdmin) {
  document.querySelectorAll('.admin-only').forEach(el => {
    el.style.display = isAdmin ? '' : 'none';
  });
  const adminTab = document.getElementById('adminTab');
  if (adminTab) adminTab.style.display = isAdmin ? '' : 'none';
}

async function loadSubscriptionStatus() {
  try {
    const s = await apiFetch('/api/payment/subscription');
    const badge = document.getElementById('subBadge');

    applyAdminVisibility(!!s.isAdmin);

    if (s.isAdmin) {
      badge.style.display = 'none';
      return;
    }

    if (s.active) {
      const d = new Date(s.subscriptionUntil);
      const daysLeft = Math.ceil((d - new Date()) / 86400000);
      badge.textContent = daysLeft <= 7 ? `⚠ Подписка: ${daysLeft} д.` : `✓ Подписка до ${d.toLocaleDateString('ru-RU')}`;
      badge.className = 'sub-badge ' + (daysLeft <= 7 ? 'sub-badge-warn' : 'sub-badge-ok');
      badge.style.display = '';
    } else {
      badge.textContent = '🔒 Нет подписки';
      badge.className = 'sub-badge sub-badge-err';
      badge.style.display = '';
    }

    // Проверяем параметр payment_id в URL (редирект после оплаты)
    const urlParams = new URLSearchParams(window.location.search);
    const paymentId = urlParams.get('payment_id');
    if (paymentId) {
      window.history.replaceState({}, '', '/');
      await checkPaymentResult(paymentId);
    }
  } catch(_) {}
}

async function checkPaymentResult(paymentId) {
  try {
    const r = await apiFetch(`/api/payment/check/${paymentId}`);
    if (r.status === 'succeeded') {
      showAlert('✅ Оплата прошла! Подписка активирована.', 'ok');
      await loadSubscriptionStatus();
    } else if (r.status === 'canceled') {
      showAlert('Платёж отменён.', 'err');
    } else {
      showAlert('Платёж обрабатывается...', 'ok');
    }
  } catch(_) {}
}

async function openSubscription() {
  const [sub, plansData] = await Promise.all([
    apiFetch('/api/payment/subscription'),
    apiFetch('/api/payment/plans'),
  ]);

  const statusEl = document.getElementById('subCurrentStatus');
  if (sub.active) {
    const d = new Date(sub.subscriptionUntil);
    statusEl.innerHTML = `<div class="sub-status-ok">✓ Подписка активна до <b>${d.toLocaleDateString('ru-RU')}</b></div>`;
  } else {
    statusEl.innerHTML = `<div class="sub-status-err">Подписка не активна. Выберите тариф для оформления.</div>`;
  }

  document.getElementById('subPlans').innerHTML = plansData.map(p => `
    <div class="sub-plan-card">
      <div class="sub-plan-name">${p.label}</div>
      <div class="sub-plan-price">${p.price.toLocaleString('ru-RU')} ₽</div>
      <div class="sub-plan-per">${Math.round(p.price / (p.days / 30))} ₽/мес</div>
      <button class="btn btn-p" style="width:100%;margin-top:12px" onclick="buyPlan('${p.id}')">Оплатить</button>
    </div>`).join('');

  openModal('subscriptionModal');
}

async function buyPlan(planId) {
  try {
    const r = await apiFetch('/api/payment/create', { method: 'POST', body: JSON.stringify({ planId }) });
    window.location.href = r.paymentUrl;
  } catch(e) {
    showAlert(e.message, 'err');
  }
}

// ── Admin Panel ───────────────────────────────────────────────────────────
async function loadAdminData() {
  try {
    const [stats, users, payments, apiKeys] = await Promise.all([
      apiFetch('/api/admin/stats'),
      apiFetch('/api/admin/users'),
      apiFetch('/api/admin/payments'),
      apiFetch('/api/admin/api-keys'),
    ]);

    document.getElementById('adminStats').innerHTML = `
      <div class="admin-stats-grid">
        <div class="admin-stat-card"><div class="admin-stat-val">${stats.totalUsers}</div><div class="admin-stat-l">Пользователей</div></div>
        <div class="admin-stat-card"><div class="admin-stat-val" style="color:var(--succ)">${stats.activeUsers}</div><div class="admin-stat-l">Активных подписок</div></div>
        <div class="admin-stat-card"><div class="admin-stat-val">${stats.monthRevenue.toLocaleString('ru-RU')} ₽</div><div class="admin-stat-l">Выручка за 30 дней</div></div>
        <div class="admin-stat-card"><div class="admin-stat-val">${stats.totalRevenue.toLocaleString('ru-RU')} ₽</div><div class="admin-stat-l">Выручка всего</div></div>
      </div>`;

    const planLabel = { month1: '1 мес', month3: '3 мес', month12: '12 мес', manual: 'Вручную' };

    document.getElementById('adminUsersTbody').innerHTML = users.map(u => {
      const until = u.subscriptionUntil ? new Date(u.subscriptionUntil) : null;
      const active = until && until > new Date();
      const subStr = until ? `<span class="${active ? 'sub-ok' : 'sub-exp'}">${until.toLocaleDateString('ru-RU')}</span>` : '<span style="color:var(--muted)">—</span>';
      return `<tr>
        <td><b>${u.username}</b></td>
        <td><span class="role-badge role-${u.role}">${u.role}</span></td>
        <td>${subStr}</td>
        <td style="font-size:12px;color:var(--muted)">${planLabel[u.subscriptionPlan] || u.subscriptionPlan || '—'}</td>
        <td style="font-size:12px">${u.paymentCount || 0} / ${(u.totalPaid || 0).toLocaleString('ru-RU')} ₽</td>
        <td style="font-size:12px;color:var(--muted)">${new Date(u.created_at).toLocaleDateString('ru-RU')}</td>
        <td class="admin-actions">
          <button class="btn btn-sm" onclick="adminAddDays(${u.id},'${u.username}')" title="Продлить подписку">+Дни</button>
          <button class="btn btn-sm btn-warn" onclick="adminRevokeSub(${u.id},'${u.username}')" title="Отозвать подписку">✕</button>
          <button class="btn btn-sm" onclick="adminChangeRole(${u.id},'${u.username}','${u.role}')" title="Роль">👤</button>
          <button class="btn btn-sm btn-dng" onclick="adminDeleteUser(${u.id},'${u.username}')" title="Удалить">🗑</button>
        </td>
      </tr>`;
    }).join('');

    const statusLabel = { succeeded: '✅ Успешно', pending: '⏳ Ожидание', canceled: '❌ Отменён' };
    document.getElementById('adminPaymentsTbody').innerHTML = payments.map(p => `
      <tr>
        <td>${p.username}</td>
        <td>${p.amount.toLocaleString('ru-RU')} ₽</td>
        <td style="font-size:12px">${planLabel[p.plan] || p.plan}</td>
        <td style="font-size:12px">${statusLabel[p.status] || p.status}</td>
        <td style="font-size:12px;color:var(--muted)">${new Date(p.createdAt).toLocaleString('ru-RU')}</td>
      </tr>`).join('');

    document.getElementById('adminApiKeysTbody').innerHTML = apiKeys.map(k => `
      <tr>
        <td>${k.label || '—'}</td>
        <td><code style="font-size:11px;cursor:pointer" title="Нажмите, чтобы скопировать" onclick="copyApiKey('${k.key}')">${k.key.slice(0,10)}…${k.key.slice(-6)}</code></td>
        <td style="font-size:12px;color:var(--muted)">${new Date(k.createdAt).toLocaleDateString('ru-RU')}</td>
        <td style="font-size:12px;color:var(--muted)">${k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString('ru-RU') : '—'}</td>
        <td>${k.active ? '<span class="sub-ok">активен</span>' : '<span class="sub-exp">отозван</span>'}</td>
        <td class="admin-actions">${k.active ? `<button class="btn btn-sm btn-dng" onclick="revokeApiKey(${k.id})" title="Отозвать">✕</button>` : ''}</td>
      </tr>`).join('') || '<tr><td colspan="6" style="color:var(--muted);text-align:center;padding:14px">Ключей пока нет</td></tr>';
  } catch(e) { showAlert(e.message, 'err'); }
}

async function importXlsFile() {
  const input = document.getElementById('xlsFileInput');
  const file = input?.files?.[0];
  if (!file) { showAlert('Выберите файл', 'warn'); return; }
  const skipExisting = document.getElementById('xlsSkipExisting')?.checked ? '1' : '0';
  const resultEl = document.getElementById('xlsImportResult');
  resultEl.style.display = 'none';

  const fd = new FormData();
  fd.append('file', file);
  fd.append('skipExisting', skipExisting);
  try {
    const r = await fetch('/api/admin/import-xlsx', {
      method: 'POST',
      headers: State.token ? { Authorization: 'Bearer ' + State.token } : {},
      body: fd,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { showAlert(j.error || 'Ошибка импорта', 'err'); return; }
    const errors = j.errors?.length ? ` · ошибок: ${j.errors.length}` : '';
    resultEl.innerHTML = `✅ Всего: <b>${j.total}</b> компаний · новых: <b>${j.inserted}</b> · обогащено: <b>${j.enriched}</b>${errors}`;
    resultEl.style.display = 'block';
    showAlert(`Импорт завершён: ${j.inserted} новых, ${j.enriched} обновлено`);
    if (j.errors?.length) console.warn('[XLS] Ошибки:', j.errors);
    input.value = '';
  } catch(e) { showAlert(e.message, 'err'); }
}

async function abbreviateOrgForms() {
  if (!confirm('Заменить полные наименования орг.форм на аббревиатуры во всей базе?\n(ООО, АО, ПАО, ЗАО, ОАО, ИП — необратимо)')) return;
  try {
    const r = await apiFetch('/api/admin/abbreviate-org-forms', { method: 'POST' });
    showAlert(`Сокращено: ${r.changed} записей`);
  } catch(e) { showAlert(e.message, 'err'); }
}

async function runArchiveOld() {
  try {
    const r = await apiFetch('/api/admin/archive-old', { method: 'POST' });
    showAlert(`Архивировано: ${r.updated} деклараций старше ${r.archiveAfterDays} дн.`);
    loadTable();
  } catch(e) { showAlert(e.message, 'err'); }
}

async function resetParserCheckpoint() {
  if (!confirm('Парсер заново пройдёт всю историю с FSA_DATE_FROM — это надолго. Точно сбросить чекпоинт?')) return;
  try {
    await apiFetch('/api/admin/reset-parser-checkpoint', { method: 'POST' });
    showAlert('Чекпоинт сброшен — следующий прогон парсера начнётся с начала');
  } catch(e) { showAlert(e.message, 'err'); }
}

async function runDedupeInn() {
  try {
    const r = await apiFetch('/api/admin/dedupe-inn', { method: 'POST' });
    showAlert(`Объединено: ${r.updated} деклараций получили ИНН от совпадающей карточки`);
    loadTable();
  } catch(e) { showAlert(e.message, 'err'); }
}

// ── Спорные дубли (модалка) ───────────────────────────────────────────────
let _ambiguousGroups = [];
let _dedupePage = 0;
const _dedupePageSize = 15;

async function openDedupeModal() {
  openModal('dedupeModal');
  document.getElementById('dedupeSearch').value = '';
  document.getElementById('dedupeGroupsList').innerHTML =
    '<div style="color:var(--muted);text-align:center;padding:40px 0">Загрузка...</div>';
  try {
    _ambiguousGroups = await apiFetch('/api/admin/dedupe-ambiguous');
    _dedupePage = 0;
    document.getElementById('dedupeModalSub').textContent =
      `Найдено спорных групп: ${_ambiguousGroups.length}`;
    renderDedupeGroups();
  } catch(e) { showAlert(e.message, 'err'); }
}

function renderDedupeGroups() {
  const q = (document.getElementById('dedupeSearch')?.value || '').toLowerCase().trim();
  const filtered = q
    ? _ambiguousGroups.filter(g =>
        g.name.toLowerCase().includes(q) ||
        g.inns.some(i => i.inn.includes(q)))
    : _ambiguousGroups;

  const totalPages = Math.ceil(filtered.length / _dedupePageSize);
  if (_dedupePage >= totalPages) _dedupePage = Math.max(0, totalPages - 1);
  const page = filtered.slice(_dedupePage * _dedupePageSize, (_dedupePage + 1) * _dedupePageSize);

  document.getElementById('dedupePagInfo').textContent =
    `${filtered.length} групп · стр. ${_dedupePage + 1} / ${totalPages || 1}`;
  document.getElementById('dedupePrevBtn').disabled = _dedupePage === 0;
  document.getElementById('dedupeNextBtn').disabled = _dedupePage >= totalPages - 1;

  const list = document.getElementById('dedupeGroupsList');
  if (!filtered.length) {
    list.innerHTML = '<div style="color:var(--muted);text-align:center;padding:40px 0">Спорных дублей не найдено</div>';
    return;
  }

  // Используем DOM-методы вместо innerHTML с вложенными template literals
  // чтобы избежать поломки HTML из-за спецсимволов в названиях/ИНН
  list.innerHTML = '';
  page.forEach(g => {
    const globalIdx = _ambiguousGroups.indexOf(g);
    const card = document.createElement('div');
    card.style.cssText = 'border:1px solid var(--border);border-radius:12px;background:var(--surface);margin-bottom:12px';

    // Заголовок карточки
    const hdr = document.createElement('div');
    hdr.style.cssText = 'background:var(--surf2);padding:10px 14px;border-bottom:1px solid var(--border);border-radius:12px 12px 0 0';
    hdr.innerHTML = `<div style="font-size:14px;font-weight:600;margin-bottom:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(g.name)}</div>
      <div style="font-size:11px;color:var(--muted)">${escHtml(g.address || '—')}</div>`;
    card.appendChild(hdr);

    // Тело карточки
    const body = document.createElement('div');
    body.style.cssText = 'padding:10px 14px';

    const label = document.createElement('div');
    label.style.cssText = 'font-size:11px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px';
    label.textContent = 'Варианты ИНН — выберите правильный:';
    body.appendChild(label);

    // Строки с ИНН
    g.inns.forEach(inn => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--surf2);border:1px solid var(--border);border-radius:8px;margin-bottom:6px';

      const info = document.createElement('div');
      info.style.cssText = 'flex:1;min-width:0';
      info.innerHTML = `<div style="font-size:13px;font-weight:600">${escHtml(inn.inn)}</div>
        <div style="font-size:11px;color:var(--muted)">${inn.count} деклараций</div>`;
      row.appendChild(info);

      const btnOpen = document.createElement('button');
      btnOpen.className = 'btn btn-sm';
      btnOpen.style.cssText = 'font-size:11px;padding:3px 8px;white-space:nowrap;flex-shrink:0';
      btnOpen.textContent = '🔍 Открыть';
      btnOpen.title = 'Открыть карточку компании с этим ИНН';
      btnOpen.addEventListener('click', () => openCompany(inn.inn, g.name));
      row.appendChild(btnOpen);

      const btnChoose = document.createElement('button');
      btnChoose.className = 'btn btn-sm btn-p';
      btnChoose.style.cssText = 'font-size:11px;padding:3px 8px;white-space:nowrap;flex-shrink:0';
      btnChoose.textContent = '✓ Выбрать';
      btnChoose.title = 'Объединить все декларации группы на этот ИНН';
      btnChoose.addEventListener('click', () => dedupeChooseInn(globalIdx, inn.inn));
      row.appendChild(btnChoose);

      body.appendChild(row);
    });

    // Кнопка "Не дубль"
    const notDuplDiv = document.createElement('div');
    notDuplDiv.style.cssText = 'display:flex;justify-content:flex-end;margin-top:4px';
    const btnNot = document.createElement('button');
    btnNot.className = 'btn btn-sm';
    btnNot.style.cssText = 'font-size:11px;color:var(--muted)';
    btnNot.textContent = '✕ Не дубль — это разные компании';
    btnNot.addEventListener('click', () => dedupeNotDuplicate(globalIdx));
    notDuplDiv.appendChild(btnNot);
    body.appendChild(notDuplDiv);

    card.appendChild(body);
    list.appendChild(card);
  });
}

function dedupeChangePage(delta) {
  _dedupePage += delta;
  renderDedupeGroups();
  document.getElementById('dedupeGroupsList').scrollTop = 0;
}

async function dedupeChooseInn(idx, chosenInn) {
  const g = _ambiguousGroups[idx];
  if (!g) return;
  if (!confirm(`Все декларации группы "${g.name}" получат ИНН ${chosenInn}.\nОбновится ${g.inns.reduce((s,i)=>s+i.count,0)} деклараций. Продолжить?`)) return;
  try {
    const r = await apiFetch('/api/admin/dedupe-resolve', {
      method: 'POST',
      body: JSON.stringify({ nameKey: g.nameKey, addrKey: g.addrKey, inn: chosenInn })
    });
    _ambiguousGroups.splice(idx, 1);
    showAlert(`✅ Объединено: ${r.updated} деклараций получили ИНН ${chosenInn}`);
    document.getElementById('dedupeModalSub').textContent =
      `Найдено спорных групп: ${_ambiguousGroups.length}`;
    renderDedupeGroups();
  } catch(e) { showAlert(e.message, 'err'); }
}

async function dedupeNotDuplicate(idx) {
  const g = _ambiguousGroups[idx];
  if (!g) return;
  try {
    await apiFetch('/api/admin/dedupe-dismiss', {
      method: 'POST',
      body: JSON.stringify({ nameKey: g.nameKey, addrKey: g.addrKey })
    });
    _ambiguousGroups.splice(idx, 1);
    showAlert('Помечено как "не дубль"');
    document.getElementById('dedupeModalSub').textContent =
      `Найдено спорных групп: ${_ambiguousGroups.length}`;
    renderDedupeGroups();
  } catch(e) { showAlert(e.message, 'err'); }
}

// Оставляем для совместимости (вызывается из loadAdminData)
async function loadAmbiguousInn() { openDedupeModal(); }

async function createApiKey() {
  const label = document.getElementById('apiKeyLabel').value.trim();
  try {
    const created = await apiFetch('/api/admin/api-keys', { method: 'POST', body: JSON.stringify({ label }) });
    document.getElementById('apiKeyLabel').value = '';
    await navigator.clipboard?.writeText(created.key).catch(() => {});
    showAlert('Ключ создан и скопирован в буфер: ' + created.key);
    loadAdminData();
  } catch(e) { showAlert(e.message, 'err'); }
}

function copyApiKey(key) {
  navigator.clipboard?.writeText(key).then(() => showAlert('Ключ скопирован')).catch(() => showAlert(key));
}

async function revokeApiKey(id) {
  if (!confirm('Отозвать ключ? Интеграция с ним перестанет работать.')) return;
  try {
    await apiFetch('/api/admin/api-keys/' + id, { method: 'DELETE' });
    loadAdminData();
  } catch(e) { showAlert(e.message, 'err'); }
}

async function adminAddDays(userId, username) {
  const days = parseInt(prompt(`Добавить дней подписки для "${username}":`));
  if (!days || days < 1) return;
  try {
    await apiFetch(`/api/admin/users/${userId}/subscription`, { method: 'PUT', body: JSON.stringify({ days }) });
    showAlert(`Подписка продлена на ${days} дн.`);
    loadAdminData();
  } catch(e) { showAlert(e.message, 'err'); }
}

async function adminRevokeSub(userId, username) {
  if (!confirm(`Отозвать подписку у "${username}"?`)) return;
  try {
    await apiFetch(`/api/admin/users/${userId}/subscription`, { method: 'DELETE' });
    showAlert('Подписка отозвана');
    loadAdminData();
  } catch(e) { showAlert(e.message, 'err'); }
}

async function adminChangeRole(userId, username, currentRole) {
  const newRole = currentRole === 'admin' ? 'user' : 'admin';
  if (!confirm(`Изменить роль "${username}" с "${currentRole}" на "${newRole}"?`)) return;
  try {
    await apiFetch(`/api/admin/users/${userId}/role`, { method: 'PUT', body: JSON.stringify({ role: newRole }) });
    showAlert('Роль изменена');
    loadAdminData();
  } catch(e) { showAlert(e.message, 'err'); }
}

async function adminDeleteUser(userId, username) {
  if (!confirm(`Удалить пользователя "${username}"? Это действие необратимо.`)) return;
  try {
    await apiFetch(`/api/admin/users/${userId}`, { method: 'DELETE' });
    showAlert('Пользователь удалён');
    loadAdminData();
  } catch(e) { showAlert(e.message, 'err'); }
}

// ── Initialization ────────────────────────────────────────────────────────
function initApp() {
  try {
    if (localStorage.getItem('sidebarCollapsed') === '1') {
      const body = document.querySelector('.body');
      document.getElementById('mainSidebar').classList.add('collapsed');
      body.classList.add('sidebar-collapsed');
      const btn = document.getElementById('sidebarToggle');
      if (btn) btn.textContent = '›';
    }
  } catch(_) {}
  loadFavsCache();
  loadStats();
  loadSubscriptionStatus();
  loadTable().catch(err => {
    if (err.message && err.message.includes('SUBSCRIPTION_REQUIRED')) {
      openModal('noAccessModal');
    }
  });
  pollStatus();
}

document.addEventListener('DOMContentLoaded', () => {
  ['csManuf','csAddress','csProduct'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  checkAuth();
});

// ── Модалка "В заметку" ───────────────────────────────────────────────────
let _atnLink = null;
let _atnAllNotes = [];

async function openAddToNoteModal(label, url) {
  _atnLink = { label, url };
  document.getElementById('atnLabel').textContent = label;
  const urlEl = document.getElementById('atnUrl');
  urlEl.textContent = url || '';
  urlEl.style.display = url ? '' : 'none';
  document.getElementById('atnNewTitle').value = label;
  document.getElementById('atnSearch').value = '';

  try { _atnAllNotes = await apiFetch('/api/notes'); } catch(_) { _atnAllNotes = []; }
  atnRenderList();
  openModal('addToNoteModal');
  setTimeout(() => document.getElementById('atnSearch').focus(), 150);
}

function atnRenderList() {
  const q = (document.getElementById('atnSearch').value || '').trim().toLowerCase();
  const notes = _atnAllNotes.filter(n => !q || n.title.toLowerCase().includes(q));
  const list = document.getElementById('atnNoteList');
  const empty = document.getElementById('atnEmpty');
  if (!notes.length) {
    list.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  list.innerHTML = notes.map(n => `
    <div onclick="atnPickNote(${n.id})" style="display:flex;align-items:flex-start;gap:10px;padding:9px 12px;border:1px solid var(--border);border-radius:var(--r);cursor:pointer;background:var(--surface);transition:background .12s" onmouseover="this.style.background='var(--acl)'" onmouseout="this.style.background='var(--surface)'">
      <span style="font-size:18px;flex-shrink:0">📝</span>
      <div style="min-width:0">
        <div style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(n.title)}</div>
        ${n.links?.length ? `<div style="font-size:11px;color:var(--muted)">${n.links.length} ссылок</div>` : ''}
      </div>
    </div>`).join('');
}

async function atnPickNote(noteId) {
  if (!_atnLink) return;
  try {
    await apiFetch('/api/notes/' + noteId + '/link', { method: 'POST', body: JSON.stringify(_atnLink) });
    closeModal('addToNoteModal');
    showAlert('Добавлено в заметку');
    if (_notes.length) loadNotes();
  } catch(e) { showAlert(e.message, 'err'); }
}

async function atnCreateAndAdd() {
  const title = document.getElementById('atnNewTitle').value.trim();
  if (!title) { document.getElementById('atnNewTitle').focus(); return; }
  try {
    await apiFetch('/api/notes', { method: 'POST', body: JSON.stringify({
      title, content: '', links: _atnLink ? [_atnLink] : [], notifyTime: null
    })});
    closeModal('addToNoteModal');
    showAlert('Заметка создана');
    if (_notes.length) loadNotes();
  } catch(e) { showAlert(e.message, 'err'); }
}

// ── Мои базы контактов ────────────────────────────────────────────────────

// Цвета типов колонок
// Excel-style цвета (те самые популярные акцентные)
const MYDB_TYPES = {
  inn:     { label: 'ИНН',           bg: '#C5D9F1', color: '#17375E', icon: '🔵' },
  name:    { label: 'Название',      bg: '#D8E4BC', color: '#375623', icon: '🟢' },
  phone:   { label: 'Телефон',      bg: '#FABF8F', color: '#7F2000', icon: '🟠' },
  phone2:  { label: 'Телефон 2',    bg: '#FFDDC1', color: '#7F2000', icon: '🔶' },
  email:   { label: 'Email',        bg: '#FFEB9C', color: '#9C5700', icon: '🟡' },
  address: { label: 'Адрес',        bg: '#E2EFDA', color: '#375623', icon: '🟩' },
};

function toggleMydbUpload() {
  const z = document.getElementById('mydbUploadZone');
  z.style.display = z.style.display === 'none' ? 'block' : 'none';
}

function handleMydbDrop(e) {
  const file = e.dataTransfer?.files?.[0];
  if (file) startMydbPreview(file);
}

function handleMydbFileInput(input) {
  const file = input.files?.[0];
  if (file) { startMydbPreview(file); input.value = ''; }
}

async function startMydbPreview(file) {
  const prog = document.getElementById('mydbUploadProgress');
  const res  = document.getElementById('mydbUploadResult');
  prog.style.display = 'block';
  res.style.display  = 'none';
  prog.textContent   = '⏳ Загружаем файл...';

  const fd = new FormData();
  fd.append('file', file);
  try {
    const data = await fetch('/api/user/contacts/preview', {
      method: 'POST',
      headers: State.token ? { Authorization: `Bearer ${State.token}` } : {},
      body: fd,
    }).then(r => r.json());

    prog.style.display = 'none';
    if (data.error) {
      res.style.display = 'block';
      res.innerHTML = `<div style="color:var(--err);font-size:13px">❌ ${escHtml(data.error)}</div>`;
      return;
    }
    openMydbColPicker(data);
  } catch(e) {
    prog.style.display = 'none';
    res.style.display = 'block';
    res.innerHTML = `<div style="color:var(--err);font-size:13px">❌ ${escHtml(e.message)}</div>`;
  }
}

function openMydbColPicker(previewData) {
  State.mydbPreview = previewData;
  State.mydbMapping = {};

  // Применяем подсказку AI/keyword
  const sc = previewData.suggestedCols || {};
  for (const [type, idx] of Object.entries(sc)) {
    if (idx >= 0) State.mydbMapping[idx] = type;
  }

  document.getElementById('mydbColModalSub').textContent =
    `${previewData.originalName} · ${previewData.headers.length} колонок · нажмите на заголовок и выберите цвет`;

  renderColPickerTable();
  openModal('mydbColModal');
}

function renderColPickerTable() {
  const { headers, sampleRows } = State.mydbPreview;
  const mapping = State.mydbMapping;

  const thCells = headers.map((h, i) => {
    const type = mapping[i] || '';
    const t    = MYDB_TYPES[type];
    const bg   = t ? `background:${t.bg};` : 'background:#f8fafc;';
    const badge = t
      ? `<div style="margin-top:5px;display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:700;background:${t.bg};color:${t.color};border:1px solid ${t.color}40;cursor:pointer">
           ${t.icon} ${t.label} <span style="opacity:.6;font-size:10px">▾</span>
         </div>`
      : `<div style="margin-top:5px;display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:12px;font-size:11px;background:#f1f5f9;color:#94a3b8;border:1px dashed #cbd5e1;cursor:pointer">
           + выбрать
         </div>`;
    return `<th data-col="${i}" onclick="openColTypePicker(event,${i})"
      style="${bg}min-width:110px;max-width:155px;padding:8px 10px;border:1px solid #d1d5db;vertical-align:top;text-align:left;cursor:pointer;transition:.15s"
      onmouseenter="this.style.filter='brightness(.96)'" onmouseleave="this.style.filter=''">
      <div style="font-size:12px;font-weight:600;color:#374151;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:130px" title="${escHtml(h)}">${escHtml(h||'(пусто)')}</div>
      ${badge}
    </th>`;
  }).join('');

  const bodyRows = sampleRows.map(row => {
    const cells = headers.map((_, i) => {
      const type = mapping[i] || '';
      const t    = MYDB_TYPES[type];
      const bg   = t ? `background:${t.bg}70;` : '';
      const val  = String(row[i] ?? '');
      return `<td data-col="${i}" style="${bg}padding:5px 10px;border:1px solid #e5e7eb;font-size:12px;color:#374151;max-width:155px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(val)}">${escHtml(val)}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');

  document.getElementById('mydbColTable').innerHTML = `
    <table style="border-collapse:collapse;min-width:max-content;font-family:inherit">
      <thead><tr>${thCells}</tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>`;

  updateMydbColStatus();
}

// Всплывающий пикер типа колонки
function openColTypePicker(event, colIdx) {
  event.stopPropagation();
  document.getElementById('_colPicker')?.remove();

  const picker = document.createElement('div');
  picker.id = '_colPicker';
  const headerName = State.mydbPreview?.headers?.[colIdx] || `Колонка ${colIdx + 1}`;

  picker.innerHTML = `
    <div style="font-size:11px;color:#6b7280;margin-bottom:8px;font-weight:500">
      Тип для «${escHtml(headerName.slice(0, 22))}»:
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px">
      ${Object.entries(MYDB_TYPES).map(([v, t]) => `
        <button onclick="setMydbColType(${colIdx},'${v}');document.getElementById('_colPicker')?.remove()"
          style="padding:7px 6px;border-radius:7px;border:1.5px solid ${t.color}60;
                 background:${t.bg};color:${t.color};font-size:12px;font-weight:600;
                 cursor:pointer;text-align:left;display:flex;align-items:center;gap:5px;
                 transition:.1s" onmouseenter="this.style.filter='brightness(.94)'" onmouseleave="this.style.filter=''">
          ${t.icon} ${t.label}
        </button>`).join('')}
    </div>
    <button onclick="setMydbColType(${colIdx},'');document.getElementById('_colPicker')?.remove()"
      style="width:100%;padding:5px;border-radius:6px;border:1px solid #e5e7eb;
             background:#f9fafb;color:#9ca3af;font-size:11px;cursor:pointer">
      ✕ Не импортировать эту колонку
    </button>`;

  Object.assign(picker.style, {
    position: 'fixed', zIndex: '99999',
    background: 'white', border: '1px solid #e5e7eb',
    borderRadius: '10px', boxShadow: '0 8px 30px rgba(0,0,0,.15)',
    padding: '12px', minWidth: '230px',
  });

  // Позиционирование — вписываем в экран
  document.body.appendChild(picker);
  const rect = picker.getBoundingClientRect();
  const x = Math.min(event.clientX, window.innerWidth  - rect.width  - 8);
  const y = Math.min(event.clientY + 6, window.innerHeight - rect.height - 8);
  picker.style.left = x + 'px';
  picker.style.top  = y + 'px';

  // Закрываем по клику снаружи
  setTimeout(() => document.addEventListener('click', function h() {
    document.getElementById('_colPicker')?.remove();
    document.removeEventListener('click', h);
  }, { once: true }), 50);
}

function setMydbColType(colIdx, type) {
  const mapping = State.mydbMapping;

  // Снимаем этот тип с других колонок (phone + phone2 могут быть оба)
  if (type && type !== 'phone2') {
    for (const [k, v] of Object.entries(mapping)) {
      if (v === type && Number(k) !== colIdx) {
        mapping[k] = '';
        _applyColStyle(Number(k), '');
      }
    }
  }
  mapping[colIdx] = type;
  _applyColStyle(colIdx, type);
  updateMydbColStatus();

  // Обновляем бейдж в заголовке без полного перерендера
  const th = document.querySelector(`#mydbColTable th[data-col="${colIdx}"]`);
  if (th) {
    const t = MYDB_TYPES[type];
    th.style.background = t ? t.bg : '#f8fafc';
    const badgeEl = th.querySelector('div:last-child');
    if (badgeEl) {
      if (t) {
        badgeEl.style.cssText = `margin-top:5px;display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:700;background:${t.bg};color:${t.color};border:1px solid ${t.color}40;cursor:pointer`;
        badgeEl.innerHTML = `${t.icon} ${t.label} <span style="opacity:.6;font-size:10px">▾</span>`;
      } else {
        badgeEl.style.cssText = 'margin-top:5px;display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:12px;font-size:11px;background:#f1f5f9;color:#94a3b8;border:1px dashed #cbd5e1;cursor:pointer';
        badgeEl.innerHTML = '+ выбрать';
      }
    }
  }
}

function _applyColStyle(colIdx, type) {
  const t  = MYDB_TYPES[type];
  const bg = t ? t.bg + '70' : '';
  document.querySelectorAll(`#mydbColTable td[data-col="${colIdx}"]`).forEach(el => {
    el.style.background = bg;
  });
}

function updateMydbColStatus() {
  const m   = State.mydbMapping;
  const has = t => Object.values(m).includes(t);
  const ok  = has('phone') || has('phone2') || has('email');

  document.getElementById('mydbColConfirmBtn').disabled = !ok;

  const parts = Object.entries(MYDB_TYPES)
    .filter(([type]) => {
      const idx = Object.entries(m).find(([, v]) => v === type)?.[0];
      return idx !== undefined;
    })
    .map(([type, td]) => {
      const idx = Object.entries(m).find(([, v]) => v === type)[0];
      return `<span style="padding:2px 10px;border-radius:10px;font-size:11px;background:${td.bg};color:${td.color};border:1px solid ${td.color}40">${td.icon} ${td.label} → кол.${Number(idx)+1}</span>`;
    });

  document.getElementById('mydbColStatus').innerHTML = parts.length
    ? parts.join(' ')
    : '<span style="color:var(--muted)">Нажмите на заголовок колонки чтобы назначить тип</span>';
}

async function confirmMydbMapping() {
  const { uploadId, originalName } = State.mydbPreview || {};
  if (!uploadId) return;

  // Строим mapping: тип → индекс колонки
  const mapping = {};
  for (const [idx, type] of Object.entries(State.mydbMapping)) {
    if (type) mapping[type] = Number(idx);
  }

  document.getElementById('mydbColConfirmBtn').disabled = true;
  document.getElementById('mydbColConfirmBtn').textContent = '⏳ Обработка...';

  try {
    const data = await apiFetch('/api/user/contacts/process', {
      method: 'POST',
      body: JSON.stringify({ uploadId, mapping }),
    });

    closeModal('mydbColModal');
    State.mydbPreview = null;
    State.mydbMapping = {};

    const res = document.getElementById('mydbUploadResult');
    res.style.display = 'block';
    res.innerHTML = `<div style="color:#16a34a;font-size:13px;background:#f0fdf4;padding:10px 14px;border-radius:var(--r)">
      ✅ <b>${escHtml(originalName || 'Файл')}</b> импортирован: <b>${data.total}</b> строк
      &nbsp;·&nbsp; Совпало с реестром: <b>${data.matched}</b>
      &nbsp;·&nbsp; Только у вас: <b>${data.private}</b>
      &nbsp;·&nbsp; Пропущено: ${data.skipped}
    </div>`;
    loadMydbPage();
  } catch(e) {
    document.getElementById('mydbColConfirmBtn').disabled = false;
    document.getElementById('mydbColConfirmBtn').textContent = 'Импортировать';
    showAlert(e.message, 'err');
  }
}

async function cancelMydbUpload() {
  const uploadId = State.mydbPreview?.uploadId;
  if (uploadId) {
    // Удаляем pending-запись с сервера (без confirm, это просто отмена)
    apiFetch(`/api/user/contacts/uploads/${uploadId}`, { method: 'DELETE' }).catch(() => {});
  }
  State.mydbPreview = null;
  State.mydbMapping = {};
  closeModal('mydbColModal');
}

async function loadMydbPage() {
  try {
    const uploads = await apiFetch('/api/user/contacts/uploads');
    const listEl  = document.getElementById('mydbUploadsList');
    const emptyEl = document.getElementById('mydbEmpty');

    if (!uploads.length) {
      emptyEl.style.display = 'flex';
      listEl.innerHTML = '';
      document.getElementById('mydbPrivateSection').style.display = 'none';
      return;
    }
    emptyEl.style.display = 'none';

    listEl.innerHTML = uploads.map(u => `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--rl);padding:14px 16px;margin-bottom:10px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <div style="flex:1;min-width:160px">
          <div style="font-weight:600;font-size:14px;margin-bottom:4px">${escHtml(u.originalName)}</div>
          <div style="font-size:12px;color:var(--muted)">${u.createdAt ? new Date(u.createdAt).toLocaleDateString('ru-RU') : '—'} &nbsp;·&nbsp; ${(u.fileSize/1024).toFixed(0)} КБ</div>
        </div>
        <div style="display:flex;gap:16px;font-size:13px;flex-wrap:wrap">
          <div><span style="color:var(--muted)">Всего строк:</span> <b>${u.totalRows}</b></div>
          <div><span style="color:var(--muted)">Совпало:</span> <b style="color:#16a34a">${u.matchedRows}</b></div>
          <div><span style="color:var(--muted)">Только у вас:</span> <b style="color:#0a3870">${u.privateRows}</b></div>
        </div>
        <button class="btn btn-sm" style="color:var(--err);border-color:var(--err)"
          onclick="deleteMydbUpload(${u.id})">🗑 Удалить</button>
      </div>
    `).join('');

    const totalPrivate = uploads.reduce((s, u) => s + (u.privateRows || 0), 0);
    if (totalPrivate > 0) {
      document.getElementById('mydbPrivateSection').style.display = 'block';
      loadMydbPrivate(0);
    } else {
      document.getElementById('mydbPrivateSection').style.display = 'none';
    }
  } catch(e) {
    console.error('loadMydbPage:', e);
  }
}

async function deleteMydbUpload(id) {
  if (!confirm('Удалить эту загрузку и все связанные контакты?')) return;
  try {
    await apiFetch(`/api/user/contacts/uploads/${id}`, { method: 'DELETE' });
    loadMydbPage();
  } catch(e) { showAlert(e.message, 'err'); }
}

async function loadMydbPrivate(page) {
  page = Math.max(0, page);
  State.mydbPrivatePage = page;
  const listEl = document.getElementById('mydbPrivateList');
  listEl.innerHTML = '<div style="color:var(--muted);font-size:13px">Загрузка...</div>';

  try {
    const data = await apiFetch(`/api/user/contacts/private?page=${page}`);
    const { rows, total } = data;

    document.getElementById('mydbPrivateCount').textContent = `${total} компаний`;
    const pageSize = 50;
    const totalPages = Math.ceil(total / pageSize);

    listEl.innerHTML = rows.length ? rows.map(r => `
      <div style="padding:8px 12px;border-bottom:1px solid var(--border);font-size:13px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <div style="flex:1;min-width:120px;font-weight:500">${escHtml(r.companyName || '—')}</div>
        ${r.inn ? `<div style="color:var(--muted);font-size:12px">ИНН: ${r.inn}</div>` : ''}
        ${r.phone ? `<div style="color:#0a3870">📞 ${escHtml(r.phone)}${r.phone2 ? ' · ' + escHtml(r.phone2) : ''}</div>` : ''}
        ${r.email ? `<div style="color:var(--muted);font-size:12px">✉ ${escHtml(r.email)}</div>` : ''}
        ${r.address ? `<div style="color:var(--muted);font-size:12px">📍 ${escHtml(r.address).slice(0, 60)}</div>` : ''}
      </div>
    `).join('') : '<div style="color:var(--muted);font-size:13px;padding:8px">Нет данных</div>';

    const pager = document.getElementById('mydbPrivatePager');
    if (totalPages > 1) {
      pager.style.display = 'block';
      document.getElementById('mydbPrivatePageInfo').textContent = `${page + 1} / ${totalPages}`;
      document.querySelector('#mydbPrivatePager button:first-child').disabled = page <= 0;
      document.querySelector('#mydbPrivatePager button:last-child').disabled = page >= totalPages - 1;
    } else {
      pager.style.display = 'none';
    }
  } catch(e) {
    listEl.innerHTML = `<div style="color:var(--err);font-size:13px">${escHtml(e.message)}</div>`;
  }
}

// Загружает пользовательские контакты для карточки компании
async function loadUserContactsForCard(inn, name) {
  if (!State.token) return;
  try {
    const qs = inn ? '?inn=' + encodeURIComponent(inn) : '?name=' + encodeURIComponent(name || '');
    const data = await apiFetch('/api/user/contacts/for-company' + qs);
    const el = document.getElementById('compUserContacts');
    if (!el || !data || !data.length) return;

    const items = data.map(c => {
      const parts = [];
      if (c.phone)  parts.push(`<span style="color:#0a3870;font-weight:500">📞 ${escHtml(c.phone)}${c.phone2 ? ' · ' + escHtml(c.phone2) : ''}</span>`);
      if (c.email)  parts.push(`<span style="color:var(--muted);font-size:12px">✉ ${escHtml(c.email)}</span>`);
      if (c.address) parts.push(`<span style="color:var(--muted);font-size:12px">📍 ${escHtml(c.address).slice(0, 60)}</span>`);
      return parts.join(' &nbsp; ');
    }).filter(Boolean);

    if (!items.length) return;
    el.innerHTML = `
      <div class="dsec" style="margin-bottom:16px;background:#f0f9ff;border-color:#bae6fd">
        <h4 style="color:#0369a1;margin-bottom:8px">📞 Ваши контакты <span style="font-size:11px;color:var(--muted);font-weight:400">(из загруженных баз)</span></h4>
        ${items.map(i => `<div style="margin-bottom:4px">${i}</div>`).join('')}
      </div>`;
  } catch(_) {}
}

// ── Notes ─────────────────────────────────────────────────────────────────
let _notes = [];
let _editingNoteId = null;

async function loadNotes() {
  try {
    _notes = await apiFetch('/api/notes');
    renderNotes();
  } catch(e) {
    if (e.message !== 'SUBSCRIPTION_REQUIRED') showAlert('Ошибка загрузки заметок: ' + e.message, 'err');
  }
}

function renderNotes() {
  const grid = document.getElementById('notesGrid');
  const empty = document.getElementById('notesEmpty');
  if (!grid) return;
  if (!_notes.length) {
    grid.innerHTML = '';
    if (empty) empty.style.display = '';
    return;
  }
  if (empty) empty.style.display = 'none';
  grid.innerHTML = _notes.map(n => {
    const linksHtml = n.links.length
      ? `<span class="note-chip">🔗 ${n.links.length} ссыл.</span>`
      : '';
    const notifyHtml = n.notifyTime
      ? `<span class="note-chip notify">🔔 ${n.notifyTime} UTC</span>`
      : '';
    return `
      <div class="note-card" onclick="openNoteModal(${n.id})">
        <div class="note-card-title">${escHtml(n.title)}</div>
        ${n.content ? `<div class="note-card-body">${escHtml(n.content)}</div>` : ''}
        <div class="note-card-footer">
          <div style="display:flex;gap:6px;flex-wrap:wrap">${linksHtml}${notifyHtml}</div>
          <span style="font-size:10px;color:var(--muted)">${new Date(n.updatedAt).toLocaleDateString('ru-RU')}</span>
        </div>
      </div>`;
  }).join('');
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function openNoteModal(noteId) {
  _editingNoteId = noteId;
  const note = noteId ? _notes.find(n => n.id === noteId) : null;
  document.getElementById('noteModalTitle').textContent = note ? 'Редактировать заметку' : 'Новая заметка';
  document.getElementById('noteTitle').value = note ? note.title : '';
  document.getElementById('noteContent').value = note ? (note.content || '') : '';
  document.getElementById('noteDeleteBtn').style.display = note ? '' : 'none';

  const hasNotify = !!(note && note.notifyTime);
  document.getElementById('noteNotifyToggle').checked = hasNotify;
  document.getElementById('noteNotifyTime').value = hasNotify ? note.notifyTime : '';
  document.getElementById('noteNotifyRow').style.display = hasNotify ? 'block' : 'none';

  const linksContainer = document.getElementById('noteLinks');
  linksContainer.innerHTML = '';
  (note ? note.links : []).forEach(l => addNoteLinkRow(l.label || '', l.url || ''));

  openModal('noteModal');
}

function addNoteLink(label, url) {
  addNoteLinkRow(label || '', url || '');
}

function addNoteLinkRow(label, url) {
  const container = document.getElementById('noteLinks');
  const row = document.createElement('div');
  row.className = 'note-link-row';
  row.innerHTML = `
    <input type="text" class="fi note-link-label" placeholder="Название" value="${escHtml(label)}" style="width:35%">
    <input type="url" class="fi note-link-url" placeholder="https://..." value="${escHtml(url)}" style="flex:1">
    <button type="button" class="note-rm" onclick="this.closest('.note-link-row').remove()">✕</button>`;
  container.appendChild(row);
}

function toggleNoteNotify(checked) {
  document.getElementById('noteNotifyRow').style.display = checked ? 'block' : 'none';
}

let _savingNote = false;
async function saveNote() {
  if (_savingNote) return;
  const title = document.getElementById('noteTitle').value.trim();
  if (!title) { showAlert('Введите заголовок заметки', 'err'); return; }

  _savingNote = true;

  const content = document.getElementById('noteContent').value;
  const hasNotify = document.getElementById('noteNotifyToggle').checked;
  const notifyTime = hasNotify ? document.getElementById('noteNotifyTime').value : null;

  const linkRows = document.querySelectorAll('#noteLinks .note-link-row');
  const links = [];
  linkRows.forEach(row => {
    const url = row.querySelector('.note-link-url').value.trim();
    const label = row.querySelector('.note-link-label').value.trim();
    if (url) links.push({ label: label || url, url });
  });

  try {
    const body = { title, content, links, notifyTime: notifyTime || null };
    if (_editingNoteId) {
      const updated = await apiFetch(`/api/notes/${_editingNoteId}`, { method: 'PUT', body: JSON.stringify(body) });
      const idx = _notes.findIndex(n => n.id === _editingNoteId);
      if (idx !== -1) _notes[idx] = updated;
    } else {
      const created = await apiFetch('/api/notes', { method: 'POST', body: JSON.stringify(body) });
      _notes.unshift(created);
    }
    renderNotes();
    closeModal('noteModal');
  } catch(e) { showAlert('Ошибка сохранения: ' + e.message, 'err'); }
  finally { _savingNote = false; }
}

async function deleteNote() {
  if (!_editingNoteId) return;
  if (!confirm('Удалить заметку?')) return;
  try {
    await apiFetch(`/api/notes/${_editingNoteId}`, { method: 'DELETE' });
    _notes = _notes.filter(n => n.id !== _editingNoteId);
    renderNotes();
    closeModal('noteModal');
  } catch(e) { showAlert('Ошибка удаления: ' + e.message, 'err'); }
}
