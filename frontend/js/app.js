// ── App State ─────────────────────────────────────────────────────────────
const State = {
  token: localStorage.getItem('fsa_token') || null,
  user: JSON.parse(localStorage.getItem('fsa_user') || 'null'),
  curPage: 0,
  editingId: null,
  mapInstance: null,
  mapInitialized: false,
  mapPlaces: [],
  mapStats: null,
  mapPopup: null,
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
  currentPage: null,
  navIndex: -1,
  // Навигация по декларациям внутри карточки компании
  navDeclIds: [],
  navDeclIndex: -1,
  // Мои базы
  mydbPrivatePage: 0,
  mydbPreview: null,    // данные превью от сервера
  mydbMapping: {},      // colIdx → тип ('inn'|'name'|'phone'|'phone2'|'email'|'address'|'')
  mydbUploading: false, // блокировка повторной загрузки
};

// ── Date input mask (дд.мм.гггг ↔ ISO yyyy-mm-dd) ──────────────────────────
// Заменяет нативный <input type="date">, формат которого браузер показывает
// по своей локали (у части пользователей — mm/dd/yyyy) на текстовое поле с
// гарантированным российским форматом ввода.
function isoToRu(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}
function ruToIso(ru) {
  const m = String(ru || '').trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}
function attachDateMask(input) {
  input.addEventListener('input', () => {
    const digits = input.value.replace(/\D/g, '').slice(0, 8);
    let out = digits.slice(0, 2);
    if (digits.length > 2) out += '.' + digits.slice(2, 4);
    if (digits.length > 4) out += '.' + digits.slice(4, 8);
    input.value = out;
  });
}

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
  document.getElementById('loginForm').style.display        = tab === 'login'    ? '' : 'none';
  document.getElementById('registerForm').style.display     = tab === 'register' ? '' : 'none';
  document.getElementById('confirmEmailForm').style.display = tab === 'confirm'  ? '' : 'none';
  document.getElementById('authTosNote').style.display      = tab === 'register' ? '' : 'none';
  document.getElementById('tabLogin').classList.toggle('active', tab === 'login');
  document.getElementById('tabRegister').classList.toggle('active', tab === 'register' || tab === 'confirm');
  document.getElementById('loginError').style.display    = 'none';
  document.getElementById('registerError').style.display = 'none';
}

function goToConfirmEmail(email) {
  document.getElementById('confirmEmailAddr').textContent = email;
  document.getElementById('confirmCode').value = '';
  switchAuthTab('confirm');
}

const AUTH_ERRORS = {
  'Invalid credentials':            'Неверный логин или пароль',
  'Username and password are required': 'Заполните все поля',
  'Username already exists':        'Этот логин уже занят',
  'EMAIL_NOT_VERIFIED':             'Подтвердите почту — код отправлен при регистрации',
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
    // Без таймаута при подвисшем сервере кнопка просто висела на «Вход…».
    const data = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(20000),
    }).catch(err => {
      if (err.name === 'TimeoutError') throw new Error('Сервер долго не отвечает. Попробуйте ещё раз через минуту.');
      if (err instanceof TypeError) throw new Error('Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.');
      throw err;
    });
    State.token = data.token;
    State.user  = data.user;
    localStorage.setItem('fsa_token', data.token);
    localStorage.setItem('fsa_user', JSON.stringify(data.user));
    checkAuth();
  } catch (err) {
    if (err.message === 'EMAIL_NOT_VERIFIED') {
      goToConfirmEmail(username);
      btn.disabled = false;
      btn.textContent = 'Войти';
      return;
    }
    errorEl.textContent   = authMsg(err.message);
    errorEl.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Войти';
  }
}

async function handleRegister(e) {
  e.preventDefault();
  const email     = document.getElementById('regEmail').value.trim().toLowerCase();
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
  if (password.length < 8) {
    errorEl.textContent   = 'Пароль должен содержать минимум 8 символов';
    errorEl.style.display = 'block';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Регистрация…';

  try {
    await apiFetch('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) });
    goToConfirmEmail(email);
  } catch (err) {
    errorEl.textContent   = authMsg(err.message);
    errorEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Зарегистрироваться';
  }
}

async function handleConfirmEmail(e) {
  e.preventDefault();
  const email    = document.getElementById('confirmEmailAddr').textContent;
  const code     = document.getElementById('confirmCode').value.trim();
  const errorEl  = document.getElementById('confirmEmailError');
  const btn      = document.getElementById('confirmEmailBtn');

  errorEl.style.display = 'none';
  btn.disabled = true;
  btn.textContent = 'Проверка…';

  try {
    const data = await apiFetch('/api/auth/confirm-email', { method: 'POST', body: JSON.stringify({ email, code }) });
    State.token = data.token;
    State.user  = data.user;
    localStorage.setItem('fsa_token', data.token);
    localStorage.setItem('fsa_user', JSON.stringify(data.user));
    checkAuth();
  } catch (err) {
    errorEl.textContent   = authMsg(err.message);
    errorEl.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Подтвердить';
  }
}

async function handleResendCode() {
  const email = document.getElementById('confirmEmailAddr').textContent;
  const errorEl = document.getElementById('confirmEmailError');
  try {
    await apiFetch('/api/auth/resend-code', { method: 'POST', body: JSON.stringify({ email }) });
    errorEl.style.color = 'var(--succ)';
    errorEl.textContent = 'Код отправлен повторно';
    errorEl.style.display = 'block';
  } catch (err) {
    errorEl.style.color = '';
    errorEl.textContent = authMsg(err.message);
    errorEl.style.display = 'block';
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

  document.body.classList.toggle('logged-in', !!State.token);

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
  State.currentPage = name;
  document.body.classList.remove('nav-open');
  window.scrollTo(0, 0);
  document.getElementById('pg-home').className          = 'panel-page' + (name === 'home'      ? ' active' : '');
  document.getElementById('pg-company').className       = 'panel-page' + (name === 'company'   ? ' active' : '');
  document.getElementById('pg-registry').style.display  = name === 'registry'  ? '' : 'none';
  document.getElementById('pg-map').style.display       = name === 'map'       ? 'block' : 'none';
  document.getElementById('pg-favorites').className     = 'panel-page' + (name === 'favorites' ? ' active' : '');
  document.getElementById('pg-notes').className         = 'panel-page' + (name === 'notes'     ? ' active' : '');
  document.getElementById('pg-folders').className       = 'panel-page' + (name === 'folders'   ? ' active' : '');
  document.getElementById('pg-admin').className         = 'panel-page' + (name === 'admin'     ? ' active' : '');
  document.getElementById('pg-profile').className       = 'panel-page' + (name === 'profile'   ? ' active' : '');
  document.getElementById('pg-feedback').className      = 'panel-page' + (name === 'feedback'  ? ' active' : '');
  document.getElementById('pg-mydb').className          = 'panel-page' + (name === 'mydb'      ? ' active' : '');
  document.getElementById('pg-crm').className            = 'panel-page' + (name === 'crm'       ? ' active' : '');

  document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.page === name));

  const TITLES = {
    home: 'Главная', registry: 'Реестр', map: 'Карта', company: 'Компания', favorites: 'Избранные', folders: 'Папки',
    notes: 'Заметки', mydb: 'Мои базы', profile: 'Профиль', feedback: 'Поддержка',
    crm: 'Выгрузка в CRM', admin: 'Администрирование',
  };
  const titleEl = document.getElementById('pageTitle');
  if (titleEl) titleEl.textContent = TITLES[name] || '';

  if (name === 'map') {
    if (!State.mapInitialized) {
      State.mapInitialized = true;
      setTimeout(initMap, 150);
    } else if (State.mapInstance) {
      setTimeout(() => State.mapInstance.resize(), 50);
    }
  }

  if (name === 'home') loadHome();
  if (name === 'registry') loadRecentStrip();
  if (name === 'favorites') loadFavorites();
  if (name === 'notes') loadNotes();
  if (name === 'folders') loadFolders();
  if (name === 'admin') loadAdminData();
  if (name === 'profile') loadProfile();
  if (name === 'feedback') loadFeedback();
  if (name === 'mydb') loadMydbPage();
  if (name === 'crm') loadCrmPage();
}

// ── Registry ──────────────────────────────────────────────────────────────

// Живая лента: что появилось в реестре за последние минуты/часы — как у
// конкурента на главной, только без отдельного дашборда, тонкой полоской
// над таблицей. Тот же /recent используется слоем «Свежее» на карте.
function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} ${plural(min,'минуту','минуты','минут')} назад`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ${plural(h,'час','часа','часов')} назад`;
  const d = Math.floor(h / 24);
  return `${d} ${plural(d,'день','дня','дней')} назад`;
}

async function loadRecentStrip() {
  const wrap = document.getElementById('recentStrip');
  const itemsEl = document.getElementById('recentStripItems');
  if (!wrap || !itemsEl) return;
  try {
    const data = await apiFetch('/api/declarations/recent?limit=20');
    const items = data.items || [];
    if (!items.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'flex';
    itemsEl.innerHTML = items.map(it => {
      const place = [it.district, it.place].filter(Boolean).join(', ') || it.region || '';
      const vol = it.batchSize ? ' · ' + escHtml(it.batchSize) : '';
      return `<div onclick="openDetail('${it.id}')" style="flex:none;cursor:pointer;padding:4px 10px;background:var(--surface);border:1px solid var(--border);border-radius:999px;font-size:11.5px;white-space:nowrap" title="${escHtml(place)}">
        <b>${escHtml(it.productName)}</b>${vol}${place ? ' · ' + escHtml(place) : ''} · <span style="color:var(--muted)">${timeAgo(it.fetchedAt)}</span>
      </div>`;
    }).join('');
  } catch (_) { wrap.style.display = 'none'; }
}

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

// ── Фильтры реестра (правая выдвижная панель) ─────────────────────────────
// Состояние панели живёт здесь, в DOM только отрисовка: чипы над таблицей,
// счётчик на кнопке «Фильтры (N)» и сама панель строятся из одного объекта.
const FILTER_CROPS = [
  ['wheat', 'Пшеница'], ['barley', 'Ячмень'], ['corn', 'Кукуруза'], ['sunflower', 'Подсолнечник'],
  ['rapeseed', 'Рапс'], ['soy', 'Соя'], ['peas', 'Горох'], ['rye', 'Рожь'], ['oats', 'Овёс'],
  ['flax', 'Лён'], ['buckwheat', 'Гречиха'], ['millet', 'Просо'], ['sorghum', 'Сорго'],
  ['triticale', 'Тритикале'], ['chickpea', 'Нут'], ['lentil', 'Чечевица'], ['rice', 'Рис'], ['mustard', 'Горчица'],
];
const CROP_LABEL = Object.fromEntries(FILTER_CROPS);
const ROLE_LABEL = { farmer: 'Производители', trader: 'Трейдеры', processor: 'Переработчики' };
const STATUS_LABEL = { active: 'Действующие', archive: 'Архивные' };

const F = {
  regions: [], district: '', place: null, radius: '', radiusFrom: '', center: null,
  crops: [], harvest: '', volume: '', role: '', status: '',
};
const _dd = {};
const _optCache = new Map();

// «Ростовская обл» → «Ростовская область»: в справочнике НП регионы хранятся
// в сокращённой форме адреса ФИАС
function regionLabel(r) {
  return String(r || '')
    .replace(/^Респ (.+)$/, 'Республика $1')
    .replace(/ Респ$/, ' Республика')
    .replace(/ обл$/, ' область')
    .replace(/ АО$/, ' автономный округ')
    .replace(/^г /, 'г. ');
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

async function filterOptions(params) {
  const key = JSON.stringify(params);
  if (!_optCache.has(key)) {
    const p = apiFetch('/api/declarations/filter-options' + buildQS(params));
    _optCache.set(key, p);
    p.catch(() => _optCache.delete(key));
  }
  return _optCache.get(key);
}

// Центр радиуса: своё местоположение либо выбранный НП (если он геокодирован)
function radiusCenter() {
  if (!F.radiusFrom || !(Number(F.radius) > 0)) return null;
  if (F.radiusFrom === 'me') return F.center;
  if (F.place && F.place.lat != null) return { lat: F.place.lat, lon: F.place.lon };
  return null;
}

function volumeRange() {
  if (F.volume === 'custom') {
    return { min: document.getElementById('flBatchMin').value || '', max: document.getElementById('flBatchMax').value || '' };
  }
  return { min: F.volume, max: '' };
}

function getFilters() {
  const vol = volumeRange();
  const f = {
    page: State.curPage,
    size: document.getElementById('pgSize').value || 20,
    manufacturer: document.getElementById('csManuf').value || '',
    address: document.getElementById('csAddress').value || '',
    product: document.getElementById('csProduct').value || '',
    farmerType: F.role,
    status: F.status,
    crops: F.crops.join(','),
    harvest: F.harvest,
    batchMin: vol.min,
    batchMax: vol.max,
  };
  // Радиус заменяет регион/район/НП: «50 км от хутора» не должно обрезаться
  // границей области
  const c = radiusCenter();
  if (c) Object.assign(f, { lat: c.lat.toFixed(5), lon: c.lon.toFixed(5), radius: F.radius });
  else Object.assign(f, { regions: F.regions.join(','), district: F.district, place: F.place ? F.place.key : '' });
  return f;
}

function buildQS(p) {
  return '?' + Object.entries(p).filter(([,v]) => v !== '' && v != null).map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

function applyFilters() {
  State.curPage = 0;
  renderFilterState();
  const btn = document.getElementById('fltApplyBtn');
  if (btn) btn.textContent = 'Показать…';
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

const searchTerms = () => ['csManuf', 'csAddress', 'csProduct'].map(id => (document.getElementById(id).value || '').trim());

// Поиск срабатывает по «Найти»/Enter и сам — через паузу после ввода.
function onSearchInput() {
  renderFilterState();
  clearTimeout(_applyFiltersDebounceTimer);
  _applyFiltersDebounceTimer = setTimeout(applyFilters, 700);
}

function resetFilters() {
  Object.assign(F, { regions: [], district: '', place: null, radius: '', radiusFrom: '', center: null, crops: [], harvest: '', volume: '', role: '', status: '' });
  ['flBatchMin','flBatchMax','fRadius','csManuf','csAddress','csProduct'].forEach(id => document.getElementById(id).value = '');
  applyFilters();
}

function updateApplyBtn(total) {
  const btn = document.getElementById('fltApplyBtn');
  if (!btn) return;
  const n = total || 0;
  btn.textContent = `Показать ${n.toLocaleString('ru')} ${plural(n, 'компанию', 'компании', 'компаний')}`;
}

// ── Открытие / закрытие панели ──
function setFiltersOpen(open) {
  document.querySelector('#pg-registry .body').classList.toggle('fdr-open', open);
  document.getElementById('fltOpenBtn').classList.toggle('on', open);
  if (!open) Object.values(_dd).forEach(d => d.close());
  // На телефоне панель перекрывает таблицу — там её состояние не запоминаем
  if (window.innerWidth > 1024) { try { localStorage.setItem('filtersOpen', open ? '1' : '0'); } catch(_) {} }
}
function openFilters() { setFiltersOpen(true); }
function closeFilters() { setFiltersOpen(false); }
function toggleFilters() {
  setFiltersOpen(!document.querySelector('#pg-registry .body').classList.contains('fdr-open'));
}

// ── Выпадающий список с поиском (одиночный или множественный выбор) ──
function makeDD(el, o) {
  el.innerHTML = `
    <div class="dd-box"><div class="dd-val"></div>
      <svg class="dd-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M6 9l6 6 6-6"/></svg>
    </div>
    <div class="dd-pop" hidden>
      ${o.search ? '<input class="dd-q" placeholder="Поиск…" autocomplete="off">' : ''}
      <div class="dd-list"></div>
    </div>`;
  const box = el.querySelector('.dd-box'), pop = el.querySelector('.dd-pop');
  const list = el.querySelector('.dd-list'), q = el.querySelector('.dd-q');
  let items = [], seq = 0, t = null;

  async function fill() {
    const my = ++seq;
    list.innerHTML = '<div class="dd-empty">Загрузка…</div>';
    try {
      const r = await o.load(q ? q.value.trim().toLowerCase() : '');
      if (my !== seq) return;
      items = r;
      draw();
    } catch (e) {
      if (my === seq) list.innerHTML = `<div class="dd-empty">${escHtml(e.message)}</div>`;
    }
  }
  function draw() {
    const sel = o.selected();
    let html = o.multi ? '' : `<div class="dd-opt${sel.length ? '' : ' on'}" data-i="-1"><span>${escHtml(o.placeholder)}</span></div>`;
    html += items.map((it, i) => `<div class="dd-opt${sel.includes(it.v) ? ' on' : ''}" data-i="${i}">
      ${o.multi ? '<i class="dd-ck"></i>' : ''}<span>${escHtml(it.label)}${it.sub ? `<small>${escHtml(it.sub)}</small>` : ''}</span>
      ${it.count != null ? `<em>${Number(it.count).toLocaleString('ru')}</em>` : ''}</div>`).join('');
    if (!items.length) html += '<div class="dd-empty">Ничего не найдено</div>';
    list.innerHTML = html;
  }
  function render() {
    const v = el.querySelector('.dd-val');
    const sel = o.selected();
    const disabled = !!(o.disabled && o.disabled());
    el.classList.toggle('disabled', disabled);
    if (!sel.length) v.innerHTML = `<span class="dd-ph">${escHtml(disabled && o.disabledText ? o.disabledText : o.placeholder)}</span>`;
    else if (o.multi) v.innerHTML = sel.map(x => `<span class="dd-chip">${escHtml(o.labelOf(x))}<b data-rm="${escHtml(x)}" title="Убрать">×</b></span>`).join('');
    else v.innerHTML = `<span class="dd-one">${escHtml(o.labelOf(sel[0]))}</span>`;
  }
  function open() {
    Object.values(_dd).forEach(d => d !== api && d.close());
    el.classList.add('open'); pop.hidden = false;
    if (q) { q.value = ''; setTimeout(() => q.focus()); }
    fill();
  }
  function close() { el.classList.remove('open'); pop.hidden = true; }

  box.onclick = e => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { e.stopPropagation(); o.pick({ v: rm.dataset.rm }); return; }
    if (el.classList.contains('disabled')) return;
    pop.hidden ? open() : close();
  };
  list.onclick = e => {
    e.stopPropagation(); // draw() заменит e.target — иначе общий обработчик решит, что клик был снаружи
    const opt = e.target.closest('.dd-opt');
    if (!opt) return;
    const i = +opt.dataset.i;
    o.pick(i < 0 ? null : items[i]);
    if (o.multi) draw(); else close();
  };
  if (q) q.oninput = () => { clearTimeout(t); t = setTimeout(fill, o.remote ? 250 : 0); };
  const api = { el, render, close };
  return api;
}

document.addEventListener('click', e => {
  Object.values(_dd).forEach(d => !d.el.contains(e.target) && d.close());
});

function initFilters() {
  const localFilter = (arr, q) => q ? arr.filter(it => it.label.toLowerCase().includes(q)) : arr;
  const regionOpts = async () => (await filterOptions({})).regions
    .map(r => ({ v: r.v, label: regionLabel(r.v), count: r.count }));

  _dd.region = makeDD(document.getElementById('ddRegion'), {
    multi: true, search: true, placeholder: 'Все регионы',
    load: async q => localFilter(await regionOpts(), q),
    selected: () => F.regions,
    labelOf: regionLabel,
    pick: it => {
      if (!it) return;
      F.regions = F.regions.includes(it.v) ? F.regions.filter(x => x !== it.v) : [...F.regions, it.v];
      F.district = ''; F.place = null;
      applyFilters();
    },
  });
  _dd.district = makeDD(document.getElementById('ddDistrict'), {
    search: true, placeholder: 'Все районы', disabledText: 'Сначала выберите регион',
    disabled: () => !F.regions.length,
    load: async q => localFilter((await filterOptions({ regions: F.regions.join(',') })).districts
      .map(d => ({ v: d.v, label: d.v + ' р-н', count: d.count })), q),
    selected: () => F.district ? [F.district] : [],
    labelOf: v => v + ' р-н',
    pick: it => { F.district = it ? it.v : ''; F.place = null; applyFilters(); },
  });
  _dd.place = makeDD(document.getElementById('ddPlace'), {
    search: true, remote: true, placeholder: 'Все населённые пункты', disabledText: 'Сначала выберите регион',
    disabled: () => !F.regions.length,
    load: async q => (await filterOptions({ regions: F.regions.join(','), district: F.district, q })).places
      .map(p => ({ v: p.key, label: p.label, sub: F.district ? '' : (p.district ? p.district + ' р-н' : ''), count: p.count, raw: p })),
    selected: () => F.place ? [F.place.key] : [],
    labelOf: () => F.place ? F.place.label : '',
    pick: it => {
      F.place = it ? { key: it.v, label: it.label, lat: it.raw.lat, lon: it.raw.lon } : null;
      applyFilters();
    },
  });
  _dd.crops = makeDD(document.getElementById('ddCrops'), {
    multi: true, search: true, placeholder: 'Любая продукция',
    load: async q => localFilter(FILTER_CROPS.map(([v, label]) => ({ v, label })), q),
    selected: () => F.crops,
    labelOf: v => CROP_LABEL[v] || v,
    pick: it => {
      if (!it) return;
      F.crops = F.crops.includes(it.v) ? F.crops.filter(x => x !== it.v) : [...F.crops, it.v];
      applyFilters();
    },
  });

  // Урожай: текущий год и три предыдущих
  const y = new Date().getFullYear();
  document.getElementById('segHarvest').innerHTML = ['', y, y - 1, y - 2, y - 3]
    .map(v => `<button data-v="${v}">${v || 'Все'}</button>`).join('');

  const bindSeg = (id, key) => document.getElementById(id).addEventListener('click', e => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    F[key] = b.dataset.v;
    applyFilters();
  });
  bindSeg('segHarvest', 'harvest');
  bindSeg('segVolume', 'volume');
  bindSeg('rgRole', 'role');
  bindSeg('segStatus', 'status');
  document.getElementById('segRadiusFrom').addEventListener('click', e => {
    const b = e.target.closest('button[data-v]');
    if (b) setRadiusFrom(b.dataset.v);
  });
  document.getElementById('segRadiusKm').addEventListener('click', e => {
    const b = e.target.closest('button[data-v]');
    if (b) setRadiusKm(b.dataset.v);
  });

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyK' && State.currentPage === 'registry') {
      e.preventDefault();
      document.getElementById('csManuf').focus();
    } else if (e.key === 'Escape' && document.querySelector('#pg-registry .body.fdr-open')) {
      const anyOpen = Object.values(_dd).some(d => d.el.classList.contains('open'));
      if (anyOpen) Object.values(_dd).forEach(d => d.close());
      else closeFilters();
    }
  });

  let saved = null;
  try { saved = localStorage.getItem('filtersOpen'); } catch(_) {}
  setFiltersOpen(window.innerWidth > 1024 && (saved === '1' || (saved === null && window.innerWidth > 1280)));
  renderFilterState();
}

function setVolume(v) {
  F.volume = F.volume === v ? '' : v;
  applyFilters();
}
function onVolumeRange() { applyFiltersDebounced(); }

function onRadiusInput() {
  const v = document.getElementById('fRadius').value;
  F.radius = v && Number(v) > 3000 ? '3000' : v;
  renderFilterState();
  applyFiltersDebounced();
}

// Откуда считать радиус: '' — не искать по радиусу, 'place' — от выбранного
// населённого пункта, 'me' — от местоположения пользователя (геолокация браузера).
function setRadiusFrom(v) {
  F.radiusFrom = v;
  if (v && !(Number(F.radius) > 0)) { F.radius = '50'; document.getElementById('fRadius').value = '50'; }
  if (v === 'me' && !F.center) return locateMe();
  applyFilters();
}

function setRadiusKm(km) {
  F.radius = km;
  document.getElementById('fRadius').value = km;
  applyFilters();
}

function locateMe() {
  if (!navigator.geolocation) {
    F.radiusFrom = '';
    renderFilterState();
    return showAlert('Браузер не умеет определять местоположение', 'err');
  }
  renderFilterState();
  navigator.geolocation.getCurrentPosition(pos => {
    F.center = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    applyFilters();
  }, () => {
    F.radiusFrom = '';
    renderFilterState();
    showAlert('Не удалось определить местоположение — разрешите доступ к геопозиции в настройках браузера', 'err');
  }, { timeout: 10000, maximumAge: 600000 });
}

// Чипы над таблицей: у каждого своя «отмена» одного условия
function activeFilterChips() {
  const chips = [];
  const center = radiusCenter();
  if (!center) {
    F.regions.forEach(r => chips.push([regionLabel(r), () => { F.regions = F.regions.filter(x => x !== r); F.district = ''; F.place = null; }]));
    if (F.district) chips.push([F.district + ' р-н', () => { F.district = ''; F.place = null; }]);
    if (F.place) chips.push([F.place.label, () => { F.place = null; }]);
  } else {
    chips.push([`${F.radius} км от ${F.radiusFrom === 'me' ? 'вас' : F.place.label}`, () => { F.radiusFrom = ''; }]);
  }
  F.crops.forEach(c => chips.push([CROP_LABEL[c], () => { F.crops = F.crops.filter(x => x !== c); }]));
  if (F.harvest) chips.push(['Урожай ' + F.harvest, () => { F.harvest = ''; }]);
  const vol = volumeRange();
  if (vol.min || vol.max) {
    const fmt = n => Number(n).toLocaleString('ru');
    const label = vol.min && vol.max ? `Объём ${fmt(vol.min)}–${fmt(vol.max)} т`
      : vol.min ? `Объём > ${fmt(vol.min)} т` : `Объём до ${fmt(vol.max)} т`;
    chips.push([label, () => { F.volume = ''; document.getElementById('flBatchMin').value = ''; document.getElementById('flBatchMax').value = ''; }]);
  }
  if (F.role) chips.push([ROLE_LABEL[F.role], () => { F.role = ''; }]);
  if (F.status) chips.push([STATUS_LABEL[F.status], () => { F.status = ''; }]);
  return chips;
}

let _chipActions = [];
function removeFilterChip(i) {
  const fn = _chipActions[i];
  if (fn) { fn(); applyFilters(); }
}

// Подсказка у звёздочки должна соответствовать новому состоянию.
function syncStarTip(btn, on) {
  if (!btn || !btn.classList.contains('star-btn')) return;
  btn.dataset.tip = on ? 'В избранном. Нажмите, чтобы убрать' : 'В избранное — компания будет под рукой в разделе «Избранное»';
  btn.setAttribute('aria-label', on ? 'Убрать из избранного' : 'Добавить в избранное');
}

function renderFilterState() {
  Object.values(_dd).forEach(d => d.render());
  const setSeg = (id, v) => document.querySelectorAll(`#${id} button[data-v]`)
    .forEach(b => b.classList.toggle('on', b.dataset.v === String(v)));
  setSeg('segHarvest', F.harvest);
  setSeg('segVolume', F.volume);
  setSeg('rgRole', F.role);
  setSeg('segStatus', F.status);
  document.getElementById('segVolumeOwn').classList.toggle('on', F.volume === 'custom');
  document.getElementById('fVolRange').hidden = F.volume !== 'custom';

  setSeg('segRadiusFrom', F.radiusFrom);
  setSeg('segRadiusKm', F.radius);
  document.getElementById('fRadiusBox').hidden = !F.radiusFrom;
  const hint = document.getElementById('fRadiusHint');
  const km = Number(F.radius) > 0 ? `${Number(F.radius).toLocaleString('ru')} км` : '';
  if (!F.radiusFrom) hint.textContent = 'Например, все хозяйства в 100 км от элеватора — выберите «От пункта» или «От меня».';
  else if (!km) hint.textContent = 'Укажите радиус в километрах.';
  else if (F.radiusFrom === 'me') hint.textContent = F.center
    ? `Ищем в ${km} от вашего текущего местоположения (по данным браузера). Регион при этом не ограничивает поиск.`
    : 'Определяем ваше местоположение — разрешите доступ в браузере…';
  else if (!F.place) hint.textContent = 'Выберите выше регион и населённый пункт — радиус посчитаем от него.';
  else if (F.place.lat == null) hint.textContent = `У пункта «${F.place.label}» пока нет координат — выберите соседний.`;
  else hint.textContent = `Ищем в ${km} от: ${F.place.label}. Регион при этом не ограничивает поиск.`;

  const chips = activeFilterChips();
  _chipActions = chips.map(c => c[1]);
  document.getElementById('fltChips').innerHTML = chips.map(([label], i) =>
    `<span class="fchip">${escHtml(label)}<button onclick="removeFilterChip(${i})" title="Убрать">×</button></span>`).join('');
  document.getElementById('fltCount').textContent = chips.length ? ` (${chips.length})` : '';
  document.getElementById('fltResetAll').hidden = !chips.length;
  // Ряд под поиском показываем, только когда есть что показать: условия
  // фильтров или текст поиска (тогда и «Следить за новыми» имеет смысл).
  const hasSearch = searchTerms().some(Boolean);
  document.getElementById('fchipsRow').hidden = !chips.length && !hasSearch;
  document.getElementById('sbarClear').hidden = !hasSearch;
}

// ── «Следить за новыми» (сохранённый поиск с уведомлениями в MAX) ──
function currentWatchFilter() {
  const [manufacturer, address, product] = searchTerms();
  const vol = volumeRange();
  return {
    manufacturer, address, product,
    farmerType: ['farmer', 'trader'].includes(F.role) ? F.role : '',
    regions: radiusCenter() ? [] : F.regions,
    district: radiusCenter() ? '' : F.district,
    place: radiusCenter() || !F.place ? '' : F.place.key,
    placeLabel: radiusCenter() || !F.place ? '' : F.place.label,
    crops: F.crops,
    batchMin: vol.min, batchMax: vol.max,
  };
}

async function openWatchModal() {
  const f = currentWatchFilter();
  const parts = savedSearchParts(f);
  document.getElementById('watchSummary').innerHTML = parts.length
    ? parts.map(p => `<span class="fchip">${escHtml(p)}</span>`).join('')
    : '<span style="color:var(--muted)">Без условий — все новые декларации</span>';
  const skipped = [];
  if (radiusCenter()) skipped.push('радиус от точки');
  if (F.harvest) skipped.push('год урожая');
  if (F.status) skipped.push('статус компании');
  if (F.role === 'processor') skipped.push('роль «переработчики»');
  if (skipped.length) {
    document.getElementById('watchSummary').insertAdjacentHTML('beforeend',
      `<div style="font-size:12px;color:var(--muted);margin-top:6px;width:100%">Не учитываются при слежении: ${escHtml(skipped.join(', '))}</div>`);
  }
  document.getElementById('watchName').value = parts.slice(0, 2).join(', ').slice(0, 100);
  const note = document.getElementById('watchMaxNote');
  note.hidden = true;
  openModal('watchModal');
  try {
    const me = await apiFetch('/api/auth/me');
    if (!me.maxLinked) {
      note.innerHTML = 'Мессенджер MAX ещё не привязан — уведомления начнут приходить после привязки в <a href="#" onclick="closeModal(\'watchModal\');showPage(\'profile\');return false">Профиле</a>.';
      note.hidden = false;
    }
  } catch (_) {}
}

async function saveWatch() {
  const btn = document.getElementById('watchSaveBtn');
  const name = document.getElementById('watchName').value.trim() || 'Реестр';
  btn.disabled = true;
  try {
    await apiFetch('/api/saved-searches', { method: 'POST', body: JSON.stringify({ name, filter: currentWatchFilter() }) });
    closeModal('watchModal');
    showAlert('Готово — пришлём сообщение в MAX, когда появятся новые декларации');
  } catch (e) { showAlert(e.message, 'err'); }
  finally { btn.disabled = false; }
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

  document.getElementById('tblCount').textContent = 'Найдено ' + (total || 0).toLocaleString('ru') + ' ' + plural(total || 0, 'компания', 'компании', 'компаний');
  updateApplyBtn(total);
  document.getElementById('pgNow').textContent = (page || 0) + 1;
  document.getElementById('pgOf').textContent  = pages || 1;
  document.getElementById('emptyState').style.display = total === 0 ? 'block' : 'none';

  const q = '';
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
          <span class="comp-name-link" onclick="event.stopPropagation();openCompany('${safeInn}','${safeName}')">${hl(fmtCompany(p.name), _csManuf)}${badge}${dormantBadge}</span>${innHint}
        </td>
        <td title="${(p.address||'').replace(/"/g,'&quot;')}" style="font-size:12px;color:var(--muted)">${hl(p.address||'—', _csAddr)}</td>
        <td style="font-size:12px" title="${firstProduct}">${cropChip(firstProduct)}${hl(firstProduct, _csProd)}${p.decls.length>1?' <span style="color:var(--muted)">+ещё '+(p.decls.length-1)+'</span>':''}</td>
        <td class="actions" style="text-align:center;display:flex;align-items:center;justify-content:center;gap:3px">
          <button class="star-btn ${isFav?'on':''}" onclick="event.stopPropagation();toggleFavorite('${safeInn}','${(p.name||'').replace(/'/g,"\\'").replace(/"/g,'&quot;')}',this)" aria-label="${isFav?'Убрать из избранного':'Добавить в избранное'}" data-tip="${isFav?'В избранном. Нажмите, чтобы убрать':'В избранное — компания будет под рукой в разделе «Избранное»'}">★</button>
          ${p.decls.length === 1
            ? `<button class="btn btn-sm" style="padding:2px 7px;font-size:11px" onclick="event.stopPropagation();openDetail('${p.decls[0].id}')" data-tip="Открыть декларацию">↗</button>`
            : `<span style="background:var(--acl);color:var(--accent);padding:2px 8px;border-radius:12px;font-size:12px;font-weight:600" data-tip="Деклараций у компании — нажмите на строку, чтобы раскрыть">${p.decls.length}</span>`}
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
// ── Главная ───────────────────────────────────────────────────────────────
async function loadHome() {
  drawHomeHero();
  try {
    const s = await apiFetch('/api/system/stats');
    document.getElementById('hmTotal').textContent   = (s.total || 0).toLocaleString('ru');
    document.getElementById('hmDecls').textContent   = (s.totalDecls || 0).toLocaleString('ru');
    document.getElementById('hmFarmers').textContent = (s.farmerProducers || 0).toLocaleString('ru');
    document.getElementById('hmTraders').textContent = (s.traderProducers || 0).toLocaleString('ru');
  } catch (_) {}

  initDynamics();
  loadDynamics(false);

  try {
    const d = await apiFetch('/api/system/home');
    renderHomeRegions(d.topRegions || []);
  } catch (_) {
    document.getElementById('hmRegions').innerHTML = '<div class="home-skel">Не удалось загрузить</div>';
  }

  try {
    const recent = await apiFetch('/api/declarations/recent?limit=6');
    const list = document.getElementById('hmRecent');
    const items = recent.items || [];
    list.innerHTML = items.length ? items.map(r => {
      const place = [r.district, r.place].filter(Boolean).join(', ') || r.region || '';
      const sub = [r.productName, r.batchSize, place].filter(Boolean).join(' · ');
      const open = r.inn
        ? `openCompany('${escHtml(r.inn)}','${escHtml((r.shortName || '').replace(/'/g, "\\'"))}')`
        : `openDetail('${escHtml(r.id)}')`;
      return `
      <div class="item home-recent" onclick="${open}">
        <div style="flex:1;min-width:0">
          <div class="home-recent-name">${escHtml(fmtCompany(r.shortName || r.applicantName || 'Без названия'))}</div>
          <div class="home-recent-sub">${escHtml(sub)}</div>
        </div>
        <div class="home-recent-time">${timeAgo(r.fetchedAt)}</div>
      </div>`;
    }).join('') : '<div class="home-skel">Пока пусто</div>';
  } catch (e) {
    document.getElementById('hmRecent').innerHTML = `<div class="home-skel">${e.message === 'SUBSCRIPTION_REQUIRED' ? 'Доступно с подпиской' : 'Не удалось загрузить'}</div>`;
  }
}

function renderHomeRegions(rows) {
  const el = document.getElementById('hmRegions');
  if (!rows.length) { el.innerHTML = '<div class="home-skel">Регионы ещё не размечены</div>'; return; }
  const max = rows[0].count || 1;
  el.innerHTML = rows.map(r => `
    <div class="home-region">
      <span class="home-region-name" title="${escHtml(r.region)}">${escHtml(r.region)}</span>
      <span class="home-region-bar"><i style="width:${Math.max(4, Math.round(r.count / max * 100))}%"></i></span>
      <span class="home-region-val">${(r.count || 0).toLocaleString('ru')}</span>
    </div>`).join('');
}

// Закат над полем — тот же мотив, что на экране входа, но пропорции считаются
// от высоты баннера, иначе облака и колосья выходят в несколько раз крупнее.
function drawHomeHero() {
  const cv = document.getElementById('homeHeroCanvas');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  cv.width = cv.offsetWidth || 900;
  cv.height = cv.offsetHeight || 190;
  const w = cv.width, h = cv.height, horizon = h * 0.56;

  const sky = ctx.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, '#123040'); sky.addColorStop(0.45, '#3a6b66');
  sky.addColorStop(0.78, '#b9723c'); sky.addColorStop(1, '#efb455');
  ctx.fillStyle = sky; ctx.fillRect(0, 0, w, horizon);

  const sx = w * 0.76, sy = horizon - h * 0.06, r = h * 0.11;
  const glow = ctx.createRadialGradient(sx, sy, r * 0.4, sx, sy, r * 5);
  glow.addColorStop(0, 'rgba(255,214,130,0.55)'); glow.addColorStop(1, 'rgba(255,214,130,0)');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, w, horizon);
  ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,233,170,0.92)'; ctx.fill();

  const field = ctx.createLinearGradient(0, horizon, 0, h);
  field.addColorStop(0, '#a9873a'); field.addColorStop(0.4, '#6f7a30'); field.addColorStop(1, '#20341f');
  ctx.fillStyle = field; ctx.fillRect(0, horizon, w, h - horizon);

  ctx.save();
  ctx.beginPath(); ctx.rect(0, horizon, w, h - horizon); ctx.clip();
  for (let i = -6; i <= 14; i++) {
    ctx.strokeStyle = 'rgba(232,190,110,0.12)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(sx, horizon); ctx.lineTo(sx + i * w * 0.13, h); ctx.stroke();
  }
  ctx.restore();

  const fade = ctx.createLinearGradient(0, 0, w * 0.62, 0);
  fade.addColorStop(0, 'rgba(2,26,22,0.94)'); fade.addColorStop(0.55, 'rgba(2,26,22,0.72)');
  fade.addColorStop(1, 'rgba(2,26,22,0)');
  ctx.fillStyle = fade; ctx.fillRect(0, 0, w * 0.62, h);
}

// ── Динамика деклараций ───────────────────────────────────────────────────
// Данные — /api/system/dynamics (кэш на минуту). Пока открыта главная и вкладка
// видна, опрашиваем раз в минуту: живой парсер доливает текущий день каждые
// 30 минут, и новые декларации появляются на графике без перезагрузки.
// Цвета производителей/трейдеров прогнаны через валидатор палитры (различимы
// и при дальтонизме); «прочие» — нейтральный серый.
const DYN_COLORS = { farmer: '#119068', trader: '#b9730c', other: '#c3cecc', prev: '#8a9897' };
const DYN_MON = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const DYN_MON_FULL = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const DYN_MON_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const DYN_MON_DAT = ['январю', 'февралю', 'марту', 'апрелю', 'маю', 'июню', 'июлю', 'августу', 'сентябрю', 'октябрю', 'ноябрю', 'декабрю'];
const DYN_WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const Dyn = { data: null, range: 'days', series: [], hover: -1, geo: null, anim: 1, inited: false, lastToday: null, bumpTimer: null };

const dynNum = n => (n || 0).toLocaleString('ru');
const dynDate = s => new Date(s + 'T00:00:00Z');
const dynIso = d => d.toISOString().slice(0, 10);

function initDynamics() {
  if (Dyn.inited) return;
  Dyn.inited = true;
  document.querySelectorAll('.dyn-seg button').forEach(b => b.addEventListener('click', () => {
    Dyn.range = b.dataset.range;
    document.querySelectorAll('.dyn-seg button').forEach(x => {
      x.classList.toggle('act', x === b);
      x.setAttribute('aria-selected', x === b ? 'true' : 'false');
    });
    Dyn.hover = -1;
    hideDynTip();
    drawDynChart(true);
  }));
  const cv = document.getElementById('homeChart');
  cv.addEventListener('pointermove', onDynHover);
  cv.addEventListener('pointerleave', () => { Dyn.hover = -1; hideDynTip(); paintDyn(); });
  let rt;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { if (State.currentPage === 'home' && Dyn.data) drawDynChart(false); }, 150);
  });
  setInterval(() => {
    if (State.currentPage === 'home' && !document.hidden) loadDynamics(true);
  }, 60000);
  setInterval(renderDynUpdated, 20000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && State.currentPage === 'home') loadDynamics(true);
  });
}

async function loadDynamics(silent) {
  try {
    const d = await apiFetch('/api/system/dynamics');
    const prevToday = Dyn.lastToday;
    Dyn.data = d;
    renderDynKpis(silent ? prevToday : null);
    renderDynUpdated();
    drawDynChart(!silent);
  } catch (_) {
    if (!silent) document.getElementById('dynUpdated').textContent = 'не удалось загрузить';
  }
}

// 30 дней подряд, включая дни без деклараций (выходные и праздники — нули, не дыры).
function dynDaySeries() {
  const d = Dyn.data, byDate = {};
  (d.days || []).forEach(r => { byDate[r.date] = r; });
  const end = dynDate(d.today), out = [];
  for (let i = 29; i >= 0; i--) {
    const dt = new Date(end.getTime() - i * 86400000), r = byDate[dynIso(dt)] || {};
    const total = r.total || 0, farmer = r.farmer || 0, trader = r.trader || 0;
    out.push({
      total, farmer, trader, other: Math.max(0, total - farmer - trader),
      wd: dt.getUTCDay(), day: dt.getUTCDate(), mon: dt.getUTCMonth(), isNow: i === 0,
    });
  }
  return out;
}

// 12 месяцев до текущего + те же месяцы годом раньше для сравнения.
function dynMonthSeries() {
  const d = Dyn.data, byYm = {};
  (d.months || []).forEach(r => { byYm[r.ym] = r.total; });
  const [y, m] = d.today.split('-').map(Number), out = [];
  const ym = (yy, mm) => `${yy}-${String(mm + 1).padStart(2, '0')}`;
  for (let i = 11; i >= 0; i--) {
    const dt = new Date(Date.UTC(y, m - 1 - i, 1)), yy = dt.getUTCFullYear(), mm = dt.getUTCMonth();
    out.push({ total: byYm[ym(yy, mm)] || 0, prev: byYm[ym(yy - 1, mm)] || 0, year: yy, mon: mm, isNow: i === 0 });
  }
  return out;
}

function dynDelta(cur, prev, suffix) {
  if (!prev) return '';
  const p = Math.round((cur - prev) / prev * 100);
  if (p === 0) return `на уровне ${suffix.replace(/^к /, '')}`;
  return `<span class="${p > 0 ? 'up' : 'down'}"><b>${p > 0 ? '▲' : '▼'} ${Math.abs(p)}%</b></span> ${suffix}`;
}

function renderDynKpis(prevToday) {
  const d = Dyn.data, days = dynDaySeries();
  const today = days[days.length - 1], full = days.slice(0, -1);
  const isWeekend = wd => wd === 0 || wd === 6;

  // «Обычный день» — среднее по таким же дням (будни или выходные) за прошлые 4 недели.
  const same = full.filter(x => isWeekend(x.wd) === isWeekend(today.wd));
  const avg = same.length ? Math.round(same.reduce((s, x) => s + x.total, 0) / same.length) : 0;
  const elToday = document.getElementById('dynToday'), elTodayD = document.getElementById('dynTodayD');
  elToday.textContent = dynNum(today.total);
  if (prevToday != null && today.total > prevToday) {
    // Парсер долил новые декларации, пока страница была открыта — показываем прирост.
    elTodayD.innerHTML = `<span class="up"><b>+${dynNum(today.total - prevToday)}</b></span> только что`;
    elToday.classList.add('bump');
    clearTimeout(Dyn.bumpTimer);
    Dyn.bumpTimer = setTimeout(() => { elToday.classList.remove('bump'); renderDynKpis(null); }, 20000);
  } else if (prevToday == null || !elToday.classList.contains('bump')) {
    elTodayD.textContent = avg ? `обычно ≈ ${dynNum(avg)} в ${isWeekend(today.wd) ? 'выходной' : 'будний день'}` : '';
  }
  Dyn.lastToday = today.total;

  // Неделя — по полным дням (без сегодняшнего, он ещё идёт), иначе сравнение
  // с прошлой неделей всегда выходило бы в минус.
  const week = full.slice(-7).reduce((s, x) => s + x.total, 0);
  const prevWeek = full.slice(-14, -7).reduce((s, x) => s + x.total, 0);
  const elWeek = document.getElementById('dynWeek');
  elWeek.textContent = dynNum(week);
  elWeek.title = 'Последние 7 полных дней, без сегодняшнего';
  document.getElementById('dynWeekD').innerHTML = dynDelta(week, prevWeek, 'к прошлой неделе');

  const months = dynMonthSeries(), cur = months[months.length - 1];
  document.getElementById('dynMonth').textContent = dynNum(cur.total);
  document.getElementById('dynMonthD').innerHTML = dynDelta(cur.total, d.lastYearMtd, `к ${DYN_MON_DAT[cur.mon]} ${cur.year - 1}`);
}

function dynAgo(date) {
  const min = Math.round((Date.now() - date.getTime()) / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  if (min < 24 * 60) return `${Math.floor(min / 60)} ч назад`;
  return date.toLocaleDateString('ru');
}

function renderDynUpdated() {
  const d = Dyn.data;
  if (!d) return;
  const live = document.getElementById('dynLive'), el = document.getElementById('dynUpdated');
  // updatedAt — CURRENT_TIMESTAMP SQLite, т.е. UTC без пометки зоны.
  const upd = d.lastUpdated ? new Date(d.lastUpdated.replace(' ', 'T') + 'Z') : null;
  const stale = !upd || Date.now() - upd.getTime() > 3 * 3600 * 1000;
  live.classList.toggle('stale', stale);
  const state = d.parser && d.parser.state === 'running' ? 'Идёт сбор новых деклараций' : 'В реальном времени';
  el.textContent = `${stale ? 'Нет свежих данных' : state} · обновлено ${upd ? dynAgo(upd) : '—'}`;
}

function renderDynLegend() {
  const items = Dyn.range === 'days'
    ? [['Производители', DYN_COLORS.farmer], ['Трейдеры', DYN_COLORS.trader], ['Прочие', DYN_COLORS.other]]
    : [['Последние 12 месяцев', DYN_COLORS.farmer], ['Год назад', null]];
  const el = document.getElementById('dynLegend');
  el.innerHTML = '';
  items.forEach(([label, color]) => {
    const s = document.createElement('span'), i = document.createElement('i');
    if (color) i.style.background = color; else i.className = 'ln';
    s.append(i, document.createTextNode(label));
    el.append(s);
  });
}

function drawDynChart(animate) {
  if (!Dyn.data) return;
  Dyn.series = Dyn.range === 'days' ? dynDaySeries() : dynMonthSeries();
  const empty = !Dyn.series.some(x => x.total || x.prev);
  document.getElementById('dynChartBox').hidden = empty;
  document.getElementById('hmChartEmpty').hidden = !empty;
  if (empty) return;
  renderDynLegend();
  if (!animate) { Dyn.anim = 1; paintDyn(); return; }
  const t0 = performance.now();
  const step = now => {
    const t = Math.min(1, (now - t0) / 600);
    Dyn.anim = 1 - Math.pow(1 - t, 3);
    paintDyn();
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function dynNiceScale(max) {
  const raw = max / 4, pow = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const step = [1, 2, 2.5, 5, 10].map(k => k * pow).find(s => s >= raw) || raw;
  return { top: step * 4, step };
}

function dynMonotonePath(ctx, p) {
  const n = p.length;
  if (n < 2) return;
  const d = [], m = [];
  for (let i = 0; i < n - 1; i++) d.push((p[i + 1][1] - p[i][1]) / (p[i + 1][0] - p[i][0]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  ctx.moveTo(p[0][0], p[0][1]);
  for (let i = 0; i < n - 1; i++) {
    const h = (p[i + 1][0] - p[i][0]) / 3;
    ctx.bezierCurveTo(p[i][0] + h, p[i][1] + m[i] * h, p[i + 1][0] - h, p[i + 1][1] - m[i + 1] * h, p[i + 1][0], p[i + 1][1]);
  }
}

function dynRoundTop(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  ctx.beginPath();
  ctx.moveTo(x, y + h); ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
  ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r); ctx.lineTo(x + w, y + h);
  ctx.closePath(); ctx.fill();
}

function paintDyn() {
  const cv = document.getElementById('homeChart'), box = document.getElementById('dynChartBox');
  if (!cv || !Dyn.series.length) return;
  const dpr = window.devicePixelRatio || 1, W = box.clientWidth, H = box.clientHeight;
  if (!W || !H) return;
  // Канвас в физических пикселях — иначе на ретине и при масштабе 125% график мылится.
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const S = Dyn.series, isDays = Dyn.range === 'days', n = S.length;
  const padL = 48, padR = 6, padT = 8, padB = 24;
  const { top, step } = dynNiceScale(Math.max(1, ...S.map(x => Math.max(x.total, x.prev || 0))));
  const plotH = H - padT - padB, colW = (W - padL - padR) / n;
  const y = v => padT + plotH * (1 - v / top);
  Dyn.geo = { padL, colW, n, W };

  ctx.font = '11px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let v = 0; v <= top + 1e-9; v += step) {
    const yy = Math.round(y(v)) + 0.5;
    ctx.strokeStyle = v === 0 ? 'rgba(0,0,0,0.16)' : 'rgba(0,0,0,0.06)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke();
    ctx.fillStyle = '#8a9897';
    ctx.fillText(v >= 10000 ? `${(v / 1000).toLocaleString('ru')} тыс` : dynNum(v), padL - 8, yy);
  }

  if (Dyn.hover >= 0) {
    ctx.fillStyle = 'rgba(7,92,68,0.06)';
    ctx.fillRect(padL + Dyn.hover * colW, padT, colW, plotH);
  }

  const barW = Math.max(2, Math.min(isDays ? 22 : 40, colW * (isDays ? 0.68 : 0.6)));
  const a = Dyn.anim;
  S.forEach((x, i) => {
    const bx = padL + i * colW + (colW - barW) / 2;
    // Текущий день/месяц ещё не закончился — рисуем его бледнее.
    ctx.globalAlpha = x.isNow ? 0.55 : 1;
    const segs = (isDays
      ? [[x.farmer, DYN_COLORS.farmer], [x.trader, DYN_COLORS.trader], [x.other, DYN_COLORS.other]]
      : [[x.total, DYN_COLORS.farmer]]).filter(s => s[0] > 0);
    let acc = 0;
    segs.forEach(([v, color], k) => {
      const y0 = y(acc * a), y1 = y((acc + v) * a);
      const h = Math.max(0, y0 - y1 - (k > 0 ? 2 : 0)); // 2px зазор между сегментами
      ctx.fillStyle = color;
      if (k === segs.length - 1) dynRoundTop(ctx, bx, y1, barW, h, 4);
      else ctx.fillRect(bx, y1, barW, h);
      acc += v;
    });
    ctx.globalAlpha = 1;
  });

  // Прошлый год — пунктир с точками (только в помесячном режиме)
  if (!isDays) {
    const px = i => padL + i * colW + colW / 2;
    ctx.save();
    ctx.globalAlpha = a;
    // Плавная монотонная кривая (Фриче — Карлсон): не «выстреливает» выше
    // соседних точек, как Безье, и не ломается на каждом месяце, как ломаная.
    // Кружки на каждой точке рвали ритм пунктира — точку показываем только
    // под курсором.
    const pts = S.map((x, i) => [px(i), y(x.prev)]);
    ctx.strokeStyle = DYN_COLORS.prev; ctx.lineWidth = 2; ctx.setLineDash([6, 5]); ctx.lineCap = 'round';
    ctx.beginPath();
    dynMonotonePath(ctx, pts);
    ctx.stroke();
    ctx.setLineDash([]);
    if (Dyn.hover >= 0) {
      const [hx, hy] = pts[Dyn.hover];
      ctx.beginPath(); ctx.arc(hx, hy, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = DYN_COLORS.prev; ctx.stroke();
    }
    ctx.restore();
  }

  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  const every = isDays ? (colW < 16 ? 7 : colW < 34 ? 3 : 1) : (colW < 34 ? 2 : 1);
  S.forEach((x, i) => {
    if ((n - 1 - i) % every) return;
    const label = isDays
      ? (x.isNow ? 'сегодня' : `${x.day} ${DYN_MON[x.mon]}`)
      : (x.mon === 0 ? `${DYN_MON[x.mon]} ’${String(x.year).slice(2)}` : DYN_MON[x.mon]);
    ctx.fillStyle = x.isNow ? '#212829' : '#8a9897';
    ctx.fillText(label, padL + i * colW + colW / 2, H - 6);
  });
}

function onDynHover(e) {
  const g = Dyn.geo;
  if (!g) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const i = Math.floor((e.clientX - rect.left - g.padL) / g.colW);
  if (i < 0 || i >= g.n) {
    if (Dyn.hover !== -1) { Dyn.hover = -1; hideDynTip(); paintDyn(); }
    return;
  }
  if (i !== Dyn.hover) { Dyn.hover = i; paintDyn(); }
  showDynTip(i, e.clientX - rect.left);
}

function hideDynTip() { document.getElementById('dynTip').hidden = true; }

function showDynTip(i, px) {
  const x = Dyn.series[i], tip = document.getElementById('dynTip');
  const rows = [];
  let title;
  if (Dyn.range === 'days') {
    title = `${DYN_WD[x.wd]}, ${x.day} ${DYN_MON_GEN[x.mon]}${x.isNow ? ' · день ещё идёт' : ''}`;
    rows.push(['Всего', x.total, null, true], ['Производители', x.farmer, DYN_COLORS.farmer],
      ['Трейдеры', x.trader, DYN_COLORS.trader], ['Прочие', x.other, DYN_COLORS.other]);
  } else {
    title = `${DYN_MON_FULL[x.mon]} ${x.year}${x.isNow ? ` · по ${Number(Dyn.data.today.slice(8))}-е число` : ''}`;
    rows.push([String(x.year), x.total, DYN_COLORS.farmer, true], [x.isNow ? `${x.year - 1}, весь месяц` : String(x.year - 1), x.prev, DYN_COLORS.prev]);
    // Текущий месяц ещё не закончился — честное сравнение только с тем же отрезком год назад.
    if (x.isNow) rows.push([`${x.year - 1}, к этому числу`, Dyn.data.lastYearMtd, null]);
    if (x.prev && !x.isNow) {
      const p = Math.round((x.total - x.prev) / x.prev * 100);
      rows.push(['Изменение', (p > 0 ? '+' : '') + p + '%', null]);
    }
  }
  tip.innerHTML = '';
  const t = document.createElement('div');
  t.className = 'dyn-tip-t'; t.textContent = title;
  tip.append(t);
  rows.forEach(([label, val, color, strong]) => {
    const r = document.createElement('div'), key = document.createElement('i'), b = document.createElement('b');
    r.className = 'dyn-tip-r';
    if (color) key.style.borderColor = color; else key.style.visibility = 'hidden';
    b.textContent = typeof val === 'number' ? dynNum(val) : val;
    if (!strong) b.style.fontWeight = '600';
    r.append(key, document.createTextNode(label), b);
    tip.append(r);
  });
  tip.hidden = false;
  const tw = tip.offsetWidth;
  let left = px + 14;
  if (left + tw > Dyn.geo.W) left = px - tw - 14;
  tip.style.left = Math.max(0, left) + 'px';
  tip.style.top = '8px';
}

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

    // Счётчики у фильтра по типу: сколько компаний скрывается за каждым
    // вариантом. Числа берём готовыми из статистики, отдельных запросов нет.
    const ftCounts = {
      '': s.activeProducers, farmer: s.farmerProducers,
      trader: s.traderProducers, unknown: s.unknownProducers,
    };
    document.querySelectorAll('.ftf-btn').forEach(btn => {
      const n = ftCounts[btn.dataset.ft];
      let el = btn.querySelector('.ftf-count');
      if (n == null) { if (el) el.remove(); return; }
      if (!el) { el = document.createElement('span'); el.className = 'ftf-count'; btn.appendChild(el); }
      el.textContent = n.toLocaleString('ru');
    });
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
function markerColorByType(ft) {
  if (ft === 'farmer') return '#2d6a0f';
  if (ft === 'trader') return '#A32D2D';
  return '#0b7355';
}

// MapLibre + векторные тайлы OpenFreeMap (OSM) со своим стилем map/style-ru.json:
// подписи только по-русски, Крым, Севастополь, ДНР, ЛНР, Запорожская и Херсонская
// области — в составе РФ. Растровые подложки для этого не годятся: язык подписей и
// линии границ впечатаны в картинку (у Esri над Крымом висел флаг Украины, у
// CartoDB области Донбасса подписаны по-украински).
function initMap() {
  const map = new maplibregl.Map({
    container: 'map',
    style: 'map/style-ru.json',
    center: [55, 55],   // MapLibre принимает [долгота, широта], а не [широта, долгота]
    zoom: 3,            // зум MapLibre на единицу «крупнее» лифлетовского
    minZoom: 2,
    maxZoom: 15,
    dragRotate: false,
    pitchWithRotate: false,
    attributionControl: { compact: true },
  });
  State.mapInstance = map;
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
  map.on('error', e => console.warn('[map]', (e.error && e.error.message) || e.type));

  let loaded = false;
  map.once('load', () => { loaded = true; onMapLoad(map); });
  // Подложка тянется со сторонней CDN — если её не отдали, не оставляем
  // пользователя с вечным «Загрузка данных...». Но MapLibre рисует по
  // requestAnimationFrame, а в скрытой вкладке кадров нет: карта там честно
  // ждёт, пока вкладку откроют, и ругаться на это нельзя — отсчёт начинаем
  // заново, когда вкладка стала видимой.
  const warnIfStuck = () => {
    if (loaded || document.hidden) return;
    const loaderEl = document.getElementById('mapLoader');
    loaderEl.style.display = 'block';
    loaderEl.innerHTML = 'Подложка карты не загрузилась. Проверьте доступ в интернет и обновите страницу.';
  };
  setTimeout(warnIfStuck, 20000);
  document.addEventListener('visibilitychange', () => {
    if (!loaded && !document.hidden) setTimeout(warnIfStuck, 20000);
  });
}

function onMapLoad(map) {
  // Кластеризация обязательна: точек теперь не 145 городов, а десятки тысяч
  // населённых пунктов — без группировки на обзорном зуме карта превращается
  // в кашу из перекрывающихся кружков.
  map.addSource('places', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
    cluster: true,
    clusterRadius: 48,
    clusterMaxZoom: 10,
    clusterProperties: { total: ['+', ['get', 'count']] },
  });

  const colorByCount = field => ['step', ['get', field], '#a8dcc6', 11, '#58b391', 51, '#0b7355', 200, '#044030'];

  map.addLayer({
    id: 'places-cluster',
    type: 'circle',
    source: 'places',
    filter: ['has', 'point_count'],
    paint: {
      'circle-radius': ['min', 46, ['+', 13, ['*', 2.2, ['sqrt', ['get', 'total']]]]],
      'circle-color': colorByCount('total'),
      'circle-opacity': 0.8,
      'circle-stroke-color': '#fff',
      'circle-stroke-width': 2.5,
    },
  });
  map.addLayer({
    id: 'places-cluster-count',
    type: 'symbol',
    source: 'places',
    filter: ['has', 'point_count'],
    layout: {
      // тысячи сокращаем до «12к», иначе подпись не влезает в кружок
      'text-field': ['case',
        ['>=', ['get', 'total'], 1000],
        ['concat', ['to-string', ['round', ['/', ['get', 'total'], 1000]]], 'к'],
        ['to-string', ['get', 'total']]],
      'text-font': ['Noto Sans Bold'],
      'text-size': ['step', ['get', 'total'], 10, 100, 11, 1000, 12],
      'text-allow-overlap': true,
    },
    paint: { 'text-color': '#fff' },
  });
  map.addLayer({
    id: 'places-point',
    type: 'circle',
    source: 'places',
    filter: ['!', ['has', 'point_count']],
    paint: {
      'circle-radius': ['min', 40, ['+', 8, ['*', 2.8, ['sqrt', ['get', 'count']]]]],
      'circle-color': colorByCount('count'),
      'circle-opacity': 0.75,
      'circle-stroke-color': '#fff',
      'circle-stroke-width': 2.5,
    },
  });

  const tip = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10, className: 'map-tip' });
  const hover = html => (e) => {
    map.getCanvas().style.cursor = 'pointer';
    tip.setLngLat(e.features[0].geometry.coordinates).setHTML(html(e.features[0].properties)).addTo(map);
  };
  const unhover = () => { map.getCanvas().style.cursor = ''; tip.remove(); };

  map.on('mousemove', 'places-point', hover(p => `<b>${escHtml(p.label)}</b>: ${p.count} декл.`));
  map.on('mouseleave', 'places-point', unhover);
  map.on('mousemove', 'places-cluster', hover(p => `${p.total} декл. в ${p.point_count} НП — нажмите, чтобы приблизить`));
  map.on('mouseleave', 'places-cluster', unhover);

  map.on('click', 'places-cluster', e => {
    const feature = e.features[0];
    map.getSource('places').getClusterExpansionZoom(feature.properties.cluster_id)
      .then(zoom => map.easeTo({ center: feature.geometry.coordinates, zoom }))
      .catch(() => {});
  });
  map.on('click', 'places-point', e => {
    tip.remove();
    openPlacePopup(map, e.features[0]);
  });

  // Слой «Свежее»: последние декларации поверх обычных точек НП — та же идея,
  // что живая лента над таблицей реестра, только на карте. Не кластеризуется
  // (максимум 100 точек), скрыт до первого включения тумблера.
  map.addSource('recent', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'recent-point',
    type: 'circle',
    source: 'recent',
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': 7,
      'circle-color': '#dc2626',
      'circle-opacity': 0.85,
      'circle-stroke-color': '#fff',
      'circle-stroke-width': 2,
    },
  });
  map.on('mousemove', 'recent-point', hover(p => `<b>${escHtml(p.product)}</b>${p.batch ? ' · ' + escHtml(p.batch) : ''}<br>${escHtml(p.place || '')} · ${p.ago}`));
  map.on('mouseleave', 'recent-point', unhover);
  map.on('click', 'recent-point', e => openDetail(e.features[0].properties.id));

  loadMapData();
}

let _recentLayerLoaded = false;
async function toggleRecentLayer(checked) {
  const map = State.mapInstance;
  if (!map || !map.getLayer('recent-point')) return;
  map.setLayoutProperty('recent-point', 'visibility', checked ? 'visible' : 'none');
  if (checked && !_recentLayerLoaded) {
    _recentLayerLoaded = true;
    try {
      const data = await apiFetch('/api/declarations/recent?limit=100');
      const features = (data.items || [])
        .filter(it => it.lat && it.lon)
        .map(it => ({
          type: 'Feature',
          properties: { id: it.id, product: it.productName, batch: it.batchSize,
            place: [it.district, it.place].filter(Boolean).join(', ') || it.region || '',
            ago: timeAgo(it.fetchedAt) },
          geometry: { type: 'Point', coordinates: [it.lon, it.lat] },
        }));
      map.getSource('recent').setData({ type: 'FeatureCollection', features });
    } catch (_) { _recentLayerLoaded = false; }
  }
}

// Список компаний по НП тянем по клику: в общем ответе карты его больше нет —
// на 17 тыс. населённых пунктов это были бы десятки мегабайт на каждое открытие.
async function openPlacePopup(map, feature) {
  const { id, label, count } = feature.properties;
  if (State.mapPopup) State.mapPopup.remove();
  State.mapPopup = new maplibregl.Popup({ maxWidth: '340px', className: 'map-popup' })
    .setLngLat(feature.geometry.coordinates)
    .setHTML(`<div style="min-width:220px"><div style="font-size:16px;font-weight:700">${escHtml(label)}</div>
      <div style="font-size:12px;color:#6b7280;margin-top:4px">${count} деклараций · загрузка компаний...</div></div>`)
    .addTo(map);
  const popup = State.mapPopup;
  try {
    const data = await apiFetch('/api/declarations/map-place?id=' + encodeURIComponent(id));
    if (State.mapPopup === popup) popup.setHTML(buildMapPopup(data));
  } catch (e) {
    if (State.mapPopup === popup) {
      popup.setHTML(`<div style="min-width:220px"><div style="font-size:16px;font-weight:700">${escHtml(label)}</div>
        <div style="font-size:12px;color:#A32D2D;margin-top:6px">Не удалось загрузить компании: ${escHtml(e.message || '')}</div></div>`);
    }
  }
}

async function loadMapData(retry = 0) {
  const loaderEl = document.getElementById('mapLoader');
  loaderEl.innerHTML = 'Загрузка данных...';
  loaderEl.style.display = 'block';
  try {
    const data = await apiFetch('/api/declarations/map-data');
    State.mapPlaces = data.places || [];
    State.mapStats = data;
    renderPlaces();
    loaderEl.style.display = 'none';
  } catch(e) {
    console.error('[map-data]', e.message);
    if (State.mapPlaces.length > 0) {
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
  if (State.mapPopup) { State.mapPopup.remove(); State.mapPopup = null; }
  renderPlaces();
}

function renderPlaces() {
  const map = State.mapInstance;
  if (!map || !map.getSource('places')) return;

  const ft = State.mapFilter;
  const features = [];
  let mapped = 0;
  for (const p of State.mapPlaces) {
    const count = ft === 'farmer' ? p.farmers : ft === 'trader' ? p.traders : p.count;
    if (!count) continue;
    mapped += count;
    features.push({
      type: 'Feature',
      properties: { id: p.id, label: p.label, count },
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    });
  }
  map.getSource('places').setData({ type: 'FeatureCollection', features });

  // при фильтре по типу цвет фиксированный, иначе — по числу деклараций
  const color = ft ? markerColorByType(ft) : null;
  for (const [layer, field] of [['places-point', 'count'], ['places-cluster', 'total']]) {
    map.setPaintProperty(layer, 'circle-color',
      color || ['step', ['get', field], '#a8dcc6', 11, '#58b391', 51, '#0b7355', 200, '#044030']);
  }

  const stats = State.mapStats || {};
  document.getElementById('mapCityCount').textContent = features.length.toLocaleString('ru');
  document.getElementById('mapDeclCount').textContent = mapped.toLocaleString('ru');
  document.getElementById('mapUnknown').textContent = Math.max(0, (stats.totalActive || mapped) - mapped).toLocaleString('ru');

  // пока фоновое геокодирование не прошло весь справочник, честно показываем,
  // что часть реестра ещё не на карте
  const noteEl = document.getElementById('mapGeoNote');
  if (noteEl) {
    const pending = stats.placesPending || 0;
    noteEl.style.display = pending ? 'block' : 'none';
    noteEl.textContent = pending ? `Определяются координаты: осталось ${pending.toLocaleString('ru')} НП` : '';
  }
  document.getElementById('mapEmpty').style.display = features.length === 0 ? 'block' : 'none';
}

function buildMapPopup(place) {
  const orgsHtml = (place.orgs || []).map(o => {
    const declsHtml = (o.decls || []).map(d => {
      const label = escHtml(d.product || 'Декларация');
      const safeId = String(d.id).replace(/'/g, '');
      return `<div onclick="mapOpenDecl('${safeId}')" style="cursor:pointer;padding:3px 8px;margin:2px 0;border-radius:4px;font-size:11px;color:#075c44;background:#eef4ff;line-height:1.4" onmouseover="this.style.background='#d9e8ff'" onmouseout="this.style.background='#eef4ff'">${label}</div>`;
    }).join('');
    return `
      <div style="padding:7px 0;border-bottom:1px solid #f0f2f5">
        <div style="font-size:13px;font-weight:600;color:#1a1e27;margin-bottom:4px;white-space:normal">${escHtml(fmtCompany(o.name))} <span style="font-weight:400;color:#6b7280">${o.decls.length > 1 ? '(' + o.decls.length + ')' : ''}</span></div>
        ${declsHtml}
      </div>`;
  }).join('');
  const where = [place.district && place.district + ' р-н', place.region].filter(Boolean).join(', ');
  return `
    <div style="font-family:'Segoe UI',system-ui,sans-serif;min-width:280px">
      <div style="font-size:16px;font-weight:700;margin-bottom:2px">${escHtml(place.label || '')}</div>
      <div style="font-size:11px;color:#6b7280">${escHtml(where)}</div>
      <div style="font-size:12px;color:#6b7280;margin:6px 0 10px;padding-bottom:10px;border-bottom:2px solid #075c44">${place.count} деклараций</div>
      <div style="max-height:340px;overflow-y:auto;padding-right:2px">${orgsHtml}</div>
    </div>`;
}

function mapOpenDecl(id) {
  if (State.mapPopup) { State.mapPopup.remove(); State.mapPopup = null; }
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
    if (btn) { btn.classList.toggle('on', !was); syncStarTip(btn, !was); }
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
  const compOpen = document.getElementById('pg-company')?.classList.contains('active');
  const detOpen  = document.getElementById('detModal')?.classList.contains('open');
  if (e.key === 'ArrowLeft')  { if (detOpen) navDecl(-1); else if (compOpen) navProducer(-1); }
  if (e.key === 'ArrowRight') { if (detOpen) navDecl(+1); else if (compOpen) navProducer(+1); }
});

// ── Company Card ──────────────────────────────────────────────────────────
// Куда вернуться из карточки компании: карточка теперь отдельный раздел, а не
// модалка поверх списка, поэтому запоминаем, откуда пришли.
let _compBackPage = 'registry';

function backFromCompany() {
  showPage(_compBackPage || 'registry');
}

// Ключевые показатели над карточкой — как в макете: сколько деклараций, за
// какой период, сколько культур и суммарный объём.
function renderCompMetrics(p) {
  const el = document.getElementById('compMetrics');
  if (!el) return;
  const decls = p.decls || [];
  const tons = decls.reduce((s, d) => s + parseTon(d.batchSize), 0);
  const crops = new Set();
  decls.forEach(d => {
    const chip = cropChip(d.productName || '');
    if (chip) crops.add(chip.replace(/<[^>]+>/g, ''));
  });
  const years = decls.map(d => (d.regDate || '').slice(0, 4)).filter(Boolean).sort();
  const period = years.length ? (years[0] === years[years.length - 1] ? years[0] : years[0] + '–' + years[years.length - 1]) : '—';
  const metrics = [
    ['Деклараций', decls.length.toLocaleString('ru')],
    ['Объём по декларациям', tons > 0 ? fmtTon(tons) : '—'],
    ['Культур', crops.size || '—'],
    ['Период', period],
  ];
  el.innerHTML = metrics.map(([l, v]) =>
    `<div class="comp-metric"><div class="comp-metric-l">${l}</div><div class="comp-metric-v">${v}</div></div>`).join('');
}

async function openCompany(inn, name) {
  if (State.currentPage && State.currentPage !== 'company') _compBackPage = State.currentPage;
  // Запоминаем позицию в списке
  const idx = State.navItems.findIndex(p => (inn && p.inn && p.inn === inn) || p.name === name);
  State.navIndex = idx;
  // Сбрасываем навигацию по декларациям (откроем при клике на конкретную)
  State.navDeclIds = [];
  State.navDeclIndex = -1;

  const key = inn || name;
  document.getElementById('compModalName').textContent = fmtCompany(name) || inn || 'Загрузка...';
  document.getElementById('compModalSub').textContent = inn ? 'ИНН: ' + inn + '  Загрузка...' : 'Загрузка...';
  document.getElementById('compModalBody').innerHTML = '<div style="color:var(--muted);padding:20px 0;text-align:center">Загрузка данных...</div>';
  document.getElementById('compModalFoot').innerHTML = '';
  document.getElementById('compMetrics').innerHTML = '';
  showPage('company');

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

  document.getElementById('compModalName').textContent = fmtCompany(p.name || name) || '—';
  document.getElementById('compModalSub').innerHTML = [
    p.inn  ? 'ИНН: <b>' + p.inn + '</b>'   : '',
    p.companyRegDate ? 'Зарегистрирована: <b>' + p.companyRegDate + '</b>' : '',
    p.viewCount ? `👁 ${p.viewCount} ${plural(p.viewCount,'просмотр','просмотра','просмотров')}` : '',
    p.dormant ? `<span style="color:var(--warn)">⏸ &gt;1.5 года без деклараций (с ${p.lastDeclDate||'—'})</span>` : '',
    p.inn ? `<a href="/company/${p.inn}" target="_blank" style="color:var(--accent)">🔗 публичная ссылка</a>` : '',
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
      ${State.user?.role === 'admin'
        ? `<div id="compDescShow" style="cursor:pointer;padding:8px 12px;background:var(--surf2);border-radius:var(--r);border:1px solid var(--border);font-size:13px;color:${p.description?'var(--text)':'var(--muted)'}" onclick="editCompDesc()" title="Описание видят все пользователи. Нажмите, чтобы изменить">${p.description ? safeDesc : '+ Добавить описание компании (видно всем пользователям)'}</div>`
        : (p.description ? `<div id="compDescShow" style="padding:8px 12px;background:var(--surf2);border-radius:var(--r);border:1px solid var(--border);font-size:13px">${safeDesc}</div>` : '')}
      <div id="compDescEdit" style="display:none">
        <input id="compDescInput" type="text" class="fi" placeholder="Краткое описание компании..." value="${safeDesc}">
        <div style="display:flex;gap:6px;margin-top:6px">
          <button class="btn btn-sm btn-p" onclick="saveCompanyDesc('${safeInn}','${safeName}')">💾 Сохранить</button>
          <button class="btn btn-sm" onclick="cancelCompDesc()">Отмена</button>
        </div>
      </div>
    </div>
    <div class="dg" style="margin-bottom:18px;gap:10px 20px">
      <div class="df"><div class="df-l">Телефон</div><div class="df-v">${escHtml(p.phone || p.ebPhone || '—')}</div></div>
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
      <h4>Мои контакты <span style="font-weight:400;font-size:11px;color:var(--muted)">— видны только вам</span></h4>
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
      <h4>Мои заметки о компании <span style="font-weight:400;font-size:11px;color:var(--muted)">— видны только вам</span></h4>
      <textarea id="compNotes" class="fi" style="width:100%;min-height:70px;resize:vertical" placeholder="Договорённости, цены, с кем говорили…">${(p.notes||'').replace(/</g,'&lt;')}</textarea>
      <button class="btn btn-sm" style="margin-top:6px" onclick="saveCompanyNotes('${safeInn}','${safeName}')">💾 Сохранить</button>
    </div>`;

  renderCompMetrics(p);
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
        ${p.inn ? `<button class="btn btn-sm" onclick="openDueDiligenceReport('${safeInn}')">📄 Отчёт о контрагенте</button>` : ''}
        <button class="btn btn-sm" onclick="addToFolder('${safeInn}','${safeName}')">📁 В папку</button>
        <button class="btn btn-sm" onclick="openAddToNoteModal({kind:'company',inn:'${safeInn}',label:'${compLabel}'})">📝 В заметку</button>
        <button class="btn btn-p btn-sm" onclick="backFromCompany()">← К списку</button>
      </div>
    </div>`;
  _updateCompNavButtons();
}

// Отчёт о должной осмотрительности (MVP на данных ЕГРЮЛ, без банкротства/
// арбитража/ФССП — для этого нужен платный источник, см. CLAUDE.md).
// Открываем в новом окне через window.open('') + document.write, а не
// прямой ссылкой: обычная <a href> не понесёт Bearer-токен на GET-запрос.
async function openDueDiligenceReport(inn) {
  let data;
  try {
    data = await apiFetch('/api/business/company/report?inn=' + encodeURIComponent(inn));
  } catch (e) { showAlert('Не удалось сформировать отчёт: ' + e.message, 'err'); return; }

  const addrRow = data.egrulAddress
    ? `<div class="row"><b>Адрес по ЕГРЮЛ</b><span>${escHtml(data.egrulAddress)}${data.addressMatch === false ? ' <span class="warn">⚠ отличается от адреса в декларации</span>' : data.addressMatch ? ' <span class="ok">✓ совпадает с декларацией</span>' : ''}</span></div>`
    : '';
  const win = window.open('', '_blank');
  if (!win) { showAlert('Браузер заблокировал всплывающее окно — разрешите всплывающие окна для этого сайта', 'err'); return; }
  win.document.write(`<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8">
    <title>Отчёт о контрагенте — ${escHtml(data.name)}</title>
    <style>
      body{font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:640px;margin:32px auto;padding:0 16px;color:#212829;line-height:1.5}
      h1{font-size:19px;margin:0 0 4px}
      .sub{color:#6f8080;font-size:12px;margin-bottom:20px}
      .row{display:flex;justify-content:space-between;gap:16px;padding:9px 0;border-bottom:1px solid #eee;font-size:13.5px}
      .row b{color:#6f8080;font-weight:500;flex:none;width:180px}
      .row span{text-align:right}
      .warn{color:#a32d2d;font-size:12px}
      .ok{color:#157a4d;font-size:12px}
      .notice{background:#fff7e6;border:1px solid #f2d272;border-radius:8px;padding:10px 14px;font-size:12.5px;color:#7a5b00;margin:18px 0}
      .btn{background:#075c44;color:#fff;border:none;padding:9px 18px;border-radius:8px;font-size:13px;cursor:pointer;margin-top:18px}
      @media print{.btn{display:none}}
    </style></head><body>
    <h1>Отчёт о контрагенте: ${escHtml(fmtCompany(data.name))}</h1>
    <div class="sub">Сформировано ${new Date(data.generatedAt).toLocaleString('ru-RU')} · KOVELIA · Агро реестр</div>
    <div class="row"><b>ИНН</b><span>${escHtml(data.inn)}</span></div>
    ${data.ogrn ? `<div class="row"><b>ОГРН</b><span>${escHtml(data.ogrn)}</span></div>` : ''}
    <div class="row"><b>Статус в ЕГРЮЛ</b><span>${escHtml(data.egrulStatusLabel)}</span></div>
    ${data.regDate ? `<div class="row"><b>Дата регистрации</b><span>${escHtml(data.regDate)}</span></div>` : ''}
    ${data.director ? `<div class="row"><b>Руководитель</b><span>${escHtml(data.director)}</span></div>` : ''}
    ${data.okved ? `<div class="row"><b>ОКВЭД (по декларации)</b><span>${escHtml(data.okved)}</span></div>` : ''}
    ${addrRow}
    ${!data.hasEgrulData ? '<div class="notice">⚠ Данных из ЕГРЮЛ по этой компании пока нет — обогащение ещё не прошло или компания не найдена в реестре ФНС.</div>' : ''}
    <div class="notice">Это сокращённая версия отчёта: наличие в ЕГРЮЛ, статус, руководитель, адрес. Проверка банкротства, арбитражных дел и исполнительных производств (ст. 54.1 НК РФ) требует платного источника данных и в эту версию не входит.</div>
    <button class="btn" onclick="window.print()">Печать / сохранить как PDF</button>
    </body></html>`);
  win.document.close();
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
    // Остаёмся в карточке: раньше здесь был backFromCompany(), и сохранение
    // описания выкидывало пользователя обратно к списку.
    const show = document.getElementById('compDescShow');
    show.textContent = desc || '+ Добавить описание компании (видно всем пользователям)';
    show.style.color = desc ? 'var(--text)' : 'var(--muted)';
    cancelCompDesc();
    showAlert('Описание сохранено');
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

// Объём партии из произвольной формулировки реестра в тонны. Разбор совпадает
// с backend/services/batchSize.js — держать в синхроне при правках любой из
// версий; там же разобраны все форматы, которые встречаются в данных.
const BATCH_UNIT_TON = '(?:тонн[а-яё]*|тн|т)(?![а-яё])';
const BATCH_UNIT_KG  = '(?:килограмм[а-яё]*|кг)(?![а-яё])';
const BATCH_UNIT_CT  = '(?:центнер[а-яё]*|ц)(?![а-яё])';
const BATCH_NUM      = '(\\d+(?:[.,]\\d+)?)';
const BATCH_FIRST_RE = new RegExp(`${BATCH_NUM}\\s*(${BATCH_UNIT_TON}|${BATCH_UNIT_KG}|${BATCH_UNIT_CT})`, 'i');
const BATCH_KG_TAIL_RE = new RegExp(`${BATCH_NUM}\\s*${BATCH_UNIT_KG}`, 'i');
const BATCH_BARE_RE  = new RegExp(`^\\s*${BATCH_NUM}`);
const BATCH_KG_ONLY  = new RegExp(`^${BATCH_UNIT_KG}$`, 'i');
const BATCH_CT_ONLY  = new RegExp(`^${BATCH_UNIT_CT}$`, 'i');

function parseTon(s) {
  if (!s) return 0;
  // Скобки — меткой, а не пробелом: иначе числа по обе стороны склеятся при
  // сборке разрядов. Обоснование всех правил — в backend/services/batchSize.js.
  let str = String(s).toLowerCase().replace(/\([^)]*\)/g, ' \u0001 ');
  // К числу приклеиваем только группы ровно по три цифры; хвост вроде «00» в
  // «66 000 000 00 кг» отбрасываем. Обоснование — в backend/services/batchSize.js.
  let prev;
  do {
    prev = str;
    str = str.replace(/(\d)[\u0020\u00a0]+(\d{3})(?!\d)/g, '$1$2');
  } while (str !== prev);
  str = str.replace(/(\d)[\u0020\u00a0]+(\d+)(?!\d)/g, '$1.$2');
  str = str.replace(/(\d),[\u0020\u00a0]+(?=\d)/g, '$1,');
  str = str.replace(/\d{1,3}(?:,\d{3})+/g, m => {
    const last = m.lastIndexOf(',');
    return m.slice(0, last).replace(/,/g, '') + ',' + m.slice(last + 1);
  });
  str = str.replace(/\u0001/g, ' ');

  // Партии больше 500 тыс. т не бывает: в реестре попадаются записи с потерянной
  // запятой («2 110 594 тонн» — это 2110,594 т). Сдвиг кратен тысяче.
  const plausible = v => {
    let n = v;
    for (let i = 0; i < 2 && n > 500000; i++) n /= 1000;
    return n > 500000 ? 0 : n;
  };

  const m = BATCH_FIRST_RE.exec(str);
  if (!m) {
    // Число без единицы измерения: до миллиона — тонны, от миллиона — килограммы.
    const bare = BATCH_BARE_RE.exec(str);
    const num = bare ? parseFloat(bare[1].replace(',', '.')) : NaN;
    if (isNaN(num) || num <= 0) return 0;
    return plausible(num >= 1000000 ? num / 1000 : num);
  }

  const value = parseFloat(m[1].replace(',', '.'));
  if (isNaN(value) || value <= 0) return 0;
  if (BATCH_KG_ONLY.test(m[2])) return plausible(value / 1000);
  if (BATCH_CT_ONLY.test(m[2])) return plausible(value / 10);

  if (Number.isInteger(value)) {
    const tail = BATCH_KG_TAIL_RE.exec(str.slice(m.index + m[0].length));
    if (tail) {
      const kg = parseFloat(tail[1].replace(',', '.'));
      if (!isNaN(kg) && kg > 0 && kg < 1000) return plausible(value + kg / 1000);
    }
  }
  return plausible(value);
}

// Название компании для показа: организационная форма — аббревиатурой, частник
// без формы — с «ИП». Разбор совпадает с backend/services/companyName.js —
// держать в синхроне. В данных ничего не меняется: поиск, группировка,
// избранное и выгрузки работают с исходной строкой.
const COMPANY_FORM_RULES = [
  [/^общество\s+с\s+ограниченной\s+ответственностью/i, 'ООО'],
  [/^публичное\s+акционерное\s+общество/i, 'ПАО'],
  [/^непубличное\s+акционерное\s+общество/i, 'НАО'],
  [/^закрытое\s+акционерное\s+общество/i, 'ЗАО'],
  [/^открытое\s+акционерное\s+общество/i, 'ОАО'],
  [/^акционерное\s+общество/i, 'АО'],
  [/^индивидуальный\s+предприниматель/i, 'ИП'],
  [/^физическое\s+лицо[\s-]*предприниматель/i, 'ИП'],
  [/^флп(?![а-яё])/i, 'ИП'],
  // «Глава КФХ Егупов Ю.А.» — форма уже сокращена, но «Глава» лишняя.
  [/^(?:ип\s+)?глав[аы]\s+(?:к\s*\(\s*ф\s*\)\s*х|кфх|к\s*\/\s*х|кх|фх)(?![а-яё])/i, 'КФХ'],
  [/^(?:ип\s+)?глав[аы]\s+крестьянск(?:ого|их)?\s*(?:\([^)]*\)|фермерск(?:ого|их))?\s*хозяйств[ао]?/i, 'КФХ'],
  [/^крестьянск(?:ое|ого)\s*(?:\([^)]*\)|фермерское)?\s*хозяйств[ао]?/i, 'КФХ'],
  [/^фермерское\s+хозяйство/i, 'КФХ'],
  [/^сельскохозяйственн[а-яё]*\s+производственн[а-яё]*\s+кооператив[а-яё]*/i, 'СПК'],
  [/^к\s*\(\s*ф\s*\)\s*х(?![а-яё])/i, 'КФХ'],
  [/^к\s*\/\s*х(?![а-яё])/i, 'КФХ'],
  [/^кх(?![а-яё])/i, 'КФХ'],
  [/^фх(?![а-яё])/i, 'КФХ'],
];
const COMPANY_PATRONYMIC_RE = /(ович|овича|евич|евича|ьич|ича|овна|овны|евна|евны|ична|инична)$/i;
const COMPANY_INITIALS_RE = /^[А-ЯЁ][А-ЯЁа-яё-]+\s+[А-ЯЁ]\.\s*[А-ЯЁ]\.?$/;

function fmtCompany(name) {
  if (!name) return '';
  const str = String(name).replace(/\s+/g, ' ').trim();
  if (!str) return '';
  for (const [re, abbr] of COMPANY_FORM_RULES) {
    const m = re.exec(str);
    if (!m) continue;
    const rest = str.slice(m[0].length).replace(/^[\s,.:-]+/, '');
    return rest ? `${abbr} ${rest}` : abbr;
  }
  if (/["«»()\d]/.test(str)) return str;
  const words = str.split(/\s+/);
  const person = (words.length === 3 && COMPANY_PATRONYMIC_RE.test(words[2])) || COMPANY_INITIALS_RE.test(str);
  return person ? `ИП ${str}` : str;
}

// Культура из названия продукции — для плашки в таблице. Список собран по
// реальным названиям реестра: покрывает 86% действующих деклараций, остальные
// сформулированы обобщённо («зерновые», «овощебахчевые») и плашки не получают.
// Семейство задаёт цвет: зерновые — янтарный, масличные — зелёный,
// зернобобовые — мятный, чтобы список можно было просматривать по культуре.
const CROP_DICT = [
  ['пшениц', 'Пшеница', 'grain'], ['ячмен', 'Ячмень', 'grain'], ['кукуруз', 'Кукуруза', 'grain'],
  ['тритикал', 'Тритикале', 'grain'], ['рожь', 'Рожь', 'grain'], ['ржи', 'Рожь', 'grain'],
  ['овёс', 'Овёс', 'grain'], ['овес', 'Овёс', 'grain'], ['просо', 'Просо', 'grain'],
  ['сорго', 'Сорго', 'grain'], ['рис', 'Рис', 'grain'],
  ['подсолнечник', 'Подсолнечник', 'oil'], ['рапс', 'Рапс', 'oil'], ['соя', 'Соя', 'oil'],
  ['сои', 'Соя', 'oil'], ['лён', 'Лён', 'oil'], ['лен', 'Лён', 'oil'],
  ['горчиц', 'Горчица', 'oil'], ['сафлор', 'Сафлор', 'oil'],
  ['горох', 'Горох', 'bean'], ['нут', 'Нут', 'bean'], ['чечевиц', 'Чечевица', 'bean'],
  ['люпин', 'Люпин', 'bean'], ['вик', 'Вика', 'bean'], ['гречих', 'Гречиха', 'bean'],
];

function cropChip(productName) {
  const t = String(productName || '').toLowerCase();
  const hit = CROP_DICT.find(([key]) => t.includes(key));
  if (!hit) return '';
  return `<span class="crop crop-${hit[2]}">${hit[1]}</span>`;
}

function fmtTon(t) {
  if (!t) return '—';
  if (t >= 1000000) return (t / 1000000).toFixed(2) + ' млн т';
  if (t >= 1000)    return (t / 1000).toFixed(1) + ' тыс.т';
  // До тысячи тонн килограммы ещё различимы: «995,78 т» вместо «996 т».
  return (Math.round(t * 100) / 100).toLocaleString('ru', { maximumFractionDigits: 2 }) + ' т';
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
      <td><button class="btn btn-sm" style="padding:2px 8px;font-size:11px" onclick="openDetail('${d.id}',true)">↗</button></td>
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
          <div class="df full"><div class="df-l">Наименование</div><div class="df-v">${fmtCompany(r.shortName)||'—'}</div></div>
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
    // Подпись для заметки — «Компания · продукция», понятнее номера декларации.
    const declLabel = [fmtCompany(r.shortName || r.applicantName || ''), (r.productName || '').slice(0, 40)]
      .filter(Boolean).join(' · ').replace(/\\/g, '').replace(/'/g, "\\'").replace(/"/g, '&quot;') || r.id;
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
          <button class="btn btn-sm" onclick="openAddToNoteModal({kind:'decl',id:'${r.id}',label:'${declLabel}'})">📝 В заметку</button>
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
  const form = document.getElementById('feedbackForm');
  form.hidden = false;
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
  const takeImage = (e, setter) => {
    const items = e.clipboardData?.items || [];
    for (const item of items) {
      if (item.type.startsWith('image/')) { setter(item.getAsFile()); e.preventDefault(); return; }
    }
  };
  // Скриншот можно вставить в любое поле формы, а не только в рамку
  document.getElementById('feedbackForm').addEventListener('paste', e => takeImage(e, onFeedbackFileSelected));
  document.getElementById('chatForm').addEventListener('paste', e => takeImage(e, onChatFile));
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
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
    document.getElementById('fbPreviewWrap').hidden = false;
  };
  reader.readAsDataURL(file);
}

function clearFeedbackImage() {
  _fbImageBlob = null;
  document.getElementById('fbPreviewWrap').hidden = true;
  document.getElementById('fbFileInput').value = '';
}

// multipart-запрос с токеном (apiFetch шлёт JSON)
async function postForm(url, fd) {
  const res = await fetch(url, {
    method: 'POST',
    headers: State.token ? { 'Authorization': `Bearer ${State.token}` } : {},
    body: fd,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Ошибка отправки');
  return data;
}

async function submitFeedback() {
  const title = document.getElementById('fbTitle').value.trim();
  if (!title) { showAlert('Опишите проблему коротко в заголовке', 'err'); return; }

  const fd = new FormData();
  fd.append('title', title);
  fd.append('description', document.getElementById('fbDescription').value);
  if (_fbImageBlob) fd.append('image', _fbImageBlob, _fbImageBlob.name || 'screenshot.png');

  try {
    const item = await postForm('/api/feedback', fd);
    document.getElementById('feedbackForm').hidden = true;
    showAlert('Обращение отправлено — ответ придёт сюда, в переписку');
    await loadFeedback();
    openChat(item.id);
  } catch (e) { showAlert(e.message, 'err'); }
}

const FB_STATUS_LABEL = { new: 'Новое', in_progress: 'В работе', resolved: 'Решено' };
let _fbItems = [];
let _chatPollTimer = null;
let _chatImage = null;

async function loadFeedback() {
  const isAdmin = State.user?.role === 'admin';
  bindFeedbackPasteListener();
  bindChatInput();
  try {
    _fbItems = await apiFetch(isAdmin ? '/api/feedback' : '/api/feedback/mine');
    document.getElementById('feedbackEmpty').style.display = _fbItems.length ? 'none' : 'block';
    document.getElementById('chatWrap').hidden = !_fbItems.length;
    renderFeedbackList();
    if (State.chatId && _fbItems.some(f => f.id === State.chatId)) openChat(State.chatId, true);
    else if (_fbItems.length && window.innerWidth > 760) openChat(_fbItems[0].id);
    refreshSupportBadge();
  } catch (e) { showAlert(e.message, 'err'); }
}

function renderFeedbackList() {
  const isAdmin = State.user?.role === 'admin';
  document.getElementById('feedbackList').innerHTML = _fbItems.map(it => {
    const preview = it.lastText != null && it.lastText !== ''
      ? (it.lastFromAdmin ? (isAdmin ? 'Вы: ' : 'Поддержка: ') : (isAdmin ? '' : 'Вы: ')) + it.lastText
      : (it.description || '');
    const when = it.lastMessageAt || it.createdAt;
    return `
      <button class="chat-item${it.id === State.chatId ? ' on' : ''}${it.unread ? ' unread' : ''}" onclick="openChat(${it.id})">
        <span class="chat-item-top">
          <span class="chat-item-t">${escHtml(it.title)}</span>
          ${it.unread ? `<span class="chat-badge">${it.unread}</span>` : ''}
        </span>
        <span class="chat-item-p">${escHtml(preview.slice(0, 90))}</span>
        <span class="chat-item-m">
          <span class="fb-st fb-st-${it.status}">${FB_STATUS_LABEL[it.status] || it.status}</span>
          ${isAdmin ? `<span>${escHtml(it.username || '')}</span>` : ''}
          <span>${fmtChatTime(when)}</span>
        </span>
      </button>`;
  }).join('');
}

// createdAt из SQLite — UTC без пометки зоны
function chatDate(s) { return new Date(String(s).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z')); }
function fmtChatTime(s) {
  if (!s) return '';
  const d = chatDate(s), now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

async function openChat(id, silent) {
  State.chatId = id;
  const item = _fbItems.find(f => f.id === id);
  if (!item) return;
  document.getElementById('chatWrap').classList.add('chat-open');
  ['chatHead', 'chatMsgs', 'chatForm'].forEach(x => { document.getElementById(x).hidden = false; });
  document.getElementById('chatEmpty').hidden = true;
  document.getElementById('chatTitle').textContent = item.title;
  const isAdmin = State.user?.role === 'admin';
  document.getElementById('chatSub').textContent = (isAdmin ? (item.username || '') + ' · ' : '') + 'обращение от ' + fmtChatTime(item.createdAt);
  document.getElementById('chatStatus').value = item.status;
  document.querySelectorAll('#chatHead .admin-only').forEach(el => { el.style.display = isAdmin ? '' : 'none'; });
  renderFeedbackList();
  await loadChatMessages(!silent);
  clearInterval(_chatPollTimer);
  // Пока переписка открыта — подтягиваем ответы раз в 10 секунд
  _chatPollTimer = setInterval(() => {
    if (State.currentPage === 'feedback' && !document.hidden && State.chatId) loadChatMessages(false);
    else if (State.currentPage !== 'feedback') clearInterval(_chatPollTimer);
  }, 10000);
}

function closeChat() {
  document.getElementById('chatWrap').classList.remove('chat-open');
}

let _chatLastId = -1;
async function loadChatMessages(scroll) {
  const id = State.chatId;
  try {
    const { ticket, messages } = await apiFetch(`/api/feedback/${id}/messages`);
    if (id !== State.chatId) return;
    const lastId = messages.length ? messages[messages.length - 1].id : 0;
    const isAdmin = State.user?.role === 'admin';
    const mine = m => isAdmin ? !!m.fromAdmin : !m.fromAdmin;
    // Первое «сообщение» — само обращение
    const first = { id: 0, fromAdmin: 0, text: ticket.description || '', imagePath: ticket.imagePath, createdAt: ticket.createdAt };
    const all = [first, ...messages].filter(m => m.text || m.imagePath);
    const box = document.getElementById('chatMsgs');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    if (lastId !== _chatLastId || scroll) {
      box.innerHTML = all.map(m => `
        <div class="msg ${mine(m) ? 'msg-me' : 'msg-them'}">
          <div class="msg-who">${m.fromAdmin ? 'Поддержка KOVELIA' : (isAdmin ? escHtml(ticket.username || 'Пользователь') : 'Вы')}</div>
          ${m.text ? `<div class="msg-text">${escHtml(m.text)}</div>` : ''}
          ${m.imagePath ? `<a href="${escHtml(m.imagePath)}" target="_blank" rel="noopener"><img class="msg-img" src="${escHtml(m.imagePath)}" alt="Скриншот"></a>` : ''}
          <div class="msg-time">${fmtChatTime(m.createdAt)}</div>
        </div>`).join('') || '<div class="chat-empty">Сообщений пока нет</div>';
      if (scroll || atBottom) box.scrollTop = box.scrollHeight;
      _chatLastId = lastId;
    }
    // Открыли — значит прочитали: обновляем счётчик в списке и в меню
    const item = _fbItems.find(f => f.id === id);
    if (item && item.unread) { item.unread = 0; renderFeedbackList(); }
    if (item && item.status !== ticket.status) { item.status = ticket.status; renderFeedbackList(); }
    refreshSupportBadge();
  } catch (e) { if (scroll) showAlert(e.message, 'err'); }
}

let _chatInputBound = false;
function bindChatInput() {
  if (_chatInputBound) return;
  _chatInputBound = true;
  const ta = document.getElementById('chatText');
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
  });
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
  });
}

function onChatFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  _chatImage = file;
  const reader = new FileReader();
  reader.onload = () => {
    document.getElementById('chatAttachImg').src = reader.result;
    document.getElementById('chatAttach').hidden = false;
  };
  reader.readAsDataURL(file);
}

function clearChatImage() {
  _chatImage = null;
  document.getElementById('chatAttach').hidden = true;
  document.getElementById('chatFile').value = '';
}

async function sendChatMessage() {
  const ta = document.getElementById('chatText'), btn = document.getElementById('chatSendBtn');
  const text = ta.value.trim();
  if (!text && !_chatImage) return;
  const fd = new FormData();
  fd.append('text', text);
  if (_chatImage) fd.append('image', _chatImage, _chatImage.name || 'screenshot.png');
  btn.disabled = true;
  try {
    const { status } = await postForm(`/api/feedback/${State.chatId}/messages`, fd);
    ta.value = '';
    ta.style.height = 'auto';
    clearChatImage();
    const item = _fbItems.find(f => f.id === State.chatId);
    if (item) {
      item.status = status;
      item.lastText = text;
      item.lastFromAdmin = State.user?.role === 'admin' ? 1 : 0;
      item.lastMessageAt = new Date().toISOString();
      _fbItems.sort((a, b) => (a === item ? -1 : b === item ? 1 : 0));
      document.getElementById('chatStatus').value = status;
    }
    renderFeedbackList();
    await loadChatMessages(true);
  } catch (e) { showAlert(e.message, 'err'); }
  finally { btn.disabled = false; ta.focus(); }
}

async function updateFeedbackStatus(id, status) {
  try {
    await apiFetch('/api/feedback/' + id, { method: 'PATCH', body: JSON.stringify({ status }) });
    const item = _fbItems.find(f => f.id === id);
    if (item) { item.status = status; renderFeedbackList(); }
  } catch (e) { showAlert(e.message, 'err'); }
}

async function deleteFeedback(id) {
  if (!confirm('Удалить обращение вместе с перепиской?')) return;
  try {
    await apiFetch('/api/feedback/' + id, { method: 'DELETE' });
    State.chatId = null;
    ['chatHead', 'chatMsgs', 'chatForm'].forEach(x => { document.getElementById(x).hidden = true; });
    document.getElementById('chatEmpty').hidden = false;
    loadFeedback();
  } catch (e) { showAlert(e.message, 'err'); }
}

// Значок непрочитанных у «Поддержки» в меню — опрашиваем раз в минуту
async function refreshSupportBadge() {
  try {
    const { unread } = await apiFetch('/api/feedback/unread');
    const tab = document.querySelector('.nav-tab[data-page="feedback"]');
    if (!tab) return;
    let b = tab.querySelector('.nav-badge');
    if (!b) { b = document.createElement('span'); b.className = 'nav-badge'; tab.appendChild(b); }
    b.textContent = unread > 9 ? '9+' : unread;
    b.hidden = !unread;
  } catch (_) {}
}

async function loadProfile() {
  try {
    const [me, sub] = await Promise.all([
      apiFetch('/api/auth/me'),
      apiFetch('/api/payment/subscription').catch(() => ({ active: false })),
    ]);
    document.getElementById('profUsername').textContent = me.username || '—';
    document.getElementById('pwFormUser').value = me.email || me.username || '';
    document.getElementById('profRole').textContent = me.role === 'admin' ? 'Администратор' : 'Пользователь';
    document.getElementById('profCreatedAt').textContent = me.created_at
      ? new Date(me.created_at).toLocaleDateString('ru-RU') : '—';

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

    renderMaxLinkStatus(me.maxLinked);
    loadSavedSearches();
  } catch(e) {
    showAlert(e.message, 'err');
  }
}

// ── MAX-бот: привязка аккаунта ──────────────────────────────────────────
function renderMaxLinkStatus(linked) {
  const statusEl = document.getElementById('maxLinkStatus');
  const areaEl = document.getElementById('maxLinkArea');
  if (linked) {
    statusEl.innerHTML = '<span style="color:var(--succ);font-weight:600">✓ MAX привязан</span>';
    areaEl.innerHTML = '<button class="btn btn-sm" onclick="unlinkMax()">Отвязать</button>';
  } else {
    statusEl.textContent = 'MAX не привязан — напоминания и подписки приходить не будут.';
    areaEl.innerHTML = '<button class="btn btn-p btn-sm" onclick="requestMaxLinkCode()">Получить код для привязки</button>';
  }
}

async function requestMaxLinkCode() {
  const areaEl = document.getElementById('maxLinkArea');
  try {
    const { code, botUsername } = await apiFetch('/api/auth/max-link-code', { method: 'POST' });
    areaEl.innerHTML = `
      <div style="background:var(--surf2);border:1px solid var(--border);border-radius:var(--r);padding:10px 12px;font-size:13px">
        1. Откройте MAX и найдите бота${botUsername ? ' <b>@' + escHtml(botUsername) + '</b>' : ''}<br>
        2. Отправьте ему сообщением код: <b style="font-size:16px;letter-spacing:2px">${escHtml(code)}</b><br>
        <span style="color:var(--muted);font-size:11px">Код действует 10 минут</span>
      </div>`;
  } catch (e) { areaEl.innerHTML = `<span style="color:var(--dng);font-size:13px">${escHtml(e.message)}</span>`; }
}

async function unlinkMax() {
  try {
    await apiFetch('/api/auth/max-unlink', { method: 'POST' });
    renderMaxLinkStatus(false);
  } catch (e) { showAlert(e.message, 'err'); }
}

// ── Подписки на фильтр реестра ──────────────────────────────────────────
async function loadSavedSearches() {
  const listEl = document.getElementById('savedSearchesList');
  if (!listEl) return;
  try {
    const rows = await apiFetch('/api/saved-searches');
    listEl.innerHTML = rows.length ? rows.map(r => `
      <div class="watch-item${r.active ? '' : ' paused'}">
        <div style="min-width:0;flex:1">
          <div class="watch-item-t"><b>${escHtml(r.name || 'Без названия')}</b>
            <span class="watch-st">${r.active ? 'Уведомления включены' : 'На паузе'}</span></div>
          <div class="watch-item-s">${escHtml(savedSearchSummary(r.filterJson))}</div>
        </div>
        <div class="watch-item-a">
          <button class="btn btn-sm" onclick="toggleSavedSearch(${r.id},${r.active ? 0 : 1})">${r.active ? 'Приостановить' : 'Включить'}</button>
          <button class="btn btn-sm btn-dng" onclick="deleteSavedSearch(${r.id})">Удалить</button>
        </div>
      </div>`).join('') : '<div style="color:var(--muted);font-size:12.5px">Пока ни за чем не следите. В «Реестре» задайте поиск или фильтры и нажмите «Следить за новыми».</div>';
  } catch (_) {}
}

function savedSearchParts(f) {
  const parts = [];
  if (f.manufacturer) parts.push(`компания: ${f.manufacturer}`);
  (f.regions || []).forEach(r => parts.push(regionLabel(r)));
  if (f.district) parts.push(f.district + ' р-н');
  if (f.placeLabel) parts.push(f.placeLabel);
  (f.crops || []).forEach(c => parts.push(CROP_LABEL[c] || c));
  if (f.product) parts.push(`продукция: ${f.product}`);
  if (f.address) parts.push(`адрес: ${f.address}`);
  if (f.farmerType) parts.push(f.farmerType === 'farmer' ? 'производители' : 'трейдеры');
  if (f.batchMin) parts.push(`от ${f.batchMin} т`);
  if (f.batchMax) parts.push(`до ${f.batchMax} т`);
  return parts;
}

function savedSearchSummary(f) {
  const parts = savedSearchParts(f);
  return parts.length ? parts.join(', ') : 'без условий — все новые декларации';
}

async function toggleSavedSearch(id, active) {
  try { await apiFetch(`/api/saved-searches/${id}/active`, { method: 'PUT', body: JSON.stringify({ active: !!active }) }); loadSavedSearches(); }
  catch (e) { showAlert(e.message, 'err'); }
}

async function deleteSavedSearch(id) {
  if (!confirm('Удалить подписку?')) return;
  try { await apiFetch(`/api/saved-searches/${id}`, { method: 'DELETE' }); loadSavedSearches(); }
  catch (e) { showAlert(e.message, 'err'); }
}


// Результат пишем прямо под формой: всплывашка в углу экрана исчезала через
// 3,5 с и выглядела одинаково для ошибки и успеха — её просто не замечали.
async function changePassword() {
  const cur = document.getElementById('profCurPass').value;
  const nw  = document.getElementById('profNewPass').value;
  const nw2 = document.getElementById('profNewPass2').value;
  const msg = document.getElementById('profPassMsg'), btn = document.getElementById('profPassBtn');
  const say = (text, type) => { msg.textContent = text; msg.className = 'form-msg ' + type; msg.hidden = false; };
  if (!cur || !nw || !nw2) return say('Заполните все три поля', 'err');
  if (nw.length < 8) return say('Новый пароль должен быть не короче 8 символов', 'err');
  if (nw !== nw2) return say('Новый пароль и подтверждение не совпадают', 'err');
  if (nw === cur) return say('Новый пароль совпадает с текущим', 'err');
  btn.disabled = true;
  try {
    await apiFetch('/api/auth/password', { method: 'PUT', body: JSON.stringify({ currentPassword: cur, newPassword: nw }) });
    ['profCurPass', 'profNewPass', 'profNewPass2'].forEach(id => { document.getElementById(id).value = ''; });
    say('Пароль изменён. Используйте новый пароль при следующем входе.', 'ok');
  } catch (e) {
    say(e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

// ── Settings ──────────────────────────────────────────────────────────────
let _enrichPollTimer = null;

async function openSettings() {
  try {
    openModal('settingsModal');
    refreshEnrichStatus();
    refreshEnrichCacheStats();
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
  const dateFields = ['regDate', 'endDate'];
  ['group','regDate','endDate','applicantName','lastName','firstName','middleName','shortName','address','phone','productName','batchSize','otherInfo'].forEach(f => {
    const el = document.getElementById('f_' + f);
    if (!el) return;
    const raw = (record && record[f] != null) ? record[f] : '';
    el.value = dateFields.includes(f) ? isoToRu(raw) : raw;
  });
  openModal('addModal');
}

async function saveRecord() {
  const fields = ['group','regDate','endDate','applicantName','lastName','firstName','middleName','shortName','address','phone','productName','batchSize','otherInfo'];
  const dateFields = ['regDate', 'endDate'];
  const data = {};
  fields.forEach(f => {
    const raw = document.getElementById('f_' + f).value;
    data[f] = dateFields.includes(f) ? ruToIso(raw) : raw;
  });
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
  el.classList.toggle('err', type === 'err');
  el.classList.add('show');
  // Новое сообщение не должно гаснуть по таймеру предыдущего.
  clearTimeout(showAlert._t);
  showAlert._t = setTimeout(() => el.classList.remove('show'), type === 'err' ? 6000 : 3500);
}

['addModal','detModal','settingsModal','subscriptionModal','tosModal','privacyModal','addToFolderModal','addToNoteModal','dedupeModal','noAccessModal','noteModal'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', function(e) { if (e.target === this) closeModal(id); });
});
// mydbColModal закрывается с отменой pending-загрузки
const _mydbColModalEl = document.getElementById('mydbColModal');
if (_mydbColModalEl) _mydbColModalEl.addEventListener('click', function(e) { if (e.target === this) cancelMydbUpload(); });

function openTos() {
  openModal('tosModal');
}

function openPrivacy() {
  openModal('privacyModal');
}

function togglePw(inputId, btn) {
  const inp = document.getElementById(inputId);
  const show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
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
  if (sub.isAdmin) {
    statusEl.innerHTML = `<div class="sub-status-ok">👑 Администратор — неограниченный доступ</div>`;
    document.getElementById('subPlans').innerHTML = '';
    openModal('subscriptionModal');
    return;
  }

  if (sub.active && sub.subscriptionUntil) {
    const d = new Date(sub.subscriptionUntil);
    statusEl.innerHTML = `<div class="sub-status-ok">✓ Подписка активна до <b>${d.toLocaleDateString('ru-RU')}</b></div>`;
  } else {
    statusEl.innerHTML = `<div class="sub-status-err">Подписка не активна. Выберите тариф для оформления.</div>`;
  }
  if (sub.testMode) {
    statusEl.innerHTML += `<div class="sub-status-err" style="margin-top:8px">Тестовый режим ЮKassa: оплата тестовыми картами, деньги не списываются.</div>`;
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
let _adminUsersCache = [];
function renderAdminUsersTable(users) {
  const planLabel = { month1: '1 мес', month3: '3 мес', month12: '12 мес', manual: 'Вручную' };
  const tbody = document.getElementById('adminUsersTbody');
  if (!tbody) return;
  if (!users.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="color:var(--muted);text-align:center;padding:14px">Ничего не найдено</td></tr>';
    return;
  }
  tbody.innerHTML = users.map(u => {
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
        <button class="btn btn-sm ${u.crmEnabled ? 'btn-p' : ''}" onclick="adminToggleCrm(${u.id},'${u.username}',${u.crmEnabled ? 0 : 1})" title="CRM-интеграция">${u.crmEnabled ? '🔗 CRM вкл' : '🔗 CRM'}</button>
        <button class="btn btn-sm btn-dng" onclick="adminDeleteUser(${u.id},'${u.username}')" title="Удалить">🗑</button>
      </td>
    </tr>`;
  }).join('');
}
function filterAdminUsers() {
  const q = (document.getElementById('adminUserSearch')?.value || '').trim().toLowerCase();
  if (!q) return renderAdminUsersTable(_adminUsersCache);
  renderAdminUsersTable(_adminUsersCache.filter(u => (u.username || '').toLowerCase().includes(q)));
}

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

    _adminUsersCache = users;
    filterAdminUsers();

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
    const detected = Object.entries(j.detected || {})
      .map(([type, col]) => `${escHtml(type)} ← «${escHtml(String(col).slice(0, 40))}»`).join('; ');
    resultEl.innerHTML = `✅ Всего: <b>${j.total}</b> компаний · новых: <b>${j.inserted}</b> · обогащено: <b>${j.enriched}</b>${errors}` +
      (detected ? `<div style="color:var(--muted);margin-top:4px">Лист «${escHtml(j.sheetName || '')}». Колонки: ${detected}</div>` : '');
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

async function setFsaToken() {
  const token = document.getElementById('fsaTokenInput').value.trim();
  const msg   = document.getElementById('fsaTokenMsg');
  if (!token) { msg.style.color = 'var(--err)'; msg.textContent = 'Введите токен'; return; }
  try {
    await apiFetch('/api/system/settoken', { method: 'POST', body: JSON.stringify({ token }) });
    msg.style.color = '#16a34a';
    msg.textContent = '✅ Токен установлен. Парсер использует его до перезапуска сервера или сброса.';
    document.getElementById('fsaTokenInput').value = '';
  } catch(e) { msg.style.color = 'var(--err)'; msg.textContent = '❌ ' + e.message; }
}

async function clearFsaToken() {
  const msg = document.getElementById('fsaTokenMsg');
  try {
    await apiFetch('/api/system/settoken', { method: 'DELETE' });
    msg.style.color = '#16a34a';
    msg.textContent = '✅ Ручной токен сброшен — парсер будет логиниться автоматически.';
  } catch(e) { msg.style.color = 'var(--err)'; msg.textContent = '❌ ' + e.message; }
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

async function adminToggleCrm(userId, username, enable) {
  const action = enable ? 'Включить' : 'Отключить';
  if (!confirm(`${action} CRM-интеграцию пользователю "${username}"?`)) return;
  try {
    await apiFetch(`/api/admin/users/${userId}/crm`, { method: 'PUT', body: JSON.stringify({ enabled: !!enable }) });
    showAlert(enable ? 'CRM-интеграция включена' : 'CRM-интеграция отключена');
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
  initFilters();
  loadFavsCache();
  showPage('home');
  loadStats();
  loadSubscriptionStatus();
  loadTable().catch(err => {
    if (err.message && err.message.includes('SUBSCRIPTION_REQUIRED')) {
      openModal('noAccessModal');
    }
  });
  loadRecentStrip();
  const crmTab = document.getElementById('crmTab');
  if (crmTab) crmTab.style.display = State.user?.crmEnabled ? '' : 'none';

  // Блок пользователя внизу бокового меню.
  const nameEl = document.getElementById('railUser');
  if (nameEl && State.user) {
    nameEl.textContent = State.user.username || '';
    const roleEl = document.getElementById('railRole');
    if (roleEl) roleEl.textContent = (State.user.role === 'admin' ? 'Администратор' : 'Пользователь') + ' · профиль';
    const avaEl = document.getElementById('railAvatar');
    if (avaEl) avaEl.textContent = (State.user.username || '?').slice(0, 1);
  }
  pollStatus();
  refreshSupportBadge();
  if (!State.supportBadgeTimer) {
    State.supportBadgeTimer = setInterval(() => { if (State.token && !document.hidden) refreshSupportBadge(); }, 60000);
  }
}

// Телефон: меню выезжает поверх страницы по кнопке ☰ в шапке.
function toggleMobileNav(force) {
  const on = typeof force === 'boolean' ? force : !document.body.classList.contains('nav-open');
  document.body.classList.toggle('nav-open', on);
}

// Свёрнутое боковое меню (только иконки) — запоминаем выбор пользователя.
function toggleRail(force) {
  const on = typeof force === 'boolean' ? force : !document.body.classList.contains('rail-collapsed');
  document.body.classList.toggle('rail-collapsed', on);
  const btn = document.querySelector('.rail-toggle');
  if (btn) {
    btn.title = on ? 'Развернуть меню' : 'Свернуть меню';
    btn.querySelector('.nav-l').textContent = on ? 'Развернуть' : 'Свернуть';
  }
  try { localStorage.setItem('rail_collapsed', on ? '1' : ''); } catch (_) {}
  if (State.mapInstance) setTimeout(() => State.mapInstance.resize(), 200);
}

// Браузер принимал поля поиска и фильтров за форму входа и предлагал
// сохранённые пароли и почту. Всем полям вне форм входа/регистрации/смены
// пароля явно запрещаем автозаполнение — включая те, что рисуются позже.
const AUTH_FORMS = '#loginForm, #registerForm, #confirmEmailForm, #pwForm';
function hardenAutofill(root) {
  (root.querySelectorAll ? root.querySelectorAll('input, textarea') : []).forEach(el => {
    if (el.closest(AUTH_FORMS) || el.type === 'file' || el.type === 'checkbox' || el.type === 'radio') return;
    if (el.getAttribute('autocomplete') !== 'off') el.setAttribute('autocomplete', 'off');
    el.setAttribute('data-lpignore', 'true');
    el.setAttribute('data-1p-ignore', '');
  });
}

document.addEventListener('DOMContentLoaded', () => {
  hardenAutofill(document);
  new MutationObserver(muts => muts.forEach(m => m.addedNodes.forEach(n => {
    if (n.nodeType === 1) hardenAutofill(n.matches && n.matches('input, textarea') ? n.parentNode : n);
  }))).observe(document.body, { childList: true, subtree: true });
  try { if (localStorage.getItem('rail_collapsed')) toggleRail(true); } catch (_) {}
  ['csManuf','csAddress','csProduct'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.querySelectorAll('.date-mask').forEach(attachDateMask);
  checkAuth();
});

// ── Модалка "В заметку" ───────────────────────────────────────────────────
let _atnLink = null;
let _atnAllNotes = [];

// link — { kind: 'company', inn, label } или { kind: 'decl', id, label }:
// в заметку попадает ссылка на карточку внутри сервиса, а не на сайт ФСА.
async function openAddToNoteModal(link) {
  _atnLink = link;
  document.getElementById('atnLabel').textContent = (link.kind === 'company' ? 'Компания: ' : 'Декларация: ') + link.label;
  // Заголовок не подставляем: номер декларации или «ООО … (ИНН …)» в названии
  // заметки читались как мусор. Пусто — возьмём название компании при создании.
  document.getElementById('atnNewTitle').value = '';
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
  const title = document.getElementById('atnNewTitle').value.trim() || (_atnLink && _atnLink.label) || 'Заметка';
  try {
    await apiFetch('/api/notes', { method: 'POST', body: JSON.stringify({
      title, content: '', links: _atnLink ? [_atnLink] : []
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
  person:  { label: 'Контактное лицо', bg: '#E4DFEC', color: '#5B3E7A', icon: '🟣' },
};

function toggleMydbUpload() {
  if (State.mydbUploading) return; // не скрывать зону во время загрузки
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
  if (State.mydbUploading) return;

  const MAX_MB = 50;
  if (file.size > MAX_MB * 1024 * 1024) {
    const prog = document.getElementById('mydbUploadProgress');
    const res  = document.getElementById('mydbUploadResult');
    prog.style.display = 'none';
    res.style.display  = 'block';
    res.innerHTML = `<div style="color:var(--err);font-size:13px">❌ Файл слишком большой (${(file.size/1024/1024).toFixed(1)} МБ). Максимум ${MAX_MB} МБ. Разбейте базу на части.</div>`;
    return;
  }

  const prog = document.getElementById('mydbUploadProgress');
  const res  = document.getElementById('mydbUploadResult');
  State.mydbUploading = true;
  prog.style.display = 'block';
  res.style.display  = 'none';
  prog.textContent   = '⏳ Загружаем файл...';

  const fd = new FormData();
  fd.append('file', file);
  try {
    const r = await fetch('/api/user/contacts/preview', {
      method: 'POST',
      headers: State.token ? { Authorization: `Bearer ${State.token}` } : {},
      body: fd,
    });
    let data;
    try {
      data = await r.json();
    } catch {
      throw new Error(`Ошибка сервера (${r.status}). Попробуйте ещё раз.`);
    }
    if (r.status === 401) {
      handleLogout();
      throw new Error('Сессия истекла. Войдите снова.');
    }
    if (r.status === 403 && data?.code === 'SUBSCRIPTION_REQUIRED') {
      openModal('noAccessModal');
      throw new Error('Требуется подписка');
    }
    if (!r.ok || data.error) {
      throw new Error(data.error || `Ошибка сервера (${r.status})`);
    }

    prog.style.display = 'none';
    openMydbColPicker(data);
  } catch(e) {
    prog.style.display = 'none';
    res.style.display = 'block';
    res.innerHTML = `<div style="color:var(--err);font-size:13px">❌ ${escHtml(e.message)}</div>`;
  } finally {
    State.mydbUploading = false;
  }
}

// mydbMapping = { colIdx: string[] }  — массив типов на колонку
function _mapTypes(colIdx)  { return State.mydbMapping[colIdx] || []; }
function _hasType(type)     { return Object.values(State.mydbMapping).some(arr => arr.includes(type)); }

function openMydbColPicker(previewData) {
  State.mydbPreview = previewData;
  State.mydbMapping = {};

  // Применяем подсказку (каждый тип → массив)
  const sc = previewData.suggestedCols || {};
  for (const [type, idx] of Object.entries(sc)) {
    if (idx >= 0 && MYDB_TYPES[type]) {
      if (!State.mydbMapping[idx]) State.mydbMapping[idx] = [];
      State.mydbMapping[idx].push(type);
    }
  }

  const info = [previewData.originalName];
  if (previewData.sheetCount > 1) info.push(`лист «${previewData.sheetName}»`);
  if (previewData.dataRows) info.push(`${previewData.dataRows} строк данных`);
  info.push(previewData.headerRow ? `шапка в строке ${previewData.headerRow}` : 'без шапки');
  const autoFound = Object.values(sc).some(i => i >= 0);
  document.getElementById('mydbColModalSub').textContent = info.join(' · ') + ' · ' + (autoFound
    ? 'колонки определены автоматически — проверьте и при необходимости исправьте, нажав на заголовок'
    : 'нажмите на заголовок и выберите тип(ы)');

  renderColPickerTable();
  openModal('mydbColModal');
}

function _colBadgeHtml(colIdx) {
  const types = _mapTypes(colIdx);
  if (!types.length) {
    return `<div style="margin-top:5px;display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:12px;font-size:11px;background:#f1f5f9;color:#94a3b8;border:1px dashed #cbd5e1;cursor:pointer">+ выбрать</div>`;
  }
  const chips = types.map(type => {
    const t = MYDB_TYPES[type];
    return `<span style="padding:2px 7px;border-radius:10px;font-size:10px;font-weight:700;background:${t.bg};color:${t.color};border:1px solid ${t.color}40">${t.icon} ${t.label}</span>`;
  }).join('');
  return `<div style="margin-top:5px;display:flex;flex-wrap:wrap;gap:3px;cursor:pointer">${chips} <span style="align-self:center;opacity:.5;font-size:10px">▾</span></div>`;
}

function _colThBg(colIdx) {
  const types = _mapTypes(colIdx);
  return types.length ? (MYDB_TYPES[types[0]]?.bg || '#f8fafc') : '#f8fafc';
}

function _colTdBg(colIdx) {
  const types = _mapTypes(colIdx);
  return types.length ? (MYDB_TYPES[types[0]]?.bg || '') + '70' : '';
}

function renderColPickerTable() {
  const { headers, sampleRows } = State.mydbPreview;

  const thCells = headers.map((h, i) => `
    <th data-col="${i}" onclick="openColTypePicker(event,${i})"
      style="background:${_colThBg(i)};min-width:110px;max-width:155px;padding:8px 10px;border:1px solid #d1d5db;vertical-align:top;text-align:left;cursor:pointer;transition:.15s"
      onmouseenter="this.style.filter='brightness(.96)'" onmouseleave="this.style.filter=''">
      <div style="font-size:12px;font-weight:600;color:#374151;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:130px" title="${escHtml(h)}">${escHtml(h||'(пусто)')}</div>
      ${_colBadgeHtml(i)}
    </th>`).join('');

  const bodyRows = sampleRows.map(row => {
    const cells = headers.map((_, i) => {
      const val = String(row[i] ?? '');
      return `<td data-col="${i}" style="background:${_colTdBg(i)};padding:5px 10px;border:1px solid #e5e7eb;font-size:12px;color:#374151;max-width:155px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(val)}">${escHtml(val)}</td>`;
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

  const sampleVals = (State.mydbPreview?.sampleRows || []).map(r => String(r[colIdx] || ''));
  const looksLongText = sampleVals.some(v => v.length > 30 && /\d/.test(v));
  const mixedHint = looksLongText
    ? `<div style="font-size:10px;color:#7F2000;background:#FFDDC1;border-radius:5px;padding:3px 7px;margin-bottom:7px">
        ⚠ Смешанный текст — можно выбрать сразу несколько типов
       </div>` : '';

  function renderPickerContent() {
    const selected = _mapTypes(colIdx);
    const btns = Object.entries(MYDB_TYPES).map(([v, t]) => {
      const on = selected.includes(v);
      return `<button onclick="toggleMydbColType(${colIdx},'${v}')"
        style="padding:7px 8px;border-radius:7px;border:2px solid ${on ? t.color : t.color+'50'};
               background:${on ? t.bg : 'white'};color:${t.color};font-size:12px;font-weight:600;
               cursor:pointer;text-align:left;display:flex;align-items:center;gap:5px;transition:.1s;
               ${on ? 'box-shadow:0 0 0 2px '+t.color+'30' : ''}"
        onmouseenter="this.style.filter='brightness(.94)'" onmouseleave="this.style.filter=''">
        ${on ? '✓' : '○'} ${t.icon} ${t.label}
      </button>`;
    }).join('');
    return `
      <div style="font-size:11px;color:#6b7280;margin-bottom:7px;font-weight:500">
        «${escHtml(headerName.slice(0, 22))}» — выберите тип(ы):
      </div>
      ${mixedHint}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-bottom:8px">${btns}</div>
      <button onclick="clearMydbColTypes(${colIdx})"
        style="width:100%;padding:5px;border-radius:6px;border:1px solid #e5e7eb;
               background:#f9fafb;color:#9ca3af;font-size:11px;cursor:pointer">
        ✕ Очистить колонку
      </button>`;
  }

  picker._refresh = () => { picker.innerHTML = renderPickerContent(); };
  picker.innerHTML = renderPickerContent();

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

function toggleMydbColType(colIdx, type) {
  const mapping = State.mydbMapping;
  if (!mapping[colIdx]) mapping[colIdx] = [];

  // Каждый тип — только на одной колонке (убираем с других)
  for (const [k, arr] of Object.entries(mapping)) {
    if (Number(k) !== colIdx && arr.includes(type)) {
      mapping[k] = arr.filter(t => t !== type);
      _refreshColHeader(Number(k));
    }
  }

  const arr = mapping[colIdx];
  const idx = arr.indexOf(type);
  if (idx >= 0) arr.splice(idx, 1); else arr.push(type);

  _refreshColHeader(colIdx);
  updateMydbColStatus();

  // Перерисовываем кнопки пикера с новым состоянием (галочки)
  document.getElementById('_colPicker')?._refresh?.();
}

function clearMydbColTypes(colIdx) {
  State.mydbMapping[colIdx] = [];
  _refreshColHeader(colIdx);
  updateMydbColStatus();
  document.getElementById('_colPicker')?._refresh?.();
}

function _refreshColHeader(colIdx) {
  const th = document.querySelector(`#mydbColTable th[data-col="${colIdx}"]`);
  if (!th) return;
  th.style.background = _colThBg(colIdx);
  const badgeEl = th.querySelector('div:last-child');
  if (badgeEl) badgeEl.outerHTML = _colBadgeHtml(colIdx);
  // Обновляем цвет ячеек данных
  const tdBg = _colTdBg(colIdx);
  document.querySelectorAll(`#mydbColTable td[data-col="${colIdx}"]`).forEach(el => {
    el.style.background = tdBg;
  });
}

function updateMydbColStatus() {
  const hasContact = _hasType('phone') || _hasType('phone2') || _hasType('email');
  const hasKey = _hasType('inn') || _hasType('name');
  const btn = document.getElementById('mydbColConfirmBtn');
  btn.disabled = !(hasContact && hasKey);
  btn.title = !hasContact ? 'Назначьте колонку с Телефоном или Email'
    : !hasKey ? 'Назначьте колонку с ИНН или Названием' : '';

  const parts = [];
  for (const [idxStr, types] of Object.entries(State.mydbMapping)) {
    for (const type of types) {
      const td = MYDB_TYPES[type];
      if (td) parts.push(`<span style="padding:2px 10px;border-radius:10px;font-size:11px;background:${td.bg};color:${td.color};border:1px solid ${td.color}40">${td.icon} ${td.label} → кол.${Number(idxStr)+1}</span>`);
    }
  }

  document.getElementById('mydbColStatus').innerHTML = parts.length
    ? parts.join(' ')
    : '<span style="color:var(--muted)">Нажмите на заголовок колонки чтобы назначить тип</span>';
}

async function confirmMydbMapping() {
  const { uploadId, originalName } = State.mydbPreview || {};
  if (!uploadId) return;

  // Строим mapping: тип → индекс колонки (один тип может быть у нескольких типов на одной колонке)
  const mapping = {};
  for (const [idx, types] of Object.entries(State.mydbMapping)) {
    for (const type of (types || [])) {
      mapping[type] = Number(idx);
    }
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
    const extra = [];
    if (data.noContacts) extra.push(`без телефона и email: ${data.noContacts}`);
    if (data.merged) extra.push(`строк-продолжений объединено: ${data.merged}`);
    res.innerHTML = `<div style="color:#16a34a;font-size:13px;background:#f0fdf4;padding:10px 14px;border-radius:var(--r)">
      ✅ <b>${escHtml(originalName || 'Файл')}</b> импортирован: <b>${data.imported}</b> компаний
      &nbsp;·&nbsp; Совпало с реестром: <b>${data.matched}</b>
      &nbsp;·&nbsp; Только у вас: <b>${data.private}</b>
      ${extra.length ? `<div style="color:var(--muted);font-size:12px;margin-top:4px">${extra.join(' · ')}</div>` : ''}
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
          <div><span style="color:var(--muted)">Записей:</span> <b>${u.totalRows}</b></div>
          <div><span style="color:var(--muted)">Совпало:</span> <b style="color:#16a34a">${u.matchedRows}</b></div>
          <div><span style="color:var(--muted)">Только у вас:</span> <b style="color:#0e4a3c">${u.privateRows}</b></div>
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
        <div style="flex:1;min-width:120px;font-weight:500">${escHtml(fmtCompany(r.companyName) || '—')}</div>
        ${r.inn ? `<div style="color:var(--muted);font-size:12px">ИНН: ${escHtml(r.inn)}</div>` : ''}
        ${r.contactName ? `<div style="font-size:12px">👤 ${escHtml(r.contactName)}</div>` : ''}
        ${r.phone ? `<div style="color:#0e4a3c">📞 ${escHtml(r.phone)}${r.phone2 ? ' · ' + escHtml(r.phone2) : ''}</div>` : ''}
        ${r.email ? `<div style="color:var(--muted);font-size:12px">✉ ${escHtml(r.email)}</div>` : ''}
        ${r.address ? `<div style="color:var(--muted);font-size:12px;flex-basis:100%;word-break:break-word">📍 ${escHtml(r.address)}</div>` : ''}
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
      if (c.contactName) parts.push(`<span style="font-size:12px">👤 ${escHtml(c.contactName)}</span>`);
      if (c.phone)  parts.push(`<span style="color:#0e4a3c;font-weight:500">📞 ${escHtml(c.phone)}${c.phone2 ? ' · ' + escHtml(c.phone2) : ''}</span>`);
      if (c.email)  parts.push(`<span style="color:var(--muted);font-size:12px">✉ ${escHtml(c.email)}</span>`);
      if (c.address) parts.push(`<span style="color:var(--muted);font-size:12px">📍 ${escHtml(c.address)}</span>`);
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

const NOTE_STAGES = {
  meeting:   { label: 'Встреча',   color: '#6b7280' },
  contract:  { label: 'Договор',   color: '#0e4a3c' },
  documents: { label: 'Документы', color: '#7c3aed' },
  call:      { label: 'Звонок',    color: '#0284c7' },
  payment:   { label: 'Оплата',    color: '#16a34a' },
  shipment:  { label: 'Отгрузка',  color: '#ea580c' },
  check:     { label: 'Проверка',  color: '#a32d2d' },
};

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
    const internal = n.links.filter(l => l.kind === 'company' || l.kind === 'decl');
    const linksHtml = internal.slice(0, 2).map(l => `<span class="note-chip" title="${escHtml(l.label)}">${l.kind === 'company' ? '🏢' : '📄'} ${escHtml((l.label || '').slice(0, 28))}</span>`).join('')
      + (n.links.length > Math.min(2, internal.length) ? `<span class="note-chip">+${n.links.length - Math.min(2, internal.length)}</span>` : '');
    const stage = NOTE_STAGES[n.stage];
    const stageHtml = stage
      ? `<span class="note-chip" style="background:${stage.color}1a;color:${stage.color}">${stage.label}</span>`
      : '';
    const notifyHtml = (n.notifyTime && !n.notifySentDate)
      ? `<span class="note-chip" style="background:#fff7e6;color:#7a5b00">🔔 ${new Date(n.notifyTime).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</span>`
      : '';
    return `
      <div class="note-card" onclick="openNoteModal(${n.id})">
        <div class="note-card-title">${escHtml(n.title)}</div>
        ${n.content ? `<div class="note-card-body">${escHtml(n.content)}</div>` : ''}
        <div class="note-card-footer">
          <div style="display:flex;gap:6px;flex-wrap:wrap">${stageHtml}${notifyHtml}${linksHtml}</div>
          <span style="font-size:10px;color:var(--muted)">${new Date(n.updatedAt).toLocaleDateString('ru-RU')}</span>
        </div>
      </div>`;
  }).join('');
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── CRM-интеграция ───────────────────────────────────────────────────────
function crmReadFilter() {
  return {
    product: document.getElementById('crmFProduct').value.trim(),
    address: document.getElementById('crmFAddress').value.trim(),
    farmerType: document.getElementById('crmFFarmerType').value,
    batchMin: document.getElementById('crmFBatchMin').value,
    batchMax: document.getElementById('crmFBatchMax').value,
  };
}

async function loadCrmPage() {
  const statusEl = document.getElementById('crmStatus');
  statusEl.textContent = '';
  try {
    const row = await apiFetch('/api/crm/integration');
    document.getElementById('crmDeleteBtn').style.display = row ? '' : 'none';
    if (!row) return;
    document.getElementById('crmProvider').value = row.provider || 'bitrix24';
    document.getElementById('crmWebhookUrl').placeholder = row.webhookUrl || 'https://ваш-портал.bitrix24.ru/rest/1/xxxxxxxxxxxxxxxx/';
    const f = row.filterJson || {};
    document.getElementById('crmFProduct').value = f.product || '';
    document.getElementById('crmFAddress').value = f.address || '';
    document.getElementById('crmFFarmerType').value = f.farmerType || '';
    document.getElementById('crmFBatchMin').value = f.batchMin || '';
    document.getElementById('crmFBatchMax').value = f.batchMax || '';
    const lastSync = row.lastSyncAt ? new Date(row.lastSyncAt).toLocaleString('ru-RU') : 'ещё не запускалась';
    statusEl.innerHTML = `Вебхук: <code>${escHtml(row.webhookUrl)}</code> · Последняя синхронизация: ${lastSync}` +
      (row.lastError ? `<br><span style="color:var(--dng)">Ошибка: ${escHtml(row.lastError)}</span>` : '');
  } catch (e) {
    if (e.message !== 'SUBSCRIPTION_REQUIRED') statusEl.textContent = e.message;
  }
}

async function saveCrmIntegration() {
  const webhookUrl = document.getElementById('crmWebhookUrl').value.trim();
  const provider = document.getElementById('crmProvider').value;
  const statusEl = document.getElementById('crmStatus');
  try {
    await apiFetch('/api/crm/integration', {
      method: 'PUT',
      body: JSON.stringify({ provider, webhookUrl: webhookUrl || undefined, filter: crmReadFilter() }),
    });
    showAlert('Настройки CRM-интеграции сохранены');
    loadCrmPage();
  } catch (e) { statusEl.textContent = e.message; statusEl.style.color = 'var(--dng)'; }
}

async function previewCrmFilter() {
  const el = document.getElementById('crmPreviewResult');
  el.textContent = 'Проверяю...';
  try {
    const data = await apiFetch('/api/crm/integration/preview', { method: 'POST', body: JSON.stringify({ filter: crmReadFilter() }) });
    el.textContent = `За последние 24ч под фильтр подошло бы: ${data.count} деклараций`;
  } catch (e) { el.textContent = e.message; }
}

async function testCrmIntegration() {
  const el = document.getElementById('crmStatus');
  el.textContent = 'Отправляю тестовый лид...';
  try {
    const data = await apiFetch('/api/crm/integration/test', { method: 'POST' });
    el.textContent = data.message;
    el.style.color = 'var(--succ)';
  } catch (e) { el.textContent = e.message; el.style.color = 'var(--dng)'; }
}

async function deleteCrmIntegration() {
  if (!confirm('Удалить настройки CRM-интеграции? Выгрузка лидов остановится.')) return;
  try {
    await apiFetch('/api/crm/integration', { method: 'DELETE' });
    showAlert('Интеграция удалена');
    loadCrmPage();
  } catch (e) { showAlert(e.message, 'err'); }
}

// Русское склонение по числу: plural(1,'просмотр','просмотра','просмотров') → 'просмотр'
function plural(n, one, few, many) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

function openNoteModal(noteId) {
  _editingNoteId = noteId;
  const note = noteId ? _notes.find(n => n.id === noteId) : null;
  document.getElementById('noteModalTitle').textContent = note ? 'Редактировать заметку' : 'Новая заметка';
  document.getElementById('noteTitle').value = note ? note.title : '';
  document.getElementById('noteStage').value = note ? (note.stage || '') : '';
  document.getElementById('noteNotifyTime').value = note ? isoToLocalInputValue(note.notifyTime) : '';
  document.getElementById('noteContent').value = note ? (note.content || '') : '';
  document.getElementById('noteDeleteBtn').style.display = note ? '' : 'none';

  const linksContainer = document.getElementById('noteLinks');
  linksContainer.innerHTML = '';
  (note ? note.links : []).forEach(l => addNoteLinkRow(l));

  openModal('noteModal');
}

// datetime-local хранит/показывает локальное время браузера без таймзоны —
// переводим в ISO на границе запроса именно здесь (в браузере), пока известен
// правильный локальный офсет пользователя, а не на сервере (у него свой).
function isoToLocalInputValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function addNoteLink() {
  addNoteLinkRow({ label: '', url: '' });
}

// Связанная компания/декларация открывается внутри сервиса.
function openNoteLink(link) {
  closeModal('noteModal');
  if (link.kind === 'company') openCompany(link.inn || '', link.label || '');
  else if (link.kind === 'decl') openDetail(link.id);
}

// Внутренние ссылки (компания/декларация) — нередактируемая плашка, по клику
// открывается карточка в сервисе; внешние — два поля, как раньше.
function addNoteLinkRow(link) {
  const container = document.getElementById('noteLinks');
  const row = document.createElement('div');
  row.className = 'note-link-row';
  if (link.kind === 'company' || link.kind === 'decl') {
    row.dataset.link = JSON.stringify(link);
    row.classList.add('note-link-int');
    const kindLabel = link.kind === 'company' ? 'Компания' : 'Декларация';
    row.innerHTML = `
      <button type="button" class="note-link-open" title="Открыть карточку">
        <small>${kindLabel}</small><span></span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M7 17L17 7M9 7h8v8"/></svg>
      </button>
      <button type="button" class="note-rm" title="Убрать из заметки">✕</button>`;
    row.querySelector('.note-link-open span').textContent = link.label || (link.kind === 'company' ? link.inn : link.id);
    row.querySelector('.note-link-open').onclick = () => openNoteLink(link);
  } else {
    row.innerHTML = `
      <input type="text" class="fi note-link-label" placeholder="Название" style="width:35%" autocomplete="off">
      <input type="url" class="fi note-link-url" placeholder="https://..." style="flex:1" autocomplete="off">
      <button type="button" class="note-rm" title="Убрать">✕</button>`;
    row.querySelector('.note-link-label').value = link.label || '';
    row.querySelector('.note-link-url').value = link.url || '';
  }
  row.querySelector('.note-rm').onclick = () => row.remove();
  container.appendChild(row);
}

let _savingNote = false;
async function saveNote() {
  if (_savingNote) return;
  const title = document.getElementById('noteTitle').value.trim();
  if (!title) { showAlert('Введите заголовок заметки', 'err'); return; }

  _savingNote = true;

  const content = document.getElementById('noteContent').value;
  const stage = document.getElementById('noteStage').value;
  const notifyInput = document.getElementById('noteNotifyTime').value;
  const notifyTime = notifyInput ? new Date(notifyInput).toISOString() : null;

  const linkRows = document.querySelectorAll('#noteLinks .note-link-row');
  const links = [];
  linkRows.forEach(row => {
    if (row.dataset.link) { links.push(JSON.parse(row.dataset.link)); return; }
    const url = row.querySelector('.note-link-url').value.trim();
    const label = row.querySelector('.note-link-label').value.trim();
    if (url) links.push({ label: label || url, url });
  });

  try {
    const body = { title, content, links, stage, notifyTime };
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
