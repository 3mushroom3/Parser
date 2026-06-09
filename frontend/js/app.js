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
  curCropTab: 'all',
  detailRecord: null,
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
    handleLogout();
    throw new Error('Сессия истекла. Войдите снова.');
  }

  if (response.status === 403) {
    const error = await response.json().catch(() => ({}));
    if (error.code === 'SUBSCRIPTION_REQUIRED') {
      const modal = document.getElementById('noAccessModal');
      if (modal) modal.classList.add('open');
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
function showPage(name) {
  document.getElementById('pg-registry').style.display  = name === 'registry'  ? '' : 'none';
  document.getElementById('pg-map').style.display       = name === 'map'       ? 'block' : 'none';
  document.getElementById('pg-favorites').className     = 'panel-page' + (name === 'favorites' ? ' active' : '');
  document.getElementById('pg-folders').className       = 'panel-page' + (name === 'folders'   ? ' active' : '');
  document.getElementById('pg-admin').className         = 'panel-page' + (name === 'admin'     ? ' active' : '');

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
  if (name === 'folders') loadFolders();
  if (name === 'admin') loadAdminData();
}

// ── Registry ──────────────────────────────────────────────────────────────
async function loadTable() {
  const tbody = document.getElementById('tblBody');
  if (!tbody.childElementCount) showSkeleton();

  try {
    const filters = getFilters();
    const data = await apiFetch('/api/declarations/producers' + buildQS(filters));
    renderTable(data);
  } catch (err) {
    showAlert(err.message, 'err');
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

  items.forEach(p => {
    const key = p.inn || p.name;
    if (key) State.producerDataCache.set(key, p);
  });

  document.getElementById('tblCount').textContent = (total || 0).toLocaleString('ru') + ' производителей';
  document.getElementById('pgNow').textContent = (page || 0) + 1;
  document.getElementById('pgOf').textContent  = pages || 1;
  document.getElementById('emptyState').style.display = total === 0 ? 'block' : 'none';

  const q = (document.getElementById('globalQ').value || '').trim();
  const hl = t => q
    ? (t||'').replace(new RegExp('('+q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+')','gi'),
        '<mark style="background:#FEF3C7;border-radius:2px;padding:0 1px">$1</mark>')
    : (t||'');

  const ftLabel = { farmer: '<span class="ft ft-farmer">Фермер</span>', trader: '<span class="ft ft-trader">Трейдер</span>', unknown: '' };

  tbody.innerHTML = (items || []).map((p, idx) => {
    const hasMany = p.decls.length > 1;
    const firstProduct = (p.decls[0]?.productName || '—').slice(0, 60);
    const badge = ftLabel[p.farmerType] || '';
    const innHint = p.inn ? `<span style="font-size:10px;color:var(--muted);display:block">ИНН: ${p.inn}</span>` : '';
    const isFav = isFavorite(p.inn, p.name);
    const safeInn = (p.inn||'').replace(/'/g,"\\'");
    const safeName = (p.name||'').replace(/'/g,"\\'").replace(/"/g,'&quot;');

    const subRows = p.decls.map(d => `
      <tr class="decl-sub-row" id="sub_${page}_${idx}_${d.id}" style="display:none">
        <td></td>
        <td style="padding-left:20px;font-size:12px;color:var(--muted);white-space:nowrap">${d.regDate||'—'}</td>
        <td style="font-size:12px" title="${(d.productName||'').replace(/"/g,'&quot;')}">${hl(d.productName||'—')}</td>
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
          <span class="comp-name-link" onclick="event.stopPropagation();openCompany('${safeInn}','${safeName}')">${hl(p.name)}${badge}</span>${innHint}
        </td>
        <td title="${(p.address||'').replace(/"/g,'&quot;')}" style="font-size:12px;color:var(--muted)">${hl(p.address||'—')}</td>
        <td style="font-size:12px" title="${firstProduct}">${hl(firstProduct)}${p.decls.length>1?' <span style="color:var(--muted)">+ещё '+(p.decls.length-1)+'</span>':''}</td>
        <td class="actions" style="text-align:center;display:flex;align-items:center;justify-content:center;gap:3px">
          <button class="star-btn ${isFav?'on':''}" onclick="event.stopPropagation();toggleFavorite('${safeInn}','${(p.name||'').replace(/'/g,"\\'").replace(/"/g,'&quot;')}',this)" title="${isFav?'Убрать из избранного':'Добавить в избранное'}">★</button>
          <button class="btn btn-sm" style="padding:2px 5px;font-size:12px" onclick="event.stopPropagation();addToFolder('${safeInn}','${(p.name||'').replace(/'/g,"\\'")}',this)" title="В папку">📁</button>
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
    document.getElementById('stActive').textContent = (s.active || 0).toLocaleString('ru');
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
    if (s.lastUpdated) {
      const d = new Date(s.lastUpdated);
      document.getElementById('stTime').textContent = 'Обновлено: ' + d.toLocaleString('ru-RU');
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

  document.getElementById('mapLoader').style.display = 'block';
  try {
    const data = await apiFetch('/api/declarations/map-data');
    State.mapAllCities = data.cities || [];
    renderMarkers(State.mapAllCities, data.total);
  } catch(e) {
    document.getElementById('mapLoader').textContent = 'Ошибка загрузки данных';
  } finally {
    document.getElementById('mapLoader').style.display = 'none';
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
      const label = d.product || 'Декларация';
      const safeId = d.id.replace(/'/g, '');
      return `<div onclick="mapOpenDecl('${safeId}')" style="cursor:pointer;padding:3px 8px;margin:2px 0;border-radius:4px;font-size:11px;color:#185FA5;background:#eef4ff;line-height:1.4" onmouseover="this.style.background='#d9e8ff'" onmouseout="this.style.background='#eef4ff'">${label}</div>`;
    }).join('');
    return `
      <div style="padding:7px 0;border-bottom:1px solid #f0f2f5">
        <div style="font-size:13px;font-weight:600;color:#1a1e27;margin-bottom:4px;white-space:normal">${o.name} <span style="font-weight:400;color:#6b7280">${o.count > 1 ? '(' + o.count + ')' : ''}</span></div>
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
    const safeVal = (item.value||'').replace(/'/g,"\\'");
    const isInn = item.type === 'inn';
    const isDecl = item.type === 'decl';
    const icon = isInn ? '🏢' : '📄';
    const displayName = item.label || item.value;
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

async function createFolderCtx() {
  const name = prompt(State.curFolderOpen ? 'Название подпапки:' : 'Название папки:');
  if (!name?.trim()) return;
  try {
    const body = { name: name.trim() };
    if (State.curFolderOpen) body.parentId = State.curFolderOpen;
    await apiFetch('/api/folders', { method: 'POST', body: JSON.stringify(body) });
    await loadFolders();
    if (State.curFolderOpen) openFolder(State.curFolderOpen, false);
  } catch(e) { showAlert(e.message, 'err'); }
}

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

async function addToFolder(inn, name) {
  if (!State.foldersCache.length) { showAlert('Сначала создайте папку', 'warn'); return; }
  const folderOpts = State.foldersCache.map((f, i) => `${i + 1}. ${f.name}`).join('\n');
  const idx = parseInt(prompt('Выберите папку:\n' + folderOpts)) - 1;
  if (isNaN(idx) || idx < 0 || idx >= State.foldersCache.length) return;

  const folder = State.foldersCache[idx];
  const type = inn ? 'inn' : 'name';
  try {
    await apiFetch('/api/folders/' + folder.id + '/items', {
      method: 'POST',
      body: JSON.stringify({ type, value: inn || name, label: name || (inn || name) })
    });
    showAlert('Добавлено');
  } catch(e) { showAlert(e.message, 'err'); }
}

async function addDeclToFolder(id, declNumber) {
  if (!State.foldersCache.length) { await loadFolders(); }
  if (!State.foldersCache.length) { showAlert('Сначала создайте папку', 'warn'); return; }
  const folderOpts = State.foldersCache.map((f, i) => `${i + 1}. ${f.name}`).join('\n');
  const idx = parseInt(prompt('Выберите папку:\n' + folderOpts)) - 1;
  if (isNaN(idx) || idx < 0 || idx >= State.foldersCache.length) return;

  const folder = State.foldersCache[idx];
  try {
    await apiFetch('/api/folders/' + folder.id + '/items', {
      method: 'POST',
      body: JSON.stringify({ type: 'decl', value: id, label: declNumber || id })
    });
    showAlert('Добавлено');
  } catch(e) { showAlert(e.message, 'err'); }
}

// ── Company Card ──────────────────────────────────────────────────────────
async function openCompany(inn, name) {
  const key = inn || name;
  document.getElementById('compModalName').textContent = name || inn || 'Загрузка...';
  document.getElementById('compModalSub').textContent = 'Загрузка...';
  document.getElementById('compModalBody').innerHTML = '<div class="empty"><p>Загрузка данных...</p></div>';
  document.getElementById('compModal').classList.add('open');

  try {
    const qs = inn ? '?inn=' + encodeURIComponent(inn) : '?name=' + encodeURIComponent(name);
    const p = await apiFetch('/api/business/company' + qs);
    renderCompanyModal(p, inn, name);
  } catch(e) {
    showAlert(e.message, 'err');
  }
}

function renderCompanyModal(p, inn, name) {
  const ftBadge = { farmer: '<span class="ft ft-farmer">Фермер</span>', trader: '<span class="ft ft-trader">Трейдер</span>' }[p.farmerType] || '<span class="ft ft-unknown">Не определён</span>';
  document.getElementById('compModalName').textContent = p.name || name || '—';
  document.getElementById('compModalSub').innerHTML = [
    p.inn ? 'ИНН: <b>' + p.inn + '</b>' : '',
    p.okved ? 'ОКВЭД: <b>' + p.okved + '</b>' : '',
  ].filter(Boolean).join(' &nbsp;·&nbsp; ');

  State.curCompDecls = p.decls || [];
  State.curCropTab = 'all';

  const fioStr = [p.lastName, p.firstName, p.middleName].filter(Boolean).join(' ');
  const safeDesc = (p.description||'').replace(/</g,'&lt;').replace(/"/g,'&quot;');
  const safeInn = (p.inn||'').replace(/'/g,"\\'");
  const safeName = (p.name||name||'').replace(/'/g,"\\'");

  document.getElementById('compModalBody').innerHTML = `
    <div id="compDescArea" style="margin-bottom:14px">
      <div id="compDescShow" style="cursor:pointer;padding:8px 12px;background:var(--surf2);border-radius:var(--r);border:1px solid var(--border);font-size:13px" onclick="editCompDesc()">${p.description ? safeDesc : '+ Добавить описание...'}</div>
      <div id="compDescEdit" style="display:none">
        <input id="compDescInput" type="text" class="fi" value="${safeDesc}">
        <div style="display:flex;gap:6px;margin-top:6px">
          <button class="btn btn-sm btn-p" onclick="saveCompanyDesc('${safeInn}','${safeName}')">Сохранить</button>
          <button class="btn btn-sm" onclick="cancelCompDesc()">Отмена</button>
        </div>
      </div>
    </div>
    <div class="dg" style="margin-bottom:18px">
      <div class="df"><div class="df-l">Тип</div><div class="df-v">${ftBadge}</div></div>
      <div class="df"><div class="df-l">Телефон</div><div class="df-v">${p.phone||'—'}</div></div>
      <div class="df full"><div class="df-l">ФИО</div><div class="df-v">${fioStr||'—'}</div></div>
      <div class="df full"><div class="df-l">Адрес</div><div class="df-v" style="font-size:12px">${p.address||'—'}</div></div>
    </div>
    <div class="dsec">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
        <h4 style="margin:0">Декларации (${(p.decls||[]).length})</h4>
        <select id="compPeriodSel" onchange="updateCropTabs()" class="btn btn-sm">
          <option value="all" selected>Всё время</option>
          <option value="0">Текущий год</option>
          <option value="1">Прошлый год</option>
        </select>
      </div>
      <div class="tab-strip" id="cropTabStrip"></div>
      <div id="cropTabContent"></div>
    </div>
    <div class="dsec">
      <h4>Заметки</h4>
      <textarea id="compNotes" class="fi" style="width:100%;height:60px">${p.notes||''}</textarea>
      <button class="btn btn-sm" style="margin-top:6px" onclick="saveCompanyNotes('${safeInn}','${safeName}')">💾 Сохранить</button>
    </div>`;

  updateCropTabs();

  const isFav = isFavorite(p.inn, p.name||name);
  document.getElementById('compModalFoot').innerHTML = `
    <button class="btn btn-sm" id="compFavBtn" onclick="toggleFavorite('${safeInn}','${safeName}',null)">${isFav?'★ В избранном':'☆ В избранное'}</button>
    <button class="btn btn-sm" onclick="addToFolder('${safeInn}','${safeName}')">📁 В папку</button>
    <button class="btn btn-p btn-sm" onclick="closeModal('compModal')">Закрыть</button>`;
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

async function saveCompanyNotes(inn, name) {
  const notes = document.getElementById('compNotes').value;
  try {
    await apiFetch('/api/business/company/notes', { method: 'PUT', body: JSON.stringify({ inn, name, notes }) });
    showAlert('Сохранено');
  } catch(e) { showAlert(e.message, 'err'); }
}

// ── Crop Classification ───────────────────────────────────────────────────
const CROPS = [
  { key:'пшеница', label:'Пшеница', re:/пшениц/i, ys:{m:5,d:25} },
  { key:'ячмень', label:'Ячмень', re:/ячмен/i, ys:{m:5,d:25} },
  { key:'кукуруза', label:'Кукуруза', re:/кукуруз/i, ys:{m:10,d:1} },
  { key:'подсолнечник', label:'Подсолнечник', re:/подсолнеч/i, ys:{m:9,d:1} },
  { key:'соя', label:'Соя', re:/\bсо[яи]\b|соев/i, ys:{m:9,d:1} },
  { key:'рапс', label:'Рапс', re:/рапс/i, ys:{m:7,d:1} },
  { key:'горох', label:'Горох', re:/горох|нут\b|чечевиц/i, ys:{m:7,d:1} },
];

function classifyProd(name) {
  for (const c of CROPS) if (c.re.test(name||'')) return c;
  return { key:'other', label:'Прочее', ys:{m:1,d:1} };
}

function updateCropTabs() {
  const period = document.getElementById('compPeriodSel')?.value || 'all';
  const groups = new Map();
  groups.set('all', { key:'all', label:'Все', decls:[...State.curCompDecls] });

  State.curCompDecls.forEach(d => {
    const c = classifyProd(d.productName);
    if (!groups.has(c.key)) groups.set(c.key, { key:c.key, label:c.label, decls:[] });
    groups.get(c.key).decls.push(d);
  });

  const strip = document.getElementById('cropTabStrip');
  if (!strip) return;

  strip.innerHTML = [...groups.values()].map(g => `
    <button class="tab-btn ${State.curCropTab === g.key ? 'active' : ''}" onclick="selectCropTab('${g.key}')">
      ${g.label} <span class="tab-badge">${g.decls.length}</span>
    </button>`).join('');

  const g = groups.get(State.curCropTab) || groups.get('all');
  const rows = (g.decls || []).map(d => `
    <tr>
      <td>${d.regDate||'—'}</td>
      <td>${d.declNumber||'—'}</td>
      <td>${(d.productName||'—').slice(0, 40)}</td>
      <td><button class="btn btn-sm" onclick="closeModal('compModal');openDetail('${d.id}')">↗</button></td>
    </tr>`).join('');

  document.getElementById('cropTabContent').innerHTML = `
    <div class="comp-decls tab-content">
      <table><thead><tr><th>Дата</th><th>Номер</th><th>Продукт</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4">Нет данных</td></tr>'}</tbody></table>
    </div>`;
}

function selectCropTab(key) {
  State.curCropTab = key;
  updateCropTabs();
}

// ── Detail Modal ──────────────────────────────────────────────────────────
async function openDetail(id) {
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
          ${r.okved ? `<div class="df"><div class="df-l">ОКВЭД</div><div class="df-v">${r.okved}</div></div>` : ''}
          ${r.farmerType && r.farmerType !== 'unknown' ? `<div class="df"><div class="df-l">Тип компании</div><div class="df-v">${r.farmerType === 'farmer' ? '<span class="ft ft-farmer">Фермер</span>' : '<span class="ft ft-trader">Трейдер</span>'}</div></div>` : ''}
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
    document.getElementById('detFoot').innerHTML = `
      <button class="btn btn-dng btn-sm" onclick="deleteCurrentDetail()">Удалить</button>
      <button class="btn btn-sm" onclick="closeModal('detModal');openAdd('${r.id}',State.detailRecord)">✎ Редактировать</button>
      <button class="btn btn-sm ${isFav?'':'btn-p'}" id="detFavBtn" onclick="toggleFavCurrentDetail()">${isFav?'★ В избранном':'☆ В избранное'}</button>
      <button class="btn btn-sm" onclick="addDeclToFolder('${r.id}','${(r.declNumber||'').replace(/'/g,"\\'").replace(/"/g,'&quot;')}')">📁 В папку</button>
      <button class="btn btn-p btn-sm" onclick="closeModal('detModal')">Закрыть</button>`;

    document.getElementById('detModal').classList.add('open');
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

// ── Settings ──────────────────────────────────────────────────────────────
async function openSettings() {
  try {
    const cfg = await apiFetch('/api/system/telegram-config');
    document.getElementById('tgBotToken').value = cfg.botToken || '';
    document.getElementById('tgChatId').value = cfg.chatId || '';
    document.getElementById('settingsModal').classList.add('open');
    refreshEnrichStatus();
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
    el.innerHTML = s.running ? `Работает: ${s.done}/${s.total}` : `Ожидает: ${s.pending}`;
    document.getElementById('enrichStartBtn').style.display = s.running ? 'none' : '';
    document.getElementById('enrichStopBtn').style.display = s.running ? '' : 'none';
  } catch(_) {}
}

async function startEnrich() {
  try {
    await apiFetch('/api/enrich/enrich', { method: 'POST' });
    refreshEnrichStatus();
  } catch(e) { showAlert(e.message, 'err'); }
}

async function stopEnrich() {
  await apiFetch('/api/enrich/enrich/stop', { method: 'POST' });
  refreshEnrichStatus();
}

// ── Modal helpers ─────────────────────────────────────────────────────────
function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('open');
}

// ── Add / Edit Record ─────────────────────────────────────────────────────
function openAdd(id, record) {
  State.editingId = id || null;
  document.getElementById('modalTitle').textContent = id ? 'Редактировать запись' : 'Добавить запись вручную';
  ['group','regDate','endDate','applicantName','lastName','firstName','middleName','shortName','address','phone','productName','batchSize','otherInfo'].forEach(f => {
    const el = document.getElementById('f_' + f);
    if (el) el.value = (record && record[f] != null) ? record[f] : '';
  });
  document.getElementById('addModal').classList.add('open');
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

['addModal','detModal','settingsModal','compModal','subscriptionModal'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', function(e) { if (e.target === this) closeModal(id); });
});

// ── Subscription ──────────────────────────────────────────────────────────
async function loadSubscriptionStatus() {
  try {
    const s = await apiFetch('/api/payment/subscription');
    const badge = document.getElementById('subBadge');
    const adminTab = document.getElementById('adminTab');

    if (s.isAdmin) {
      badge.style.display = 'none';
      if (adminTab) adminTab.style.display = '';
      return;
    }

    if (adminTab) adminTab.style.display = 'none';

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

  document.getElementById('subscriptionModal').classList.add('open');
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
    const [stats, users, payments] = await Promise.all([
      apiFetch('/api/admin/stats'),
      apiFetch('/api/admin/users'),
      apiFetch('/api/admin/payments'),
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
  loadFavsCache();
  loadStats();
  loadSubscriptionStatus();
  loadTable().catch(err => {
    if (err.message && err.message.includes('SUBSCRIPTION_REQUIRED')) {
      document.getElementById('noAccessModal').classList.add('open');
    }
  });
  pollStatus();
}

document.addEventListener('DOMContentLoaded', () => {
  checkAuth();
});
