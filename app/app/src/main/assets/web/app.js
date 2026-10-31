// wag2api 双引擎控制台 v2
// 一个界面、两个引擎：顶部切 AIS / AG，底部五页两边通用。
// AIS 走 /ais/api/*（AIStudio2API），AG 走 /api/*（Node，经前门转发）。

let engine = localStorage.getItem('wag2api_engine') === 'ag' ? 'ag' : 'ais';
let currentTab = 'overview';
let engineInfo = { supported: false, enabled: false, state: 'OFF', default_engine: 'ais', ais: { available: true, running: true, base_url: '' } };
let lastStats = { ais: null, ag: null };
const chatState = { ais: { history: [], html: '' }, ag: { history: [], html: '' } };
const modelCache = { ais: null, ag: null };
const aisRefreshTimes = {};
let aisDiscoveredAccounts = [];
let aisAccountsCache = [];           // 缓存 /ais/api/accounts 返回的账号数组
const aisRefreshErrors = {};         // id -> 最近一次刷新失败原因
const aisRefreshResults = {};        // id -> 最近一次刷新变化摘要
const aisRefreshingIds = new Set();  // 正在刷新的账号 ID
let aisRefreshingAll = false;        // 是否正在批量刷新全部
let aisRefreshDone = 0;
let aisRefreshTotal = 0;
const aisSelectedAuthUsers = new Set();// Cookie discover 勾选的 auth_user 集合
let aisConfigCache = null;           // 缓存 /ais/api/config
let aisCooldownsCache = [];          // 缓存 /ais/api/cooldowns
let aisRequestsCache = [];           // 缓存 /ais/api/requests
let aisEditingId = '';               // 当前正在编辑的 AIS 账号 ID
const aisTestResults = {};           // id -> { ok, latency_ms, model, error }
const aisTestingAccounts = new Set();// 正在测试的 AIS 账号 ID
let aisTestingAll = false;           // 是否正在全部测试 AIS 账号
let aisAccountsLoadedAt = 0;         // 最近一次拉取 AIS 账号列表的时间戳
let aisRecentRecordsCache = [];      // 最近请求记录缓存（用于计算账号连续失败与成功率）
let aisHeatmapCache = { ts: 0, list: [] }; // 91天按日分桶缓存
let aisLogMode = 'requests';         // 'requests' | 'system'
const agQuota = {};          // email -> quota
const agTestResults = {};    // email -> test result
const agTestingAccounts = new Set();
let agTestingAll = false;
let agSchedulingState = {};
let agAccountsCache = [];
let activePollTimer = null;
let currentAbort = null;

const META = {
  ais: { title: 'AI Studio', icon: '✦', name: 'AIS 引擎', vendor: 'Google AI Studio' },
  ag: { title: 'Antigravity', icon: '⚡', name: 'AG 引擎', vendor: 'Google Antigravity' },
};

// ── 通用工具 ────────────────────────────────────────────
const $ = id => document.getElementById(id);

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(1) + 'k';
  return n.toLocaleString();
}

function fmtPct(r) { return r === null || r === undefined ? '--' : (r * 100).toFixed(1) + '%'; }
function fmtSec(ms) {
  if (ms === null || ms === undefined || ms === '') return '--';
  const n = Number(ms);
  if (isNaN(n) || n < 0) return '--';
  if (n === 0) return '0s';
  if (n >= 10000) return (n / 1000).toFixed(1) + 's';
  const s = (n / 1000).toFixed(2);
  return (s === '0.00' ? '<0.01' : s) + 's';
}
// 生成速度：输出(含思考) token ÷ (总耗时 − 首字)，首字未知时用总耗时
function fmtTps(outTok, totalMs, ttftMs) {
  const t = Number(outTok) || 0, total = Number(totalMs) || 0, ttft = Number(ttftMs) || 0;
  if (t <= 0 || total <= 0) return '';
  let gen = total - ttft;
  if (gen < 200) gen = total;
  const v = t / (gen / 1000);
  return (v >= 100 ? Math.round(v) : v.toFixed(1)) + ' tok/s';
}
function fmtMs(ms) {
  const n = Number(ms);
  if (ms === null || ms === undefined || ms === '' || isNaN(n) || n <= 0) return '--';
  return fmtSec(n);
}

// 独立运行：standalone=只有 AG；dual=Linux / 源码版（没有安卓宿主）。
// 设置了 ADMIN_KEY 时管理接口需带密钥
const isStandalone = () => !!engineInfo.standalone;
const isDual = () => !!engineInfo.dual;
const API_PREFIX = typeof location !== 'undefined' && location.pathname.startsWith('/wag') ? '/wag' : '';
function apiUrl(path) {
  if (!path || typeof path !== 'string' || path.startsWith('http')) return path;
  return API_PREFIX + (path.startsWith('/') ? path : '/' + path);
}
function authHeaders(h) {
  const k = localStorage.getItem('wag2api_admin_key');
  return k ? { ...(h || {}), 'x-admin-key': k } : (h || {});
}

function maskProxyUrl(raw) {
  if (!raw) return '直连';
  try {
    const u = new URL(raw.includes('://') ? raw : `http://${raw}`);
    const auth = u.username ? '***@' : '';
    const port = u.port ? `:${u.port}` : '';
    return `${u.protocol}//${auth}${u.hostname}${port}`;
  } catch (e) {
    return String(raw).replace(/:\/\/[^@]+@/, '://***@');
  }
}

async function getJson(url, opts, retried) {
  const finalUrl = apiUrl(url);
  const res = await fetch(finalUrl, { cache: 'no-store', ...opts, headers: authHeaders(opts && opts.headers) });
  if (res.status === 401 && !retried && (url.startsWith('/api/') || url.startsWith('/panel/api/') || url.startsWith('/ais/api/'))) {
    const k = prompt('此网关设置了管理密钥（ADMIN_KEY），请输入：', '');
    if (k) { localStorage.setItem('wag2api_admin_key', k.trim()); return getJson(url, opts, true); }
  }
  if (res.status === 204) {
    return { ok: true };
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* 非 JSON */ }
  if (!res.ok) {
    const err = data && data.error;
    const msg = (err && (err.message || err.code)) || (typeof err === 'string' ? err : '') || (data && (data.message || data.error)) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  if (data === null && url.startsWith('/ais/')) throw new Error('AIS 返回了无法解析的响应');
  return data;
}

function postJson(url, body) {
  return getJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
}

function putJson(url, body) {
  return getJson(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
}

function deleteReq(url) {
  return getJson(url, { method: 'DELETE' });
}

function showToast(msg, type = 'info') {
  let box = $('toastContainer');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toastContainer';
    box.className = 'toast-container';
    document.body.appendChild(box);
  }
  const item = document.createElement('div');
  item.className = `toast-msg ${type}`;
  item.textContent = msg;
  box.appendChild(item);
  setTimeout(() => item.remove(), 2300);
}

function copyText(str) {
  const done = () => showToast('已复制', 'success');
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(str).then(done).catch(() => fallbackCopy(str, done));
  } else fallbackCopy(str, done);
}

function fallbackCopy(str, done) {
  const ta = document.createElement('textarea');
  ta.value = str;
  ta.style.cssText = 'position:fixed;opacity:0;';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { showToast('复制失败，请手动长按复制', 'error'); }
  ta.remove();
}

function openModal(id) { $(id).classList.add('active'); }
function closeModal(id) {
  $(id).classList.remove('active');
  if (id === 'authModal') {
    if (activePollTimer) { clearInterval(activePollTimer); activePollTimer = null; }
  }
}

function showText(title, desc, text) {
  $('textTitle').textContent = title;
  $('textDesc').textContent = desc || '';
  $('textOutput').value = text;
  openModal('textModal');
}

document.addEventListener('click', e => {
  if (e.target.classList && e.target.classList.contains('modal-overlay')) closeModal(e.target.id);
});

// ── 引擎可用性 ──────────────────────────────────────────
const agReady = () => engineInfo.supported && engineInfo.state === 'READY';

async function refreshEngineInfo() {
  try {
    engineInfo = await getJson('/panel/api/engine/state');
  } catch (e) { /* 保持旧值 */ }
  const hasAg = !!engineInfo.supported;
  const mini = $('miniAg');
  const tabAg = $('tabSwitchAg');
  const switcherBar = $('engineSwitcherBar');

  if (!hasAg) {
    if (tabAg) tabAg.style.display = 'none';
    if (mini) mini.textContent = '未内置';
    if (switcherBar) switcherBar.classList.add('single-engine');
    if (engine !== 'ais') {
      engine = 'ais';
      localStorage.setItem('wag2api_engine', 'ais');
    }
  } else {
    if (tabAg) {
      tabAg.style.display = '';
      if (engineInfo.state === 'READY') { mini.textContent = 'Google'; tabAg.classList.remove('disabled'); }
      else if (engineInfo.state === 'STARTING') { mini.textContent = '启动中'; tabAg.classList.add('disabled'); }
      else { mini.textContent = engineInfo.enabled ? '异常' : '已关闭'; tabAg.classList.add('disabled'); }
    }
    if (switcherBar) switcherBar.classList.remove('single-engine');
  }
  const sel = $('defaultEngineSelect');
  if (sel) {
    sel.value = engineInfo.default_engine || 'ais';
    const optAg = sel.querySelector('option[value="ag"]');
    if (optAg) optAg.style.display = hasAg ? '' : 'none';
  }
  return engineInfo;
}

/** AG 不可用时，在容器里放一个说明 + 一键启用 */
function agOffHtml() {
  if (!engineInfo.supported) {
    return `<div class="engine-off"><div class="big">此安装包不含 AG 引擎</div>
      <div class="muted">安装 wag2api.apk（完整版，arm64）即可使用 Google Antigravity，数据不丢。</div></div>`;
  }
  const s = engineInfo.state;
  const text = s === 'STARTING' ? 'AG 引擎正在启动…' : s === 'FAILED' ? 'AG 引擎启动失败' : 'AG 引擎已关闭';
  return `<div class="engine-off"><div class="big">${text}</div>
    <div class="muted" style="margin-bottom:12px;">${s === 'STARTING' ? '首次启动要解压 Node，稍等几秒会自动刷新。' : '打开后才能管理 Google 账号、查看额度和对话。'}</div>
    ${s === 'STARTING' ? '' : `<button class="btn btn-primary" onclick="${s === 'FAILED' ? 'restartAgEngine()' : 'toggleNodeEngine(true)'}">${s === 'FAILED' ? '重启 AG 引擎' : '启用 AG 引擎'}</button>`}</div>`;
}

// ── 引擎 / 页签切换 ─────────────────────────────────────
function applyEngineChrome() {
  const m = META[engine] || META.ais;
  $('tabSwitchAis').className = 'engine-tab' + (engine === 'ais' ? ' active ais-active' : '');
  $('tabSwitchAg').className = 'engine-tab' + (engine === 'ag' ? ' active ag-active' : '') + ($('tabSwitchAg').classList.contains('disabled') ? ' disabled' : '');
  document.body.classList.toggle('theme-ag', engine === 'ag');
  document.body.classList.toggle('theme-ais', engine === 'ais');
  $('brandIcon').textContent = m.icon;
  $('currentEngineBadge').textContent = m.title;
  if ($('navEngine')) $('navEngine').textContent = isStandalone() ? 'AG' : m.name;
  $('agEngineCard').style.display = engine === 'ag' && engineInfo.supported && !isStandalone() && !isDual() ? 'block' : 'none';
  if ($('aisEngineCard')) $('aisEngineCard').style.display = engine === 'ais' ? 'block' : 'none';
  if ($('aisLogSubTabs')) $('aisLogSubTabs').style.display = engine === 'ais' ? 'flex' : 'none';
}

function switchEngine(e) {
  if (e === engine || isStandalone()) return;
  // 保存当前对话现场
  chatState[engine].html = $('chatMessages').innerHTML;
  if (currentAbort) { currentAbort.abort(); currentAbort = null; }
  engine = e;
  localStorage.setItem('wag2api_engine', e);
  applyEngineChrome();
  renderCurrent();
  showToast(`已切换到 ${META[e].name}`, 'success');
}

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  $(`view-${tab}`).classList.add('active');
  const nav = document.querySelector(`.nav-item[data-tab="${tab}"]`);
  if (nav) nav.classList.add('active');
  renderCurrent();
}

function renderCurrent() {
  if (currentTab === 'overview') loadOverview();
  else if (currentTab === 'accounts') loadAccounts();
  else if (currentTab === 'keys') loadKeys();
  else if (currentTab === 'chat') loadChat();
  else if (currentTab === 'logs') loadLogs();
}

// ── 1. 概览 ─────────────────────────────────────────────
function setHeader(ok, text) {
  $('headerStatusText').textContent = text;
  const pill = $('headerStatus');
  pill.style.color = ok === true ? 'var(--primary)' : ok === false ? 'var(--danger)' : 'var(--warning)';
  pill.style.background = ok === true ? 'rgba(16,185,129,0.15)' : ok === false ? 'rgba(239,68,68,0.15)' : 'rgba(245,158,11,0.15)';
}

async function loadOverview() {
  await refreshEngineInfo();
  applyEngineChrome();
  if (!isStandalone()) loadGlobalSettings();
  const evEl = $('ovEngine');

  if (engine === 'ais') {
    try {
      const status = await getJson('/ais/api/status');
      const isRunning = status.state === 'RUNNING' || status.running;
      const [modelsRes, accountsRes] = await Promise.all([
        getJson('/ais/api/models').catch(() => ({ models: [] })),
        getJson('/ais/api/accounts').catch(() => ({ accounts: [] })),
      ]);
      const models = modelsRes.models || modelsRes.data || [];
      const accounts = accountsRes.accounts || [];
      if (Array.isArray(accountsRes.accounts)) aisAccountsCache = accounts;

      const ac = status.accounts || {};
      const readyAccs = ac.ready !== undefined ? ac.ready : accounts.filter(a => a.state === 'ready' || a.enabled).length;
      const totalAccs = ac.total !== undefined ? ac.total : accounts.length;
      $('ovAccounts').textContent = `${readyAccs} / ${totalAccs}`;

      evEl.textContent = status.state === 'RUNNING' ? (status.ready ? '● 就绪' : '● 运行中') : (status.state === 'LAUNCHING' ? '● 启动中' : '● 已停止');
      evEl.style.color = isRunning ? 'var(--primary)' : 'var(--warning)';
      setHeader(isRunning, isRunning ? 'AIS 运行中' : (status.state === 'LAUNCHING' ? 'AIS 启动中' : 'AIS 已停止'));

      if ($('aisVersionBadge')) $('aisVersionBadge').textContent = status.version ? 'v' + status.version : '';
      if ($('aisEngineSub')) $('aisEngineSub').textContent = '可用模型 ' + models.length + ' 个 · 活跃请求 ' + (status.active_requests || 0) + ' · 就绪 ' + (ac.ready ?? readyAccs) + (ac.busy ? ' / 忙碌 ' + ac.busy : '') + ' / 冷却 ' + (ac.cooldown || 0) + ' / 需认证 ' + (ac.auth_required || 0);
      if ($('aisEngineStateTag')) {
        $('aisEngineStateTag').className = 'tag ' + (isRunning ? 'tag-online' : 'tag-warn');
        $('aisEngineStateTag').textContent = status.state || (isRunning ? 'RUNNING' : 'STOPPED');
      }
      if ($('aisStartStopBtn')) {
        $('aisStartStopBtn').textContent = isRunning ? '⏹ 停止服务' : '▶ 启动服务';
        $('aisStartStopBtn').className = 'btn btn-sm ' + (isRunning ? 'btn-outline' : 'btn-primary');
      }

      await loadAisTokenStats(false);
    } catch (e) {
      setHeader(false, 'AIS 未响应');
      $('ovAccounts').textContent = '-';
      $('ovReq').textContent = '-';
      $('ovTokens').textContent = '-';
      evEl.textContent = '● 异常';
      evEl.style.color = 'var(--danger)';
      if ($('aisEngineStateTag')) {
        $('aisEngineStateTag').className = 'tag tag-offline';
        $('aisEngineStateTag').textContent = 'ERROR';
      }
      renderAisError(e.message);
    }
  } else {
    $('nodeEnabledToggle').checked = !!engineInfo.enabled;
    $('agEngineSub').textContent = `状态：${({ READY: '运行中', STARTING: '启动中', FAILED: '启动失败', OFF: '已关闭' })[engineInfo.state] || engineInfo.state}${engineInfo.port ? ' · 内部端口 ' + engineInfo.port : ''}`;
    if (!agReady()) {
      lastStats.ag = null;
      $('ovAccounts').textContent = '-';
      $('ovReq').textContent = '-';
      $('ovTokens').textContent = '-';
      evEl.textContent = engineInfo.state === 'STARTING' ? '● 启动中' : '● 未运行';
      evEl.style.color = 'var(--warning)';
      setHeader(null, 'AG 未运行');
      renderAgOffOverviewStats();
      if (engineInfo.state === 'STARTING') setTimeout(() => { if (engine === 'ag' && currentTab === 'overview') loadOverview(); }, 3000);
    } else {
      try {
        const [status, st] = await Promise.all([getJson('/api/status'), getJson('/api/stats')]);
        lastStats.ag = st;
        const accs = status.accounts || [];
        $('ovAccounts').textContent = `${accs.filter(a => a.hasRefreshToken).length} / ${accs.length}`;
        $('ovReq').textContent = fmtNum(st.today?.total_requests);
        $('ovTokens').textContent = fmtNum(st.today?.total_tokens);
        evEl.textContent = '● 就绪';
        evEl.style.color = 'var(--primary)';
        setHeader(true, '网关在线');
        await loadAgTokenStats(false);
      } catch (e) {
        setHeader(false, 'AG 无响应');
      }
    }
  }
}

function renderAisError(msg) {
  const box = $('overviewStatsContainer');
  if (!box) return;
  box.innerHTML = `<div class="card"><div class="empty" style="color:var(--danger)">AIS 引擎未响应：${escapeHtml(msg)}<div class="muted" style="margin-top:8px;"><button class="btn btn-primary btn-sm" onclick="startAisService()">尝试启动服务</button></div></div></div>`;
}

async function startAisService() {
  try {
    await postJson('/ais/api/control/start', {});
    showToast('已请求启动 AIS 服务', 'success');
    setTimeout(loadOverview, 1000);
  } catch (e) { showToast(`启动失败: ${e.message}`, 'error'); }
}

async function stopAisService() {
  try {
    await postJson('/ais/api/control/stop', {});
    showToast('已请求停止 AIS 服务', 'warn');
    setTimeout(loadOverview, 1000);
  } catch (e) { showToast(`停止失败: ${e.message}`, 'error'); }
}

async function toggleAisService() {
  const tag = $('aisEngineStateTag')?.textContent || '';
  if (tag === 'RUNNING' || tag === 'LAUNCHING') {
    await stopAisService();
  } else {
    await startAisService();
  }
}

async function restartAisService() {
  try {
    showToast('正在重启 AIS 服务…', 'info');
    await postJson('/ais/api/control/stop', {});
    await postJson('/ais/api/control/start', {});
    showToast('AIS 服务已重启', 'success');
    setTimeout(loadOverview, 1000);
  } catch (e) {
    showToast(`重启失败: ${e.message}`, 'error');
  }
}

function renderAgOffOverviewStats() {
  const box = $('overviewStatsContainer');
  if (!box) return;
  box.innerHTML = `<div class="card">${agOffHtml()}</div>`;
}

async function loadGlobalSettings() {
  try {
    const [p, g] = await Promise.all([getJson('/panel/api/settings/port'), getJson('/panel/api/settings/gateway')]);
    if (document.activeElement !== $('portInput')) $('portInput').value = p.port || '';
    $('gatewayToggle').checked = !!g.enabled;
    $('gatewayStateText').textContent = g.enabled ? '运行中 · 关闭只停外部 API（503）' : '已关闭 · 外部请求返回 503';
  } catch (e) { /* ignore */ }
}

// 把当前页面地址换成同主机的另一个端口（改监听端口后跳转用）
function urlWithPort(href, port) {
  const u = new URL(href);
  u.port = String(port);
  return u.toString();
}

// 轮询新端口的引擎状态接口，可用即返回 true；超时返回 false
async function waitForPort(port, timeoutMs = 10000) {
  const url = urlWithPort(location.origin + '/panel/api/engine/state', port);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(apiUrl(url), { cache: 'no-store', headers: authHeaders() });
      if (res.ok) return true;
    } catch (e) { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

let portSwitching = false;
async function savePort() {
  // Linux / 源码版端口由 PORT 环境变量决定，只读
  if (isDual() || isStandalone()) { showToast('此版本的端口由 PORT 环境变量决定', 'warn'); return; }
  if (portSwitching) return;
  const port = parseInt($('portInput').value, 10);
  if (!port || port < 1024 || port > 65535) { showToast('端口需在 1024~65535 之间', 'warn'); return; }
  const r = await postJson('/panel/api/settings/port', { port });
  if (!r || !r.ok) { showToast((r && r.msg) || '保存失败', 'error'); return; }
  const np = Number(r.new_port || r.port);
  if (r.unchanged || !np || String(np) === (location.port || '')) { showToast(r.msg || '端口未变化', 'info'); return; }
  portSwitching = true;
  showToast(`已切换到端口 ${np}，正在跳转…`, 'success');
  if (await waitForPort(np)) {
    location.replace(urlWithPort(location.href, np));
    return;
  }
  portSwitching = false;
  // 新端口没起来：前门已回退到旧端口，读一下原因
  try {
    const p = await getJson('/panel/api/settings/port');
    $('portInput').value = p.port || '';
    showToast(p.switch_error || `端口 ${np} 未能启动，仍使用 ${p.port}`, 'error');
  } catch (e) {
    showToast(`端口 ${np} 未能启动，请重开应用`, 'error');
  }
}

async function toggleGateway(on) {
  const r = await postJson('/panel/api/settings/gateway', { enabled: on });
  showToast(r.msg || '', r.enabled ? 'success' : 'warn');
  loadGlobalSettings();
}

async function setDefaultEngine(e) {
  await postJson('/panel/api/engine/default', { engine: e });
  engineInfo.default_engine = e;
  showToast(`默认引擎：${META[e].name}`, 'success');
}

async function toggleNodeEngine(on) {
  await postJson('/panel/api/engine/toggle', { enabled: on });
  showToast(on ? 'AG 引擎启动中…' : 'AG 引擎已关闭', on ? 'success' : 'warn');
  setTimeout(renderCurrent, on ? 1500 : 300);
}

async function restartAgEngine() {
  await postJson('/panel/api/engine/restart', {});
  showToast('AG 引擎重启中…', 'info');
  setTimeout(renderCurrent, 3000);
}

async function resetStats() {
  if (!confirm(`清零 ${META[engine].name} 的全部统计和日志？`)) return;
  if (engine === 'ais') {
    await deleteReq('/ais/api/logs').catch(() => {});
  } else {
    if (!agReady()) return;
    await postJson('/api/stats/reset', {});
  }
  showToast('统计已清零', 'success');
  loadOverview();
}

// ── 1.5. 统计 (Token Stats，仅 AG 引擎) ────────────────
let tokenStatsData = null;
let tokenStatsRange = localStorage.getItem('wag2api_token_stats_range') || 'day';
let tokenStatsTrendMode = 'tokens'; // 'tokens' | 'requests' | 'cost'
let tokenStatsRankTab = 'models';   // 'models' | 'accounts'
let tokenStatsTrendIndex = null;

const DEFAULT_PRICE_RULES = [
  { prefix: 'gemini-3.8-flash', in: 0.75, out: 3.75, cached: 0.075 },
  { prefix: 'gemini-3.7', in: 0.75, out: 3.75, cached: 0.075 },
  { prefix: 'gemini-3.6', in: 0.75, out: 3.75, cached: 0.075 },
  { prefix: 'gemini-3.5', in: 0.75, out: 3.75, cached: 0.075 },
  { prefix: 'gemini-3-flash', in: 0.75, out: 3.75, cached: 0.075 },
  { prefix: 'gemini-2.5-flash', in: 0.75, out: 3.75, cached: 0.075 },
  { prefix: 'gemini-2.0-flash', in: 0.10, out: 0.40, cached: 0.025 },
  { prefix: 'gemini-3.1-pro', in: 2.0, out: 12.0, cached: 0.20 },
  { prefix: 'gemini-3-pro', in: 2.0, out: 12.0, cached: 0.20 },
  { prefix: 'gemini-2.5-pro', in: 2.0, out: 12.0, cached: 0.20 },
  { prefix: 'gemini-4-argon', in: 2.0, out: 12.0, cached: 0.20 },
  { prefix: 'claude-sonnet', in: 3.0, out: 15.0, cached: 0.30 },
  { prefix: 'claude-opus', in: 5.0, out: 25.0, cached: 0.50 },
  { prefix: 'claude-haiku', in: 0.8, out: 4.0, cached: 0.08 },
  { prefix: 'gpt-oss', in: 0.15, out: 0.60, cached: 0.075 },
  { prefix: 'default', in: 1.0, out: 5.0, cached: 0.10 },
];

function getPriceRules() {
  try {
    const raw = localStorage.getItem('wag2api_price_rules');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    }
  } catch (e) {}
  return JSON.parse(JSON.stringify(DEFAULT_PRICE_RULES));
}

function normalizeModelName(m) {
  if (!m) return '';
  let name = String(m).toLowerCase().trim();
  name = name.replace(/^(ag|ais):/, '');
  name = name.replace(/-(high|low|medium|tiered|thinking)$/, '');
  return name;
}

function findPriceRule(modelName, rules) {
  const norm = normalizeModelName(modelName);
  let best = null;
  let maxLen = -1;
  let defaultRule = null;
  for (const r of rules) {
    const p = String(r.prefix || '').toLowerCase().trim();
    if (!p) continue;
    if (p === 'default' || p === '*') {
      defaultRule = r;
      continue;
    }
    if (norm.startsWith(p) && p.length > maxLen) {
      best = r;
      maxLen = p.length;
    }
  }
  // 兼顾 claude-3.7-sonnet 等变体
  if (!best && norm.startsWith('claude-')) {
    if (norm.includes('sonnet')) best = rules.find(r => r.prefix === 'claude-sonnet');
    else if (norm.includes('opus')) best = rules.find(r => r.prefix === 'claude-opus');
    else if (norm.includes('haiku')) best = rules.find(r => r.prefix === 'claude-haiku');
  }
  return best || defaultRule || rules.find(r => r.prefix === 'default') || { in: 1.0, out: 5.0, cached: 0.10 };
}

function calcItemCost(item, rule) {
  const input = Number(item.input) || 0;
  const cached = Number(item.cached) || 0;
  const output = Number(item.output) || 0;
  const inPrice = Number(rule.in) || 0;
  const outPrice = Number(rule.out) || 0;
  const cachedPrice = Number(rule.cached) || 0;

  // 费用 = (input*in + cached*cached价 + output*out) / 1000000 (单位: 美元)
  const cost = (input * inPrice + cached * cachedPrice + output * outPrice) / 1e6;
  // 缓存节省 = cached * (in - cached价) / 1000000
  const saved = (cached * Math.max(0, inPrice - cachedPrice)) / 1e6;
  return { cost, saved };
}

function fmtUsd(n) {
  if (n === null || n === undefined || isNaN(n)) return '--';
  n = Number(n);
  if (n === 0) return '$0.00';
  if (n < 0.0001) return '<$0.0001';
  if (n < 0.01) return '$' + n.toFixed(4);
  if (n < 1) return '$' + n.toFixed(3);
  if (n >= 1000) return '$' + fmtNum(Math.round(n));
  return '$' + n.toFixed(2);
}

function openPriceModal() {
  const rules = getPriceRules();
  renderPriceRulesList(rules);
  openModal('priceModal');
}

function renderPriceRulesList(rules) {
  const box = $('priceRulesTable');
  if (!box) return;
  box.innerHTML = rules.map(r => `
    <div class="price-rule-row">
      <div class="price-rule-top">
        <input type="text" class="input-field mono price-prefix" value="${escapeHtml(r.prefix)}" placeholder="模型前缀" ${r.prefix === 'default' ? 'readonly' : ''} />
        ${r.prefix === 'default' ? '<span class="price-default-badge">默认</span>' : `<button type="button" class="btn btn-outline btn-sm" onclick="this.closest('.price-rule-row').remove()" title="删除">🗑</button>`}
      </div>
      <div class="price-rule-prices">
        <label class="price-lbl"><span>入</span><input type="number" step="0.001" class="input-field mono price-in" value="${r.in}" /></label>
        <label class="price-lbl"><span>出</span><input type="number" step="0.001" class="input-field mono price-out" value="${r.out}" /></label>
        <label class="price-lbl"><span>缓</span><input type="number" step="0.001" class="input-field mono price-cached" value="${r.cached}" /></label>
      </div>
    </div>
  `).join('');
}

function addPriceRuleRow() {
  const box = $('priceRulesTable');
  if (!box) return;
  const div = document.createElement('div');
  div.className = 'price-rule-row';
  div.innerHTML = `
    <div class="price-rule-top">
      <input type="text" class="input-field mono price-prefix" value="" placeholder="新模型前缀 (如 gpt-4)" />
      <button type="button" class="btn btn-outline btn-sm" onclick="this.closest('.price-rule-row').remove()" title="删除">🗑</button>
    </div>
    <div class="price-rule-prices">
      <label class="price-lbl"><span>入</span><input type="number" step="0.001" class="input-field mono price-in" value="1.0" /></label>
      <label class="price-lbl"><span>出</span><input type="number" step="0.001" class="input-field mono price-out" value="5.0" /></label>
      <label class="price-lbl"><span>缓</span><input type="number" step="0.001" class="input-field mono price-cached" value="0.10" /></label>
    </div>
  `;
  box.appendChild(div);
  div.querySelector('.price-prefix').focus();
}

function resetDefaultPriceRules() {
  if (!confirm('确定恢复默认价格表？')) return;
  localStorage.removeItem('wag2api_price_rules');
  renderPriceRulesList(DEFAULT_PRICE_RULES);
  showToast('已恢复默认价格', 'info');
}

function savePriceRules() {
  const rows = document.querySelectorAll('.price-rule-row');
  const rules = [];
  rows.forEach(row => {
    const prefix = row.querySelector('.price-prefix').value.trim();
    const inPrice = parseFloat(row.querySelector('.price-in').value) || 0;
    const outPrice = parseFloat(row.querySelector('.price-out').value) || 0;
    const cachedPrice = parseFloat(row.querySelector('.price-cached').value) || 0;
    if (prefix) {
      rules.push({ prefix, in: inPrice, out: outPrice, cached: cachedPrice });
    }
  });
  if (!rules.some(r => r.prefix.toLowerCase() === 'default')) {
    rules.push({ prefix: 'default', in: 1.0, out: 5.0, cached: 0.10 });
  }
  localStorage.setItem('wag2api_price_rules', JSON.stringify(rules));
  closeModal('priceModal');
  showToast('价格表已更新', 'success');
  if (tokenStatsData) renderTokenStatsView(tokenStatsData);
}

async function loadAgTokenStats(toast = false) {
  const box = $('overviewStatsContainer');
  if (!box) return;

  if (engine === 'ais') {
    return;
  }
  if (!agReady()) {
    renderAgOffOverviewStats();
    return;
  }

  try {
    const data = await getJson(`/api/token-stats?range=${encodeURIComponent(tokenStatsRange)}`);
    tokenStatsData = data;
    renderTokenStatsView(data);
    if (toast) showToast('统计已刷新', 'success');
  } catch (e) {
    box.innerHTML = `<div class="card empty" style="color:var(--danger)">加载统计失败：${escapeHtml(e.message)}</div>`;
  }
}

function loadEngineTokenStats(toast = false) {
  return engine === 'ais' ? loadAisTokenStats(toast) : loadAgTokenStats(toast);
}

function buildAisHeatmapList(buckets) {
  return (buckets || []).map(b => {
    const d = new Date(b.at);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dayStr = String(d.getDate()).padStart(2, '0');
    return {
      day: `${y}-${m}-${dayStr}`,
      tokens: Number(b.total_tokens) || 0,
      requests: Number(b.requests) || 0,
    };
  });
}

function adaptAisUsageToTokenStats(report, heatmapList, range) {
  const totals = report?.totals || {};
  const totalTokens = Number(totals.total_tokens) || 0;
  const input = Number(totals.input_tokens) || 0;
  const cached = Number(totals.cached_tokens) || 0;
  const output = (Number(totals.reply_tokens) || 0) + (Number(totals.reasoning_tokens) || 0);
  const thoughts = Number(totals.reasoning_tokens) || 0;
  const requests = Number(totals.requests) || 0;
  const success = Number(totals.succeeded) || 0;
  const errors = (Number(totals.failed) || 0) + (Number(totals.rate_limited) || 0);

  const summary = {
    requests,
    success,
    errors,
    input,
    cached,
    output,
    thoughts,
    tokens: totalTokens,
    cache_hit_rate: (input + cached) > 0 ? (cached / (input + cached)) : null,
    avg_latency_ms: Math.round(totals.duration?.avg_ms || 0),
    avg_ttft_ms: totals.first_event?.avg_ms ? Math.round(totals.first_event.avg_ms) : null,
    active_accounts: 0,
    active_models: 0,
  };

  const buckets = Array.isArray(report?.buckets) ? report.buckets : [];
  const series = buckets.map(b => {
    const bIn = Number(b.input_tokens) || 0;
    const bCac = Number(b.cached_tokens) || 0;
    const bOut = (Number(b.reply_tokens) || 0) + (Number(b.reasoning_tokens) || 0);
    const bThk = Number(b.reasoning_tokens) || 0;
    const bTok = Number(b.total_tokens) || (bIn + bCac + bOut);
    const bReq = Number(b.requests) || 0;
    const bErr = (Number(b.failed) || 0) + (Number(b.rate_limited) || 0);
    return {
      ts: Date.parse(b.at),
      requests: bReq,
      errors: bErr,
      input: bIn,
      cached: bCac,
      output: bOut,
      thoughts: bThk,
      tokens: bTok,
    };
  });

  const rawModels = report?.groups?.model || [];
  const models = rawModels.map(g => {
    const mIn = Number(g.input_tokens) || 0;
    const mCac = Number(g.cached_tokens) || 0;
    const mOut = (Number(g.reply_tokens) || 0) + (Number(g.reasoning_tokens) || 0);
    const mThk = Number(g.reasoning_tokens) || 0;
    const mTok = Number(g.total_tokens) || (mIn + mCac + mOut);
    const mReq = Number(g.requests) || 0;
    const mErr = (Number(g.failed) || 0) + (Number(g.rate_limited) || 0);
    return {
      model: g.key,
      requests: mReq,
      errors: mErr,
      input: mIn,
      cached: mCac,
      output: mOut,
      thoughts: mThk,
      tokens: mTok,
      share: totalTokens > 0 ? (mTok / totalTokens) : 0,
    };
  }).filter(m => m.requests > 0 || m.tokens > 0);
  models.sort((a, b) => b.tokens - a.tokens || b.requests - a.requests);

  const pairs = Array.isArray(report?.pairs) ? report.pairs : [];
  const rawAccounts = report?.groups?.account || [];
  const accounts = rawAccounts.map(g => {
    const aIn = Number(g.input_tokens) || 0;
    const aCac = Number(g.cached_tokens) || 0;
    const aOut = (Number(g.reply_tokens) || 0) + (Number(g.reasoning_tokens) || 0);
    const aThk = Number(g.reasoning_tokens) || 0;
    const aTok = Number(g.total_tokens) || (aIn + aCac + aOut);
    const aReq = Number(g.requests) || 0;
    const aErr = (Number(g.failed) || 0) + (Number(g.rate_limited) || 0);

    const accMatch = aisAccountsCache.find(a => a.id === g.key);
    const email = accMatch?.label || g.key;

    const accPairs = pairs.filter(p => p.account === g.key);
    let topModel = null;
    let maxTok = -1;
    for (const p of accPairs) {
      const tok = Number(p.total_tokens) || 0;
      if (tok > maxTok) {
        maxTok = tok;
        topModel = p.model;
      }
    }

    return {
      email,
      requests: aReq,
      errors: aErr,
      input: aIn,
      cached: aCac,
      output: aOut,
      thoughts: aThk,
      tokens: aTok,
      share: totalTokens > 0 ? (aTok / totalTokens) : 0,
      cache_hit_rate: (aIn + aCac) > 0 ? (aCac / (aIn + aCac)) : null,
      top_model: topModel,
    };
  }).filter(a => a.requests > 0 || a.tokens > 0);
  accounts.sort((a, b) => b.tokens - a.tokens || b.requests - a.requests);

  summary.active_accounts = accounts.length;
  summary.active_models = models.length;

  let peak = null;
  for (const p of series) {
    if (p.tokens > 0 || p.requests > 0) {
      if (!peak || p.tokens > peak.tokens || (p.tokens === peak.tokens && p.requests > peak.requests)) {
        peak = { ts: p.ts, tokens: p.tokens, requests: p.requests };
      }
    }
  }

  return {
    range,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    generated_at: Date.now(),
    summary,
    series,
    models,
    accounts,
    peak,
    heatmap: heatmapList || [],
  };
}

async function loadAisTokenStats(toast = false) {
  const box = $('overviewStatsContainer');
  if (!box) return;

  const now = Date.now();
  let spanMs = 24 * 3600e3;
  let bucket = '3600';
  if (tokenStatsRange === 'hour') {
    spanMs = 3600e3;
    bucket = '60';
  } else if (tokenStatsRange === 'day') {
    spanMs = 24 * 3600e3;
    bucket = '3600';
  } else if (tokenStatsRange === 'week') {
    spanMs = 7 * 86400e3;
    bucket = '3600';
  } else if (tokenStatsRange === 'month') {
    spanMs = 30 * 86400e3;
    bucket = '86400';
  } else if (tokenStatsRange === 'all') {
    spanMs = 91 * 86400e3;
    bucket = '86400';
  }

  const fromISO = new Date(now - spanMs).toISOString();
  const toISO = new Date(now).toISOString();
  const rawTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const tz = /^(GMT|UTC[+-])/i.test(rawTz) ? 'UTC' : rawTz;

  try {
    const report = await getJson(`/ais/api/usage?from=${encodeURIComponent(fromISO)}&to=${encodeURIComponent(toISO)}&bucket=${bucket}&tz=${encodeURIComponent(tz)}`);
    if (engine !== 'ais') return;

    if (tokenStatsRange === 'month' || tokenStatsRange === 'all') {
      if (Array.isArray(report?.buckets)) {
        aisHeatmapCache = {
          ts: Date.now(),
          list: buildAisHeatmapList(report.buckets),
        };
      }
    } else if (Date.now() - aisHeatmapCache.ts > 60000) {
      const hmFrom = new Date(now - 91 * 86400e3).toISOString();
      getJson(`/ais/api/usage?from=${encodeURIComponent(hmFrom)}&to=${encodeURIComponent(toISO)}&bucket=86400&tz=${encodeURIComponent(tz)}`).then(hmReport => {
        if (Array.isArray(hmReport?.buckets)) {
          aisHeatmapCache = {
            ts: Date.now(),
            list: buildAisHeatmapList(hmReport.buckets),
          };
          if (engine === 'ais' && tokenStatsData && tokenStatsData.range === tokenStatsRange) {
            tokenStatsData.heatmap = aisHeatmapCache.list;
            renderStatsHeatmapCard(tokenStatsData);
          }
        }
      }).catch(() => {});
    }

    const data = adaptAisUsageToTokenStats(report, aisHeatmapCache.list, tokenStatsRange);
    tokenStatsData = data;
    renderTokenStatsView(data);

    if (tokenStatsRange === 'day') {
      if ($('ovReq')) $('ovReq').textContent = fmtNum(data.summary.requests || 0);
      if ($('ovTokens')) $('ovTokens').textContent = fmtNum(data.summary.tokens || 0);
    } else {
      if ($('ovReq')) $('ovReq').textContent = fmtNum(data.summary.requests || 0);
      if ($('ovTokens')) $('ovTokens').textContent = fmtNum(data.summary.tokens || 0);
      const dayFrom = new Date(now - 24 * 3600e3).toISOString();
      getJson(`/ais/api/usage?from=${encodeURIComponent(dayFrom)}&to=${encodeURIComponent(toISO)}&bucket=3600&tz=${encodeURIComponent(tz)}`).then(dayRep => {
        if (engine !== 'ais') return;
        const dt = dayRep?.totals || {};
        if ($('ovReq')) $('ovReq').textContent = fmtNum(dt.requests || 0);
        if ($('ovTokens')) $('ovTokens').textContent = fmtNum(dt.total_tokens || 0);
      }).catch(() => {});
    }
    if (toast) showToast('统计已刷新', 'success');
  } catch (e) {
    if (engine !== 'ais') return;
    box.innerHTML = `<div class="card empty" style="color:var(--danger)">加载 AIS 统计失败：${escapeHtml(e.message)}</div>`;
  }
}

function setTokenStatsRange(r) {
  tokenStatsRange = r;
  localStorage.setItem('wag2api_token_stats_range', r);
  tokenStatsTrendIndex = null;
  loadEngineTokenStats(false);
}

function setTokenStatsTrendMode(m) {
  tokenStatsTrendMode = m;
  tokenStatsTrendIndex = null;
  if (tokenStatsData) renderStatsTrendCard(tokenStatsData);
}

function setTokenStatsRankTab(t) {
  tokenStatsRankTab = t;
  if (tokenStatsData) renderStatsRankCard(tokenStatsData);
}

function renderTokenStatsView(data) {
  const box = $('overviewStatsContainer');
  if (!box || !data) return;

  const rules = getPriceRules();
  const summary = data.summary || {};
  const models = data.models || [];
  const accounts = data.accounts || [];

  // 计算每个模型的费用与节省
  let totalCost = 0;
  let totalSaved = 0;
  models.forEach(m => {
    const rule = findPriceRule(m.model, rules);
    const { cost, saved } = calcItemCost(m, rule);
    m.cost = cost;
    m.saved = saved;
    totalCost += cost;
    totalSaved += saved;
  });

  // 计算每个账号的费用
  accounts.forEach(a => {
    const rule = findPriceRule(a.top_model, rules);
    const { cost, saved } = calcItemCost(a, rule);
    a.cost = cost;
    a.saved = saved;
  });

  // 无模型明细时按 summary 回退计算
  if (!models.length && (summary.input || summary.cached || summary.output)) {
    const defRule = findPriceRule('default', rules);
    const calc = calcItemCost(summary, defRule);
    totalCost = calc.cost;
    totalSaved = calc.saved;
  }

  const totalTokens = Number(summary.tokens) || models.reduce((a, m) => a + (Number(m.tokens) || 0), 0);
  data._avgPricePerToken = totalTokens > 0 ? (totalCost / totalTokens) : 0;
  data._totalCost = totalCost;
  data._totalSaved = totalSaved;

  const reqCount = Number(summary.requests) || 0;
  const succCount = Number(summary.success) || 0;
  const saveRate = totalCost + totalSaved > 0 ? (totalSaved / (totalCost + totalSaved)) : 0;

  box.innerHTML = `
    <!-- 1. 统计概要卡 -->
    <div class="card stats-summary-card" id="statsSummaryCard">
      <div class="stats-top-bar" style="margin-bottom: 10px;">
        <div class="sub-tabs scrollable">
          ${[
            ['hour', '1小时'],
            ['day', '24小时'],
            ['week', '7天'],
            ['month', '30天'],
            ['all', '全部'],
          ].map(([k, name]) => `
            <span class="sub-tab ${tokenStatsRange === k ? 'active' : ''}" onclick="setTokenStatsRange('${k}')">${name}</span>
          `).join('')}
        </div>
        <button class="btn btn-outline btn-sm" onclick="loadEngineTokenStats(true)">🔄 刷新</button>
      </div>

      <div class="metric-label">总 Token 消耗</div>
      <div class="stats-big-tokens mono">${fmtNum(summary.tokens)}</div>
      <div class="stats-sub-row muted">
        输入 <b>${fmtNum(summary.input)}</b> · 缓存 <b>${fmtNum(summary.cached)}</b> · 输出 <b>${fmtNum(summary.output)}</b> · 思考 <b>${fmtNum(summary.thoughts)}</b>
      </div>
      <div class="stat-grid" style="margin-top:10px;">
        <div class="stat-cell"><div class="k">请求数</div><div class="v">${fmtNum(summary.requests)}</div></div>
        <div class="stat-cell"><div class="k">成功率</div><div class="v">${reqCount > 0 ? fmtPct(succCount / reqCount) : '--'}</div></div>
        <div class="stat-cell"><div class="k">缓存命中率</div><div class="v hl">${fmtPct(summary.cache_hit_rate)}</div></div>
        <div class="stat-cell" style="grid-column: 1 / -1;"><div class="k">平均耗时 / 首字</div><div class="v" style="font-size:13px;">${fmtMs(summary.avg_latency_ms)} / ${fmtMs(summary.avg_ttft_ms)}</div></div>
      </div>
    </div>

    <!-- 2. 趋势卡 -->
    <div class="card stats-trend-card" id="statsTrendCard"></div>

    <!-- 3. 费用卡 -->
    <div class="card stats-cost-card" id="statsCostCard">
      <div class="section-title">
        <span>预估费用（按模型估算）</span>
        <button class="btn btn-outline btn-sm" onclick="openPriceModal()">价格</button>
      </div>
      <div class="cost-metric-grid">
        <div class="cost-main-box">
          <div class="metric-label">预估花费</div>
          <div class="cost-big-num mono">${fmtUsd(totalCost)}</div>
          <div class="muted" style="font-size:11px;margin-top:4px;">平均单次 ${reqCount > 0 ? fmtUsd(totalCost / reqCount) : '--'}</div>
        </div>
        <div class="cost-save-box">
          <div class="metric-label">缓存节省</div>
          <div class="cost-save-num mono">${fmtUsd(totalSaved)}</div>
          <div class="muted" style="font-size:11px;margin-top:4px;">节省占比 <b>${fmtPct(saveRate)}</b></div>
        </div>
      </div>
    </div>

    <!-- 4. 排行卡 -->
    <div class="card stats-rank-card" id="statsRankCard"></div>

    <!-- 5. 活跃热力图 -->
    <div class="card stats-heatmap-card" id="statsHeatmapCard"></div>
  `;

  renderStatsTrendCard(data);
  renderStatsRankCard(data);
  renderStatsHeatmapCard(data);
}

function renderStatsTrendCard(data) {
  const card = $('statsTrendCard');
  if (!card) return;
  const pts = data.series || [];
  const mode = tokenStatsTrendMode;
  const peak = data.peak;

  let html = `
    <div class="section-title">
      <span>时段趋势</span>
      <div class="sub-tabs">
        <span class="sub-tab ${mode === 'tokens' ? 'active' : ''}" onclick="setTokenStatsTrendMode('tokens')">Token</span>
        <span class="sub-tab ${mode === 'requests' ? 'active' : ''}" onclick="setTokenStatsTrendMode('requests')">请求</span>
        <span class="sub-tab ${mode === 'cost' ? 'active' : ''}" onclick="setTokenStatsTrendMode('cost')">费用</span>
      </div>
    </div>
  `;

  if (!pts.length) {
    html += '<div class="empty">暂无时段数据</div>';
    card.innerHTML = html;
    return;
  }

  // 费用按当期 models 份额估算或按 tokens*平均单价近似：单价 = 当期总费用 / 当期总 Token
  const getVal = p => {
    if (mode === 'tokens') return Number(p.tokens) || 0;
    if (mode === 'requests') return Number(p.requests) || 0;
    return (Number(p.tokens) || 0) * (data._avgPricePerToken || 0);
  };

  const values = pts.map(getVal);
  const maxVal = Math.max(1, ...values);

  // 峰值时段识别
  let peakIdx = -1;
  if (peak && peak.ts) {
    let minDiff = Infinity;
    pts.forEach((p, i) => {
      const diff = Math.abs(p.ts - peak.ts);
      if (diff < minDiff) { minDiff = diff; peakIdx = i; }
    });
  }

  // 选中的柱子提示条
  const selIdx = (tokenStatsTrendIndex !== null && tokenStatsTrendIndex < pts.length) ? tokenStatsTrendIndex : null;
  const currP = selIdx !== null ? pts[selIdx] : null;

  let tipText = '';
  if (currP) {
    const t = new Date(currP.ts);
    const tmStr = t.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) + ' ' + t.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    const cVal = getVal(currP);
    if (mode === 'tokens') {
      tipText = `<b>${tmStr}</b> · <b>${fmtNum(currP.tokens)}</b> Token (入 ${fmtNum(currP.input)} · 缓 ${fmtNum(currP.cached)} · 出 ${fmtNum(currP.output)})`;
    } else if (mode === 'requests') {
      tipText = `<b>${tmStr}</b> · <b>${fmtNum(currP.requests)}</b> 次请求${currP.errors ? ` (失败 ${currP.errors})` : ''}`;
    } else {
      tipText = `<b>${tmStr}</b> · 预估费用 <b>${fmtUsd(cVal)}</b> (${fmtNum(currP.tokens)} Token)`;
    }
  } else {
    if (peak && peak.ts) {
      const pt = new Date(peak.ts);
      const ptStr = pt.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) + ' ' + pt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
      tipText = `⚡ 峰值时段：<b>${ptStr}</b> · ${fmtNum(peak.tokens)} Token (${fmtNum(peak.requests)} 次) · 点击柱子查看`;
    } else {
      tipText = '点击柱子查看该时段数值';
    }
  }

  html += `<div class="stats-trend-tip" id="statsTrendTip">${tipText}</div>`;

  // 柱状图
  html += '<div class="stats-trend-bars">';
  pts.forEach((p, i) => {
    const v = values[i];
    const h = v > 0 ? Math.max(4, Math.round(v / maxVal * 100)) : 2;
    const isZero = !v;
    const isErr = mode === 'requests' && p.errors && p.errors >= v;
    const isPeak = (i === peakIdx);
    const isSel = (i === selIdx);
    const cls = ['stats-bar', isZero ? 'zero' : '', isErr ? 'err' : '', isPeak ? 'peak' : '', isSel ? 'selected' : ''].filter(Boolean).join(' ');
    html += `<div class="${cls}" style="height:${h}%" onclick="selectStatsTrendPoint(${i})" title="${new Date(p.ts).toLocaleTimeString()}: ${v}">${isPeak ? '<span class="peak-dot"></span>' : ''}</div>`;
  });
  html += '</div>';

  // 3 个 x 轴刻度标签 (本地时区)
  const formatAxisTime = ts => {
    const d = new Date(ts);
    if (tokenStatsRange === 'hour' || tokenStatsRange === 'day') {
      return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };

  const mid = Math.floor(pts.length / 2);
  html += `
    <div class="trend-axis">
      <span>${formatAxisTime(pts[0].ts)}</span>
      <span>${formatAxisTime(pts[mid].ts)}</span>
      <span>${formatAxisTime(pts[pts.length - 1].ts)}</span>
    </div>
  `;

  card.innerHTML = html;
}

function selectStatsTrendPoint(i) {
  tokenStatsTrendIndex = (tokenStatsTrendIndex === i ? null : i);
  if (tokenStatsData) renderStatsTrendCard(tokenStatsData);
}

function renderStatsRankCard(data) {
  const card = $('statsRankCard');
  if (!card) return;
  const isModels = tokenStatsRankTab === 'models';
  const rawList = isModels ? (data.models || []) : (data.accounts || []);
  const list = [...rawList].sort((a, b) => (Number(b.tokens) || 0) - (Number(a.tokens) || 0));

  let html = `
    <div class="section-title">
      <span>${isModels ? '模型排行' : '账号排行'} (${list.length})</span>
      <div class="sub-tabs">
        <span class="sub-tab ${isModels ? 'active' : ''}" onclick="setTokenStatsRankTab('models')">模型</span>
        <span class="sub-tab ${!isModels ? 'active' : ''}" onclick="setTokenStatsRankTab('accounts')">账号</span>
      </div>
    </div>
  `;

  if (!list.length) {
    html += `<div class="empty">暂无${isModels ? '模型' : '账号'}数据</div>`;
    card.innerHTML = html;
    return;
  }

  html += '<div class="rank-list">';
  list.forEach((item, idx) => {
    const rawName = isModels ? (item.model || '--') : (item.email || '--');
    const displayName = isModels ? rawName : shortenEmail(rawName, 22);
    const share = typeof item.share === 'number' ? item.share : 0;
    const isTop = (idx === 0 && (Number(item.tokens) || 0) > 0);

    html += `
      <div class="rank-item">
        <div class="rank-item-header">
          <div class="rank-left">
            <span class="rank-idx ${isTop ? 'top' : ''}">${idx + 1}</span>
            <span class="rank-name mono" title="${escapeHtml(rawName)}">${escapeHtml(displayName)}</span>
            ${isTop ? '<span class="rank-tag top">主力</span>' : ''}
          </div>
          <div class="rank-right">
            <span class="rank-tokens mono hl">${fmtNum(item.tokens)}</span>
            <span class="rank-cost mono">${fmtUsd(item.cost)}</span>
          </div>
        </div>
        <div class="rank-progress-wrap">
          <div class="rank-progress-bar"><i style="width: ${Math.max(1, Math.min(100, Math.round(share * 100)))}%"></i></div>
          <span class="rank-share mono">${fmtPct(share)}</span>
        </div>
        <div class="rank-item-footer muted">
          <span>${fmtNum(item.requests)} 次请求${item.errors ? ` (失败 ${item.errors})` : ''}</span>
          ${!isModels ? `<span>命中率 <b>${fmtPct(item.cache_hit_rate)}</b> · 主力 <b>${escapeHtml(item.top_model || '--')}</b></span>` : `<span>入 ${fmtNum(item.input)} · 缓 ${fmtNum(item.cached)} · 出 ${fmtNum(item.output)}</span>`}
        </div>
      </div>
    `;
  });
  html += '</div>';

  // 份额 > 80% 警告
  const topShare = list[0] && typeof list[0].share === 'number' ? list[0].share : 0;
  if (topShare > 0.8) {
    html += `
      <div class="stats-warning-note">
        ⚠️ 流量高度集中在一个${isModels ? '模型' : '账号'}（占比 ${fmtPct(topShare)}）
      </div>
    `;
  }

  card.innerHTML = html;
}

function shortenEmail(email, maxLen = 22) {
  if (!email || email.length <= maxLen) return email;
  const parts = email.split('@');
  if (parts.length === 2) {
    const user = parts[0];
    const domain = parts[1];
    if (user.length > 6) {
      const cut = Math.max(3, maxLen - domain.length - 4);
      return `${user.slice(0, cut)}…@${domain}`;
    }
  }
  return email.slice(0, 10) + '…' + email.slice(-8);
}

function renderStatsHeatmapCard(data) {
  const card = $('statsHeatmapCard');
  if (!card) return;
  const rawList = data.heatmap || [];
  const mapByDay = {};
  rawList.forEach(h => { if (h && h.day) mapByDay[h.day] = h; });

  // 91 天，7 行 × 13 列
  const now = new Date();
  const days = [];
  for (let i = 90; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dayStr = String(d.getDate()).padStart(2, '0');
    const key = `${y}-${m}-${dayStr}`;
    const entry = mapByDay[key] || { day: key, tokens: 0, requests: 0 };
    days.push(entry);
  }

  const maxDayTokens = Math.max(1, ...days.map(d => Number(d.tokens) || 0));
  let mostActive = null;
  let activeCount = 0;
  days.forEach(d => {
    const tok = Number(d.tokens) || 0;
    if (tok > 0) {
      activeCount++;
      if (!mostActive || tok > (Number(mostActive.tokens) || 0)) {
        mostActive = d;
      }
    }
  });

  const getLevel = tok => {
    if (!tok || tok <= 0) return 0;
    const r = tok / maxDayTokens;
    if (r <= 0.25) return 1;
    if (r <= 0.50) return 2;
    if (r <= 0.75) return 3;
    return 4;
  };

  let html = `
    <div class="section-title">
      <span>活跃热力图（近 91 天）</span>
      <div class="heatmap-legend">
        <span>少</span>
        <i class="heatmap-cell lvl-0"></i>
        <i class="heatmap-cell lvl-1"></i>
        <i class="heatmap-cell lvl-2"></i>
        <i class="heatmap-cell lvl-3"></i>
        <i class="heatmap-cell lvl-4"></i>
        <span>多</span>
      </div>
    </div>
    <div class="heatmap-tip" id="heatmapTip">点击方格查看当日数据</div>
    <div class="heatmap-grid">
  `;

  days.forEach(d => {
    const tok = Number(d.tokens) || 0;
    const req = Number(d.requests) || 0;
    const lvl = getLevel(tok);
    html += `<div class="heatmap-cell lvl-${lvl}" onclick="selectHeatmapCell('${d.day}', ${tok}, ${req})" title="${d.day} · ${fmtNum(tok)} Token (${req} 请求)"></div>`;
  });

  html += `
    </div>
    <div class="heatmap-footer">
      <span>最活跃的一天：<b>${mostActive ? `${mostActive.day} · ${fmtNum(mostActive.tokens)} Token` : '--'}</b></span>
      <span>活跃天数：<b>${activeCount}/91</b></span>
    </div>
  `;

  card.innerHTML = html;
}

function selectHeatmapCell(day, tokens, reqs) {
  const tip = $('heatmapTip');
  if (tip) {
    tip.innerHTML = `<b>${day}</b> · <b>${fmtNum(tokens)}</b> Token · <b>${fmtNum(reqs)}</b> 次请求`;
  }
}

// ── 2. 账号 ─────────────────────────────────────────────
async function loadAccounts() {
  const want = engine;
  // 切换引擎时先显示加载中，避免短暂出现「0 个账号」或上一个引擎的列表
  if ($('accountList').dataset.engine !== want) {
    $('accountList').dataset.engine = want;
    $('accountList').innerHTML = '<div class="empty">加载中…</div>';
    $('accountCount').textContent = '…';
    $('schedulerCard').style.display = 'none';
  }
  await refreshEngineInfo();
  if (engine !== want) return;
  applyEngineChrome();
  if (engine === 'ais') return loadAisAccounts();
  if (!agReady()) {
    $('schedulerCard').style.display = 'none';
    $('accountCount').textContent = '0';
    $('accountList').innerHTML = `<div class="card">${agOffHtml()}</div>`;
    return;
  }
  return loadAgAccounts();
}

function computeAisAccountPerf(acc) {
  const accId = acc.id;
  const accLabel = acc.label;
  const records = (aisRecentRecordsCache || []).filter(r => { const ra = r.account || r.account_id; return ra === accId || ra === accLabel; });
  if (!records.length) {
    return { success_rate: null, avg_latency_ms: null, fail_streak: 0 };
  }

  let failStreak = 0;
  let streakBroken = false;
  let succCount = 0;
  let latSum = 0;
  let latCount = 0;

  for (const r of records) {
    const isSucc = r.state === 'completed' || r.state === 'tool_calls' || (r.status >= 200 && r.status < 300);
    const isFail = r.state === 'failed' || r.state === 'rate_limited' || (r.status >= 400);

    if (!streakBroken) {
      if (isFail) {
        failStreak++;
      } else if (isSucc) {
        streakBroken = true;
      }
    }

    if (isSucc) succCount++;
    const dur = Number(r.duration_ms || r.latency_ms) || 0;
    if (dur > 0) {
      latSum += dur;
      latCount++;
    }
  }

  const success_rate = records.length > 0 ? succCount / records.length : null;
  const avg_latency_ms = latCount > 0 ? Math.round(latSum / latCount) : null;
  return { success_rate, avg_latency_ms, fail_streak: failStreak };
}

function aisAccountStatusHtml(a) {
  const id = a.id || '';
  const escId = escapeHtml(id);
  const modelsCount = Number.isFinite(Number(a.model_count)) && a.model_count !== null ? Number(a.model_count) : ((Array.isArray(a.models) && a.models.length) || 0);
  const changeSummary = aisRefreshResults[id] ? ` <span class="muted" style="font-size:11px;">(${escapeHtml(aisRefreshResults[id])})</span>` : '';

  const accCds = (aisCooldownsCache || []).filter(cd => cd.account_id === id);
  let cdHtml = '';
  if (!accCds.length) {
    cdHtml = `<div class="kv"><span class="k">调度状态</span><span class="v">${a.state === 'disabled' ? '<span class="muted">已手动停用</span>' : '<span style="color:var(--primary)">正常就绪</span>'}</span></div>`;
  } else {
    cdHtml = accCds.map(cd => {
      const untilStr = cd.until ? new Date(cd.until).toLocaleTimeString('zh-CN', { hour12: false }) : '冷却中';
      const scope = cd.scope || '*';
      return `<div class="kv" style="color:var(--warning);"><span class="k">冷却状态</span><span class="v" style="display:flex;align-items:center;gap:4px;">❄️ ${escapeHtml(cd.model_id || '全部模型')} (${escapeHtml(cd.channel || '全通道')}) · 恢复于 ${untilStr} <button class="btn btn-outline btn-sm" style="padding:1px 6px; font-size:10px;" data-id="${escId}" data-scope="${escapeHtml(scope)}" onclick="aisClearCooldown(this.dataset.id, this.dataset.scope)">解除</button></span></div>`;
    }).join('');
  }

  // [beta] 更新时间以服务端持久化的 refreshed_at 为准（重启 App 后仍在），本地记录只作兜底
  const srvTs = Number(a.refreshed_at_ms) || (a.refreshed_at ? Date.parse(a.refreshed_at) : 0) || 0;
  const refTs = Math.max(srvTs, aisRefreshTimes[id] || 0);
  const timeTs = refTs || aisAccountsLoadedAt;
  const timeLabel = refTs ? '更新于 ' : '同步于 ';
  const timeStr = timeTs ? `${timeLabel}${new Date(timeTs).toLocaleTimeString('zh-CN', { hour12: false })}` : '';

  return `
    <div class="quota-list" style="margin-top:8px;">
      <div class="kv" style="cursor:pointer;" onclick="showAisAccountModels('${escId}')">
        <span class="k">可用模型</span>
        <span class="v"><b>${modelsCount}</b> 个模型${changeSummary}</span>
      </div>
      ${cdHtml}
      ${timeStr ? `<div class="muted" style="text-align:right;font-size:11px;margin-top:4px;">${timeStr}</div>` : ''}
    </div>
  `;
}

async function loadAisAccounts() {
  const box = $('accountList');
  const sch = $('schedulerCard');
  try {
    const fromTime = new Date(Date.now() - 86400000).toISOString();
    const toTime = new Date().toISOString();
    const [accRes, cfgRes, cdRes, reqRes, recRes] = await Promise.all([
      getJson('/ais/api/accounts'),
      getJson('/ais/api/config').catch(() => null),
      getJson('/ais/api/cooldowns').catch(() => ({ cooldowns: [] })),
      getJson('/ais/api/requests').catch(() => ({ requests: [] })),
      getJson(`/ais/api/usage/records?from=${encodeURIComponent(fromTime)}&to=${encodeURIComponent(toTime)}&limit=100`).catch(() => ({ items: [] })),
    ]);
    if (engine !== 'ais') return;

    aisAccountsLoadedAt = Date.now();
    aisRecentRecordsCache = recRes.items || [];
    aisAccountsCache = accRes.accounts || [];
    aisConfigCache = cfgRes;
    aisCooldownsCache = cdRes.cooldowns || [];
    aisRequestsCache = reqRes.requests || [];

    $('accountCount').textContent = aisAccountsCache.length;

    if (sch) {
      sch.style.display = 'block';
      renderAisSchedulerCard();
    }

    if (!aisAccountsCache.length) {
      box.innerHTML = '<div class="empty">暂无 AIS 账号，点击右上角「+ 添加」或「导入」</div>';
      return;
    }

    box.innerHTML = aisAccountsCache.map(a => {
      const id = a.id || '';
      const escId = escapeHtml(id);
      const label = a.label || id;
      const escLabel = escapeHtml(label);
      const isRefreshing = aisRefreshingIds.has(id);
      const isTesting = aisTestingAccounts.has(id);
      const errMsg = aisRefreshErrors[id] || a.message;
      const isAuthReq = a.state === 'auth_required';
      const showValidation = isAuthReq || Boolean(errMsg);
      const activeReqs = (aisRequestsCache || []).filter(r => r.account_id === id).length;

      let stateBadge = '';
      if (a.state === 'ready') {
        stateBadge = '<span class="tag tag-online">● 正常</span>';
      } else if (a.state === 'busy') {
        stateBadge = `<span class="tag tag-warn">● 忙碌${activeReqs > 0 ? ` (${activeReqs} 并发)` : ''}</span>`;
      } else if (a.state === 'cooldown') {
        stateBadge = '<span class="tag tag-warn">● 冷却中</span>';
      } else if (a.state === 'auth_required') {
        stateBadge = '<span class="tag tag-offline">● 需认证</span>';
      } else if (a.state === 'unavailable') {
        stateBadge = '<span class="tag tag-offline">● 不可用</span>';
      } else if (a.state === 'disabled') {
        stateBadge = '<span class="tag tag-offline">● 已停用</span>';
      } else {
        stateBadge = `<span class="tag ${a.enabled ? 'tag-online' : 'tag-offline'}">● ${escapeHtml(a.state || '未知')}</span>`;
      }

      const egressText = a.egress ? maskProxyUrl(a.egress) : (a.proxy ? maskProxyUrl(a.proxy) : '直连');

      return `
        <div class="account-card">
          <div class="account-card-header">
            <div class="item-avatar">${escapeHtml((label || 'A').charAt(0).toUpperCase())}</div>
            <div class="account-card-info" style="min-width:0; flex:1;">
              <div class="account-title-row" style="flex-wrap:wrap; gap:4px;">
                <span class="account-name" style="word-break:break-all;">${escLabel}</span>
                <span class="tag tag-global">AI Studio</span>
                ${tierTagHtml(a.benefit_tier)}
                ${stateBadge}
              </div>
              <div class="account-meta mono" style="margin-top:3px; font-size:11px; color:var(--text-muted);">
                出口 ${escapeHtml(egressText)} · ${escapeHtml(a.locale || '-')} · ${escapeHtml(a.timezone || '-')}
              </div>
            </div>
          </div>
          ${showValidation ? `
            <div class="account-validation-box">
              <div class="validation-reason">⚠️ ${escapeHtml(errMsg || '登录凭据已失效，请更新此账号的 Cookie')}</div>
              <div class="validation-actions">
                ${errMsg && errMsg.length > 80 ? `<button class="btn btn-outline btn-sm" data-label="${escLabel}" data-err="${escapeHtml(errMsg)}" onclick="showAccountErrorDetail(this.dataset.label, this.dataset.err)">详情</button>` : ''}
                ${isAuthReq ? `<button class="btn btn-primary btn-sm" onclick="openAisReloginCookie('${escId}')">🔑 更新 Cookie</button>` : ''}
              </div>
            </div>
          ` : ''}
          ${aisAccountStatusHtml(a)}
          ${formatAccountPerfRow(computeAisAccountPerf(a))}
          ${renderAccountTestBanner(aisTestResults[id])}
          <div class="account-actions-wrap" style="margin-top:10px;">
            <div class="account-actions-row">
              <button class="btn btn-outline btn-sm" style="flex:1;" onclick="aisTestAccount('${escId}', this)" ${isTesting ? 'disabled' : ''}>
                ${isTesting ? '<span class="spinner"></span>' : '⚡ 测试'}
              </button>
              <button class="btn btn-outline btn-sm" style="flex:1;" ${isRefreshing ? 'disabled' : ''} onclick="aisRefreshAccount('${escId}')">
                ${isRefreshing ? '⏳ 刷新中…' : '🔄 刷新'}
              </button>
              <button class="btn btn-outline btn-sm" style="flex:1;" onclick="aisOpenEditModal('${escId}')">✏️ 编辑</button>
              <button class="btn btn-outline btn-sm" style="flex:1;" onclick="aisToggleAccount('${escId}', ${!a.enabled})">${a.enabled ? '⏸ 停用' : '▶ 启用'}</button>
            </div>
            <div class="account-actions-row" style="margin-top:6px;">
              <button class="btn ${isAuthReq ? 'btn-primary' : 'btn-outline'} btn-sm" style="flex:1;" onclick="openAisReloginCookie('${escId}')">🔑 更新 Cookie</button>
              <button class="btn btn-outline btn-sm" style="flex:1;" onclick="aisExportAccount('${escId}')">📤 导出</button>
              <button class="btn btn-outline btn-sm" style="flex:1; color:var(--danger); border-color:rgba(239,68,68,0.4);" onclick="aisDeleteAccount('${escId}')">🗑 删除</button>
            </div>
          </div>
        </div>`;
    }).join('');
  } catch (e) {
    box.innerHTML = `<div class="empty" style="color:var(--danger)">加载失败：${escapeHtml(e.message)}</div>`;
  }
}

function renderAisSchedulerCard() {
  const sch = $('schedulerCard');
  if (!sch) return;

  const cfg = aisConfigCache || {};
  const cdCount = (aisCooldownsCache || []).length;

  let html = `
    <div class="section-title">
      <div>
        <span>账号调度</span>
        <div class="muted" style="font-size: 11px; margin-top: 2px;">
          WebView 引擎 · 冷却 ${cdCount} 条
        </div>
      </div>
      <div style="display: flex; gap: 6px; flex-wrap: wrap;">
        <button class="btn btn-outline btn-sm" ${aisRefreshingAll ? 'disabled' : ''} onclick="aisRefreshAllAccounts()">
          ${aisRefreshingAll ? `<span class="spinner"></span>刷新中 (${aisRefreshDone}/${aisRefreshTotal})` : '🔄 刷新全部'}
        </button>
        ${cdCount > 0 ? `<button class="btn btn-outline btn-sm" style="color:var(--warning); border-color:rgba(245,158,11,0.4);" onclick="aisClearAllCooldowns()">清除冷却 (${cdCount})</button>` : ''}
      </div>
    </div>

  `;

  // 冷却列表
  if (cdCount > 0) {
    html += `
      <div style="margin-top:10px; padding-top:10px; border-top:1px solid rgba(255,255,255,0.08);">
        <div class="row-between" style="margin-bottom:8px;">
          <span style="font-size:12px; font-weight:600; color:var(--warning);">❄️ 冷却中的账号/模型 (${cdCount})</span>
          <button class="btn btn-outline btn-sm" style="font-size:11px; padding:2px 8px; color:var(--warning); border-color:rgba(245,158,11,0.4);" onclick="aisClearAllCooldowns()">一键清除全部</button>
        </div>
        <div style="display:flex; flex-direction:column; gap:6px; max-height:180px; overflow-y:auto;">
          ${aisCooldownsCache.map(cd => {
            const accId = cd.account_id || '';
            const accLabel = cd.account_label || accId;
            const scope = cd.scope || '*';
            const untilStr = cd.until ? new Date(cd.until).toLocaleTimeString('zh-CN', { hour12: false }) : '冷却中';
            return `
              <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(245,158,11,0.08); border:1px solid rgba(245,158,11,0.2); border-radius:6px; padding:6px 8px; font-size:11px;">
                <div style="min-width:0; flex:1; margin-right:8px;">
                  <div class="mono" style="font-weight:600; word-break:break-all;">${escapeHtml(accLabel)}</div>
                  <div class="muted">${escapeHtml(cd.model_id || '所有模型')} · ${escapeHtml(cd.channel || '全部通道')} · 恢复: ${untilStr}${cd.reason ? ` · ${escapeHtml(cd.reason)}` : ''}</div>
                </div>
                <button class="btn btn-outline btn-sm" style="padding:2px 8px; font-size:11px; white-space:nowrap;" data-id="${escapeHtml(accId)}" data-scope="${escapeHtml(scope)}" onclick="aisClearCooldown(this.dataset.id, this.dataset.scope)">解除</button>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  // 活动请求
  if (aisRequestsCache && aisRequestsCache.length > 0) {
    html += `
      <div style="margin-top:10px; padding-top:10px; border-top:1px solid rgba(255,255,255,0.08);">
        <div style="font-size:12px; font-weight:600; color:var(--accent); margin-bottom:8px;">⚡ 活动请求 (${aisRequestsCache.length})</div>
        <div style="display:flex; flex-direction:column; gap:6px; max-height:180px; overflow-y:auto;">
          ${aisRequestsCache.map(req => {
            const reqId = req.id || '';
            const startedStr = req.started_at ? new Date(req.started_at).toLocaleTimeString('zh-CN', { hour12: false }) : '';
            return `
              <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(56,189,248,0.08); border:1px solid rgba(56,189,248,0.2); border-radius:6px; padding:6px 8px; font-size:11px;">
                <div style="min-width:0; flex:1; margin-right:8px;">
                  <div class="mono" style="font-weight:600;">${escapeHtml(req.model || '请求')} <span class="tag tag-online" style="font-size:9px;">${escapeHtml(req.state || 'running')}</span></div>
                  <div class="muted">${escapeHtml(req.account_label || req.account_id || '-')} · ${escapeHtml(req.channel || '-')} · 开始: ${startedStr}</div>
                </div>
                <button class="btn btn-outline btn-sm" style="padding:2px 8px; font-size:11px; color:var(--danger); border-color:rgba(239,68,68,0.4);" data-id="${escapeHtml(reqId)}" onclick="aisCancelRequest(this.dataset.id)">⏹ 取消</button>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  // 底部双按钮行
  html += `
    <div style="display: flex; gap: 8px; margin-top: 10px;">
      <button class="btn btn-outline btn-sm" style="flex: 1;" onclick="aisTestAll(this)" ${aisTestingAll ? 'disabled' : ''}>
        ${aisTestingAll ? '<span class="spinner"></span>全部测试中…' : '⚡ 全部测试'}
      </button>
      <button class="btn btn-outline btn-sm" style="flex: 1;" onclick="aisRefreshAllAccounts()" ${aisRefreshingAll ? 'disabled' : ''}>
        ${aisRefreshingAll ? `<span class="spinner"></span>刷新中 (${aisRefreshDone}/${aisRefreshTotal})` : '🔄 刷新全部账号'}
      </button>
    </div>
  `;

  sch.innerHTML = html;
}

async function aisTestAccount(id, btn) {
  if (aisTestingAccounts.has(id)) return;
  aisTestingAccounts.add(id);
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>测试中…';
  }
  const start = Date.now();
  try {
    const res = await postJson(`/ais/api/accounts/${encodeURIComponent(id)}/refresh`, {});
    const latency_ms = Date.now() - start;
    aisRefreshTimes[id] = Date.now();
    delete aisRefreshErrors[id];
    modelCache.ais = null;
    const currM = Array.isArray(res.models) ? res.models.length : (res.models ?? (res.account?.models?.length ?? 0));
    const currT = res.tier || res.account?.benefit_tier || 'Free';
    aisTestResults[id] = { ok: true, latency_ms, model: `${currT} · ${currM}个模型` };
    showToast(`可用 · ${fmtSec(latency_ms)}`, 'success');
  } catch (e) {
    const latency_ms = Date.now() - start;
    aisRefreshErrors[id] = e.message;
    aisTestResults[id] = { ok: false, latency_ms, error: e.message };
    showToast(`测试未通过：${e.message}`, 'error');
  } finally {
    aisTestingAccounts.delete(id);
    await loadAisAccounts();
  }
}

async function aisTestAll(btn) {
  if (aisTestingAll) return;
  const targets = aisAccountsCache.filter(a => a.enabled !== false && !aisTestingAccounts.has(a.id));
  if (!targets.length) {
    showToast('没有已启用的 AIS 账号可测试', 'info');
    return;
  }
  aisTestingAll = true;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>全部测试中…';
  }
  let okCount = 0;
  const concurrency = 3;
  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const acc = targets[cursor++];
      const id = acc.id;
      aisTestingAccounts.add(id);
      const start = Date.now();
      try {
        const res = await postJson(`/ais/api/accounts/${encodeURIComponent(id)}/refresh`, {});
        const latency_ms = Date.now() - start;
        aisRefreshTimes[id] = Date.now();
        delete aisRefreshErrors[id];
        const currM = Array.isArray(res.models) ? res.models.length : (res.models ?? (res.account?.models?.length ?? 0));
        const currT = res.tier || res.account?.benefit_tier || 'Free';
        aisTestResults[id] = { ok: true, latency_ms, model: `${currT} · ${currM}个模型` };
        okCount++;
      } catch (e) {
        aisRefreshErrors[id] = e.message;
        aisTestResults[id] = { ok: false, latency_ms: Date.now() - start, error: e.message };
      } finally {
        aisTestingAccounts.delete(id);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, () => worker()));
  if (okCount > 0) modelCache.ais = null;
  aisTestingAll = false;
  showToast(`可用 ${okCount} / 共 ${targets.length}`, okCount === targets.length ? 'success' : 'warn');
  await loadAisAccounts();
}

function showAisAccountModels(id) {
  const acc = aisAccountsCache.find(a => a.id === id);
  if (!acc) return;
  const list = acc.models || [];
  showText(`可用模型 (${list.length})`, `账号：${acc.label || acc.id}`, list.length ? list.join('\n') : '暂无模型数据，请点击「刷新」获取');
}

async function aisClearCooldown(accountId, scope) {
  try {
    await deleteReq(`/ais/api/accounts/${encodeURIComponent(accountId)}/cooldowns/${encodeURIComponent(scope || '*')}`);
    showToast('冷却已解除', 'success');
    loadAccounts();
  } catch (e) {
    showToast(`解除冷却失败: ${e.message}`, 'error');
  }
}

async function aisClearAllCooldowns() {
  if (!aisCooldownsCache || !aisCooldownsCache.length) return;
  const seen = new Set();
  let cleared = 0;
  for (const cd of aisCooldownsCache) {
    const key = `${cd.account_id || ''}:${cd.scope || '*'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      await deleteReq(`/ais/api/accounts/${encodeURIComponent(cd.account_id)}/cooldowns/${encodeURIComponent(cd.scope || '*')}`);
      cleared++;
    } catch (e) { /* ignore single error */ }
  }
  showToast(`已解除 ${cleared} 条冷却`, 'success');
  loadAccounts();
}

async function aisCancelRequest(id) {
  try {
    await postJson(`/ais/api/requests/${encodeURIComponent(id)}/cancel`, {});
    showToast('已取消活动请求', 'success');
    loadAccounts();
  } catch (e) {
    showToast(`取消请求失败: ${e.message}`, 'error');
  }
}

async function aisRefreshAccount(id) {
  if (aisRefreshingIds.has(id)) return;
  aisRefreshingIds.add(id);
  loadAccounts();
  try {
    const res = await postJson(`/ais/api/accounts/${encodeURIComponent(id)}/refresh`, {});
    aisRefreshTimes[id] = Date.now();
    delete aisRefreshErrors[id];

    const prevM = Array.isArray(res.previous_models) ? res.previous_models.length : (res.previous_models ?? 0);
    const currM = Array.isArray(res.models) ? res.models.length : (res.models ?? (res.account?.models?.length ?? 0));
    const fmtT = t => (!t || t === 'Unknown') ? '未知' : t;
    const prevT = fmtT(res.previous_tier);
    const currT = fmtT(res.tier || res.account?.benefit_tier);
    const tierPart = prevT !== currT ? `${prevT} → ${currT}` : currT;
    const modelPart = prevM !== currM ? `${prevM} → ${currM}` : `${currM}`;
    const summary = `权益: ${tierPart} · 模型: ${modelPart}`;

    aisRefreshResults[id] = summary;
    modelCache.ais = null;
    showToast(`${id} 刷新成功: ${summary}`, 'success');
  } catch (e) {
    aisRefreshErrors[id] = e.message;
    showToast(`${id} 刷新失败: ${e.message}`, 'error');
  } finally {
    aisRefreshingIds.delete(id);
    loadAccounts();
  }
}

async function aisRefreshAllAccounts() {
  if (aisRefreshingAll) return;
  const targets = aisAccountsCache.filter(a => a.enabled !== false && !aisRefreshingIds.has(a.id));
  if (!targets.length) {
    showToast('没有已启用的账号可刷新', 'info');
    return;
  }
  aisRefreshingAll = true;
  aisRefreshTotal = targets.length;
  aisRefreshDone = 0;
  renderAisSchedulerCard();

  let successCount = 0;
  let failCount = 0;
  const concurrency = 4;
  let cursor = 0;

  async function worker() {
    while (cursor < targets.length) {
      const acc = targets[cursor++];
      const id = acc.id;
      aisRefreshingIds.add(id);
      try {
        const res = await postJson(`/ais/api/accounts/${encodeURIComponent(id)}/refresh`, {});
        aisRefreshTimes[id] = Date.now();
        delete aisRefreshErrors[id];
        const currM = Array.isArray(res.models) ? res.models.length : (res.models ?? (res.account?.models?.length ?? 0));
        const currT = res.tier || res.account?.benefit_tier || 'Free';
        aisRefreshResults[id] = `权益: ${currT} · 模型数: ${currM}`;
        successCount++;
      } catch (e) {
        aisRefreshErrors[id] = e.message;
        failCount++;
      } finally {
        aisRefreshingIds.delete(id);
        aisRefreshDone++;
        renderAisSchedulerCard();
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, targets.length) }, () => worker());
  await Promise.all(workers);

  if (successCount > 0) modelCache.ais = null;
  aisRefreshingAll = false;
  showToast(`全部刷新完成：成功 ${successCount} 个，失败 ${failCount} 个`, failCount > 0 ? 'warn' : 'success');
  loadAccounts();
}

async function aisToggleAccount(id, enabled) {
  const acc = aisAccountsCache.find(a => a.id === id) || {};
  const draft = {
    label: acc.label || id,
    enabled: !!enabled,
    proxy: acc.proxy || '',
    locale: acc.locale || navigator.language || 'en-US',
    timezone: acc.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  };
  try {
    await putJson(`/ais/api/accounts/${encodeURIComponent(id)}`, draft);
    showToast(enabled ? '账号已启用' : '账号已停用', 'success');
    loadAccounts();
  } catch (e) {
    showToast(`操作失败: ${e.message}`, 'error');
  }
}

function aisOpenEditModal(id) {
  const acc = aisAccountsCache.find(a => a.id === id);
  if (!acc) return;
  aisEditingId = id;
  $('aisEditLabel').value = acc.label || id;
  $('aisEditEnabled').checked = acc.enabled !== false;
  $('aisEditProxy').value = acc.proxy || '';
  $('aisEditLocale').value = acc.locale || navigator.language || 'en-US';
  $('aisEditTimezone').value = acc.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  openModal('aisEditModal');
}

async function saveAisAccountEdit() {
  if (!aisEditingId) return;
  const acc = aisAccountsCache.find(a => a.id === aisEditingId) || {};
  const enabled = $('aisEditEnabled').checked;
  const proxy = $('aisEditProxy').value.trim();
  const locale = $('aisEditLocale').value.trim() || navigator.language || 'en-US';
  const timezone = $('aisEditTimezone').value.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  const draft = {
    label: acc.label || aisEditingId,
    enabled,
    proxy,
    locale,
    timezone,
  };

  try {
    await putJson(`/ais/api/accounts/${encodeURIComponent(aisEditingId)}`, draft);
    showToast('账号设置已保存', 'success');
    closeModal('aisEditModal');
    loadAccounts();
  } catch (e) {
    showToast(`保存失败: ${e.message}`, 'error');
  }
}

async function aisDeleteAccount(id) {
  if (!confirm(`确定删除账号 ${id} 吗？`)) return;
  try {
    await deleteReq(`/ais/api/accounts/${encodeURIComponent(id)}`);
    delete aisRefreshTimes[id];
    delete aisRefreshErrors[id];
    delete aisRefreshResults[id];
    delete aisTestResults[id];
    modelCache.ais = null;
    showToast('已删除账号', 'success');
    loadAccounts();
  } catch (e) {
    showToast(`删除失败: ${e.message}`, 'error');
  }
}

async function aisExportAccount(id) {
  try {
    const d = await getJson('/ais-local/export');
    const acc = aisAccountsCache.find(a => a.id === id) || {};
    const targets = new Set(
      [id, acc.id, acc.email, acc.label]
        .filter(Boolean)
        .map(v => String(v).trim().toLowerCase())
    );
    const list = Array.isArray(d && d.accounts) ? d.accounts : [];
    const matched = list.filter(item => {
      if (!item || typeof item !== 'object') return false;
      return [item.email, item.id, item.label]
        .filter(Boolean)
        .some(v => targets.has(String(v).trim().toLowerCase()));
    });
    if (!matched.length) {
      showToast('未找到该账号的导出数据', 'error');
      return;
    }
    const email = matched[0].email || matched[0].id || acc.label || id;
    const out = {
      format: (d && d.format) || 'wag2api-ais',
      version: (d && d.version) || 1,
      exported_at: (d && d.exported_at) || new Date().toISOString(),
      accounts: [matched[0]],
    };
    showText(
      '导出 ' + email,
      '包含登录 Cookie，等同账号密码，请妥善保管。可在 AIS「导入」里粘贴恢复。',
      JSON.stringify(out, null, 2)
    );
  } catch (e) {
    showToast('导出失败：' + e.message, 'error');
  }
}

function showAccountErrorDetail(label, detail) {
  showText(`账号异常：${label}`, '完整错误原因及堆栈，可复制排查：', detail || '无详细错误信息');
}

function openAisReloginCookie(id) {
  openAuthModal();
  switchAisAuthTab('cookie');
  showToast(`请粘贴 ${id} 的新 Cookie`, 'info');
}

// AG 账号：每个账号显示 Gemini / Claude 的 5 小时与 7 天额度
const DEFAULT_SCHEDULING_MODES = [
  { id: 'cache_first', label: '缓存优先', desc: '优先复用最近调用的账号，最大化 KV-Cache 命中' },
  { id: 'balance', label: '均衡', desc: '在可用账号之间轮询分配，负载更均匀' },
  { id: 'performance', label: '性能优先', desc: '优先选择平均延迟最低、成功率最高的账号' },
  { id: 'fixed', label: '固定账号', desc: '始终使用指定的单一账号' },
];

function formatAccountPerfRow(p) {
  const rate = p.success_rate;
  const rateText = (rate === null || rate === undefined) ? '--' : Math.round(Number(rate) * 100) + '%';
  const lat = p.avg_latency_ms;
  const latText = fmtMs(lat);
  const failStreak = Number(p.fail_streak) || 0;
  return `
${failStreak >= 3 ? `<div class="account-perf-row mono"><span class="fail-streak-warn">连续失败 ${failStreak} 次</span></div>` : ''}
  `;
}

function renderAccountTestBanner(res) {
  if (!res) return '';
  if (res.ok) {
    const lat = res.latency_ms !== null && res.latency_ms !== undefined ? fmtSec(res.latency_ms) : '--';
    const mod = escapeHtml(res.model || '');
    return `
      <div class="account-test-banner success" style="display:block;">
        ✓ 可用 · ${lat}${mod ? ' · ' + mod : ''}
      </div>
    `;
  }
  const statusStr = (res.status !== undefined && res.status !== null && String(res.status).trim()) ? String(res.status) : '';
  const errStr = String(res.error || res.reply || '测试未通过');
  const summary = escapeHtml(statusStr ? `${statusStr} · ${errStr}` : errStr);
  const isValidation = res.kind === 'validation' && res.validation_url;
  return `
    <div class="account-test-banner error" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px;">
      <span style="word-break:break-word;">✗ ${summary}</span>
      ${isValidation ? `<a href="${escapeHtml(res.validation_url)}" target="_blank" rel="noopener noreferrer" class="btn btn-primary btn-sm" style="padding:2px 8px;font-size:11px;text-decoration:none;margin-left:auto;">去验证 ↗</a>` : ''}
    </div>
  `;
}

async function agTestAccount(email, btn) {
  if (agTestingAccounts.has(email)) return;
  agTestingAccounts.add(email);
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>测试中…';
  }
  try {
    const res = await postJson('/api/accounts/test', { email });
    agTestResults[email] = res || { ok: false, error: '无响应' };
    if (res && res.ok) {
      showToast(`可用 · ${fmtSec(res.latency_ms ?? 0)}`, 'success');
    } else {
      const err = (res && (res.error || res.reply)) || '测试未通过';
      showToast(`测试未通过：${err}`, 'error');
    }
  } catch (e) {
    agTestResults[email] = { ok: false, error: e.message };
    showToast('测试出错：' + e.message, 'error');
  } finally {
    agTestingAccounts.delete(email);
    await loadAgAccounts();
  }
}

async function agTestAll(btn) {
  if (agTestingAll) return;
  agTestingAll = true;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>全部测试中…';
  }
  try {
    const res = await postJson('/api/accounts/test-all', {});
    const results = Array.isArray(res?.results) ? res.results : (Array.isArray(res) ? res : []);
    results.forEach(r => {
      if (r && r.email) agTestResults[r.email] = r;
    });
    const okCount = results.filter(r => r && r.ok).length;
    const total = results.length;
    showToast(`可用 ${okCount} / 共 ${total}`, okCount === total && total > 0 ? 'success' : 'warn');
  } catch (e) {
    showToast('全部测试失败：' + e.message, 'error');
  } finally {
    agTestingAll = false;
    await loadAgAccounts();
  }
}

async function togglePrewarmWeekly(enabled) {
  try {
    agSchedulingState.prewarm_weekly = enabled;
    const r = await postJson('/api/scheduling', { prewarm_weekly: enabled });
    if (r && r.ok === false) {
      showToast(r.error || '设置预热失败', 'warn');
    } else {
      showToast(enabled ? '已开启周额度智能预热' : '已关闭周额度智能预热', 'success');
    }
  } catch (e) {
    showToast('设置失败：' + e.message, 'error');
  }
  await loadAgAccounts();
}

async function setSchedulingMode(mode) {
  let fixedEmail = agSchedulingState.fixed_email || '';
  if (mode === 'fixed' && !fixedEmail) {
    fixedEmail = (agAccountsCache[0] && agAccountsCache[0].email) || '';
  }
  agSchedulingState.mode = mode;
  agSchedulingState.fixed_email = fixedEmail;
  try {
    const r = await postJson('/api/scheduling', { mode, fixed_email: fixedEmail });
    if (r && r.ok === false) {
      showToast(r.error || r.msg || '切换模式失败', 'warn');
    } else {
      showToast('调度模式已更新', 'success');
    }
  } catch (e) {
    showToast('设置调度模式失败：' + e.message, 'error');
  }
  await loadAgAccounts();
}

async function setSchedulingFixedEmail(email) {
  agSchedulingState.mode = 'fixed';
  agSchedulingState.fixed_email = email;
  try {
    const r = await postJson('/api/scheduling', { mode: 'fixed', fixed_email: email });
    if (r && r.ok === false) {
      showToast(r.error || r.msg || '指定账号失败', 'warn');
    } else {
      showToast(`已固定账号：${email}`, 'success');
    }
  } catch (e) {
    showToast('指定账号失败：' + e.message, 'error');
  }
  await loadAgAccounts();
}

async function loadAgAccounts() {
  const box = $('accountList');
  const sch = $('schedulerCard');
  sch.style.display = 'block';
  try {
    const [status, st, poolRes] = await Promise.all([
      getJson('/api/status'),
      getJson('/api/stats'),
      getJson('/api/accounts/pool').catch(() => ({})),
    ]);
    if (engine !== 'ag') return;
    const accs = status.accounts || [];
    agAccountsCache = accs;
    const usage = {};
    (st.accounts || []).forEach(a => { usage[a.email] = a; });
    $('accountCount').textContent = accs.length;

    const poolList = Array.isArray(poolRes?.accounts) ? poolRes.accounts : (Array.isArray(poolRes?.poolStatus) ? poolRes.poolStatus : []);
    const poolStatusMap = {};
    poolList.forEach(p => { if (p && p.email) poolStatusMap[p.email] = p; });

    const scheduling = poolRes?.scheduling || {};
    agSchedulingState = scheduling;
    const modes = (Array.isArray(scheduling.modes) && scheduling.modes.length) ? scheduling.modes : DEFAULT_SCHEDULING_MODES;
    const currentMode = scheduling.mode || (poolRes?.selected_email ? 'fixed' : 'cache_first');
    const fixedEmail = scheduling.fixed_email || poolRes?.selected_email || (accs[0] && accs[0].email) || '';
    const currentModeObj = modes.find(m => m.id === currentMode) || modes[0];
    const hasBlocked = accs.some(a => !!a.validation_blocked);

    const qr = scheduling.quota_refresh || {};
    let qrText = '额度每 15 分钟自动刷新';
    if (qr.last_run_at) {
      const d = new Date(qr.last_run_at);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      qrText += ` · 上次 ${hh}:${mm}`;
    }

    sch.innerHTML = `
      <div class="section-title" style="margin-bottom: 6px;">
        <span>账号调度</span>
        <div style="display: flex; gap: 6px; flex-wrap: wrap;">
          <button class="btn btn-outline btn-sm" onclick="agRefreshAllQuota()">刷新全部额度</button>
          <button class="btn btn-outline btn-sm" onclick="agClearCooldowns()">清除冷却</button>
          ${hasBlocked ? '<button class="btn btn-outline btn-sm" style="color:var(--danger);border-color:rgba(239,68,68,0.4);" onclick="agClearValidation(\'\')">解除全部验证标记</button>' : ''}
        </div>
      </div>
      <div class="muted" style="font-size: 11px; margin-bottom: 8px;">${escapeHtml(qrText)}</div>
      <p class="muted" style="margin-bottom: 8px;">调度模式选择及负载均衡策略：</p>
      <div class="sched-modes-wrap">
        <div class="sched-modes-grid">
          ${modes.map(m => `
            <button type="button" class="sched-mode-btn ${m.id === currentMode ? 'active' : ''}" onclick="setSchedulingMode('${escapeHtml(m.id)}')">
              ${escapeHtml(m.label)}
            </button>
          `).join('')}
        </div>
        ${currentMode === 'fixed' ? `
          <div class="row-between" style="margin-top: 8px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,0.06);">
            <span style="font-size: 12px; color: var(--text-muted);">指定账号</span>
            <select class="input-field mono" style="margin-bottom: 0; max-width: 68%; font-size: 12px;" onchange="setSchedulingFixedEmail(this.value)">
              ${accs.map(a => `<option value="${escapeHtml(a.email)}" ${a.email === fixedEmail ? 'selected' : ''}>${escapeHtml(a.email)}</option>`).join('')}
            </select>
          </div>
        ` : ''}
        <div class="muted sched-mode-desc">${escapeHtml(currentModeObj?.desc || '')}</div>
      </div>
      <div class="row-between" style="margin-top: 10px; padding: 10px 12px; background: rgba(255,255,255,0.03); border-radius: var(--radius-md); border: 1px solid rgba(255,255,255,0.06);">
        <div style="flex: 1; padding-right: 12px;">
          <div style="font-size: 13px; font-weight: 600;">7 天周额度智能预热</div>
          <div class="muted" style="font-size: 11px; line-height: 1.4; margin-top: 2px;">周额度重置后自动发 1 次极小请求，提前开始新的周期计时</div>
        </div>
        <label class="switch" style="flex-shrink: 0;"><input type="checkbox" id="prewarmWeeklyToggle" ${scheduling.prewarm_weekly ? 'checked' : ''} onchange="togglePrewarmWeekly(this.checked)"><span class="slider"></span></label>
      </div>
      <div style="display: flex; gap: 8px; margin-top: 10px;">
        <button class="btn btn-outline btn-sm" style="flex: 1;" onclick="agTestAll(this)" ${agTestingAll ? 'disabled' : ''}>
          ${agTestingAll ? '<span class="spinner"></span>全部测试中…' : '⚡ 全部测试'}
        </button>
        <button class="btn btn-outline btn-sm" style="flex: 1;" onclick="agBenchHosts(this)">🏁 集群测速</button>
      </div>
      <div class="account-test-banner" id="ag-test-banner"></div>`;

    if (!accs.length) { box.innerHTML = '<div class="empty">还没有 Google 账号，点右上角「+ 添加」登录，或「导入」Refresh Token</div>'; return; }

    box.innerHTML = accs.map(a => {
      const id = agId(a.email);
      const u = usage[a.email] || {};
      const em = escapeHtml(a.email);
      const pStatus = poolStatusMap[a.email] || {};
      const perfRowHtml = formatAccountPerfRow({
        success_rate: pStatus.success_rate !== undefined ? pStatus.success_rate : a.success_rate,
        avg_latency_ms: pStatus.avg_latency_ms !== undefined ? pStatus.avg_latency_ms : a.avg_latency_ms,
        fail_streak: pStatus.fail_streak !== undefined ? pStatus.fail_streak : a.fail_streak,
      });

      return `
        <div class="account-card">
          <div class="account-card-header">
            <div class="item-avatar">${escapeHtml(a.email.charAt(0).toUpperCase())}</div>
            <div class="account-card-info">
              <div class="account-title-row">
                <span class="account-name">${em}</span>
                <span class="tag tag-global">Google</span>
                <span id="tier-${id}">${tierTagHtml(agQuota[a.email]?.tier || a.tier)}</span>
                ${(pStatus.protected_families || []).map(f => {
                  const name = f === 'claude' ? 'Claude' : (f === 'argon' ? 'Argon' : 'Gemini');
                  return `<span class="tag tag-protected">${name} 已保护</span>`;
                }).join('')}
                ${a.validation_blocked ? '<span class="tag tag-offline" style="background:rgba(239,68,68,0.2);color:#ef4444;border:1px solid rgba(239,68,68,0.4);">需验证</span>' : ''}
                <span class="tag ${a.hasRefreshToken ? 'tag-online' : 'tag-offline'}">${a.hasRefreshToken ? '● 正常' : '● 凭据缺失'}</span>
                ${a.isActive ? '<span class="tag tag-online">当前</span>' : ''}
              </div>
              <div class="account-meta mono">项目 ${escapeHtml(a.projectId || '-')} · 令牌 ${a.expiresInMinutes > 0 ? a.expiresInMinutes + ' 分钟后续期' : '待续期'}</div>
            </div>
          </div>
          ${a.validation_blocked ? `
            <div class="account-validation-box">
              <div class="validation-reason">⚠️ ${escapeHtml(a.validation_reason || '此账号需通过 Google 安全验证')}</div>
              <div class="validation-actions">
                ${a.validation_url ? `<a href="${escapeHtml(a.validation_url)}" target="_blank" rel="noopener noreferrer" class="btn btn-outline btn-sm">去验证 ↗</a>` : ''}
                <button class="btn btn-primary btn-sm" onclick="agClearValidation('${em}')">已验证，解除</button>
              </div>
            </div>` : ''}
          <div class="quota-list" id="quota-${id}">${quotaHtml(agQuota[a.email])}</div>
          ${perfRowHtml}
          ${renderAccountTestBanner(agTestResults[a.email])}
          <div class="account-actions-wrap">
            <div class="account-actions-row">
              <button class="btn btn-outline btn-sm" onclick="agTestAccount('${em}', this)" ${agTestingAccounts.has(a.email) ? 'disabled' : ''}>
                ${agTestingAccounts.has(a.email) ? '<span class="spinner"></span>测试中…' : '⚡ 测试'}
              </button>
              <button class="btn btn-outline btn-sm" onclick="agLoadQuota('${em}', true)">🔄 额度</button>
              <button class="btn btn-outline btn-sm" onclick="agExportAccount('${em}')">📤 导出</button>
              <button class="btn btn-outline btn-sm" onclick="agSwitch('${em}')" ${a.isActive ? 'disabled' : ''}>🌟 使用</button>
            </div>
            <div class="account-actions-row">
              <button class="btn btn-outline btn-sm" style="color: var(--danger); border-color: rgba(239,68,68,0.4);" onclick="agRemove('${em}')">🗑 删除</button>
            </div>
          </div>
        </div>`;
    }).join('');
    accs.forEach(a => { if (!agQuota[a.email]) agLoadQuota(a.email); });
  } catch (e) {
    box.innerHTML = `<div class="empty" style="color:var(--danger)">加载失败：${escapeHtml(e.message)}</div>`;
  }
}

const agId = email => email.replace(/[^a-zA-Z0-9]/g, '_');

function quotaHtml(q) {
  if (!q) return '<div class="muted">额度加载中…</div>';
  if (!q.ok) return `<div class="muted" style="color:var(--warning)">额度读取失败：${escapeHtml(q.message || q.error || '未知')}</div>`;

  let buckets = [];
  if (Array.isArray(q.buckets) && q.buckets.length > 0) {
    buckets = q.buckets;
  } else {
    buckets = [
      { name: 'Gemini 5h', ...(q.gemini_5h || {}) },
      { name: 'Gemini 7d', ...(q.gemini_7d || {}) },
      { name: 'Claude/GPT 5h', ...(q.claude_5h || {}) },
      { name: 'Claude/GPT 7d', ...(q.claude_7d || {}) },
    ];
  }

  const rows = buckets.map(b => {
    let name = b.name || b.label || b.group || '配额';
    name = name.replace(/\s*\/\s*/g, '/');
    if (b.window && !name.toLowerCase().includes(String(b.window).toLowerCase())) {
      const winLabel = b.window === '7d' ? '7d' : (b.window === '5h' ? '5h' : b.window);
      name = `${name} ${winLabel}`;
    }
    const isMissing = !!b.missing || b.percentage === null || b.percentage === undefined;
    if (isMissing) {
      const note = b.note || '未提供';
      return `
        <div class="quota-row missing">
          <span class="qn">${escapeHtml(name)}</span>
          <div class="qbar qbar-missing"><i class="empty-bar"></i></div>
          <span class="qp qp-missing">未提供</span>
          <span class="qr">${escapeHtml(note)}</span>
        </div>
      `;
    }

    const p = Math.max(0, Math.min(100, Math.round(Number(b.percentage))));
    const cls = p < 20 ? 'low' : p < 50 ? 'mid' : '';
    const qr = (b.reset_text || '') + (b.inferred ? '（推算）' : '');
    return `
      <div class="quota-row">
        <span class="qn">${escapeHtml(name)}</span>
        <div class="qbar"><i class="${cls}" style="width:${p}%"></i></div>
        <span class="qp">剩 ${p}%</span>
        <span class="qr">${escapeHtml(qr)}</span>
      </div>
    `;
  }).join('');

  return rows + (q.updated_time ? `<div class="muted" style="text-align:right;font-size:11px;margin-top:4px;">更新于 ${escapeHtml(q.updated_time)}</div>` : '');
}

function tierTagHtml(tier) {
  if (!tier) return '';
  const t = String(tier).toUpperCase();
  if (t === 'ULTRA') return '<span class="tag tag-tier-ultra">ULTRA</span>';
  if (t === 'PRO' || t === 'PAID') return `<span class="tag tag-tier-pro">${escapeHtml(t)}</span>`;
  if (t === 'FREE') return '<span class="tag tag-tier-free">FREE</span>';
  if (t === 'UNKNOWN') return '<span class="tag tag-tier-free">未知权益</span>';
  return `<span class="tag tag-tier-free">${escapeHtml(t)}</span>`;
}

async function agLoadQuota(email, toast) {
  const box = $(`quota-${agId(email)}`);
  if (box && toast) box.innerHTML = '<div class="muted">额度加载中…</div>';
  try {
    agQuota[email] = await getJson('/api/gemini/quota?email=' + encodeURIComponent(email));
  } catch (e) { agQuota[email] = { ok: false, message: e.message }; }
  const b = $(`quota-${agId(email)}`);
  if (b) b.innerHTML = quotaHtml(agQuota[email]);
  const tierEl = $(`tier-${agId(email)}`);
  if (tierEl) tierEl.innerHTML = tierTagHtml(agQuota[email]?.tier);
  if (toast) showToast('额度已刷新', 'success');
}

async function agClearValidation(email) {
  try {
    const res = await postJson('/api/accounts/clear-validation', { email: email || '' });
    showToast((res && res.message) || (email ? '已解除验证标记' : '已解除全部验证标记'), 'success');
    loadAgAccounts();
  } catch (e) {
    showToast('解除失败：' + e.message, 'error');
  }
}

async function agClearCooldowns() {
  await postJson('/api/accounts/clear-cooldown');
  showToast('AG 账号冷却已清除', 'success');
  loadAgAccounts();
}
async function agRefreshAllQuota() {
  Object.keys(agQuota).forEach(k => delete agQuota[k]);
  loadAgAccounts();
}

async function agSwitch(email) { await postJson('/api/accounts/switch', { email }); showToast('已切换当前账号', 'success'); loadAgAccounts(); }
async function agRemove(email) {
  if (!confirm(`确定删除 ${email}？`)) return;
  await postJson('/api/accounts/remove', { email });
  delete agQuota[email];
  showToast('已删除', 'success');
  loadAgAccounts();
}
async function agExportAccount(email) {
  try {
    const d = await getJson('/api/accounts/export');
    const target = String(email || '').trim().toLowerCase();
    const list = Array.isArray(d && d.accounts) ? d.accounts : [];
    const matched = list.filter(a => a && String(a.email || a.id || '').trim().toLowerCase() === target);
    if (!matched.length) {
      showToast('未找到该账号的导出数据', 'error');
      return;
    }
    const out = { ...d, accounts: [matched[0]] };
    showText(
      '导出 ' + (matched[0].email || email),
      '含 Refresh Token，可在任意 wag2api 的 AG 引擎导入。请妥善保管。',
      JSON.stringify(out, null, 2)
    );
  } catch (e) {
    showToast('导出失败：' + e.message, 'error');
  }
}

// 集群测速：同一提示词交替发给 daily / autopush / prod，各 2 轮，比较首字与真实生成速度
function fmtS(ms) { return ms == null ? '—' : (ms / 1000).toFixed(1) + 's'; }
function renderBench(d) {
  const lines = [`${d.account || ''} · ${d.model || ''} · ${d.running ? '进行中 ' + (d.progress || '') : '完成'}`];
  for (const s of d.summary || []) {
    if (!s.ok) { lines.push(`❌ ${s.host} · ${s.statuses} · ${s.error || '失败'}`); continue; }
    lines.push(`✅ ${s.host} (${s.ok}/${s.total}) · 首块 ${fmtS(s.t_first_chunk)} · 正文 ${fmtS(s.t_first_text)} · 总 ${fmtS(s.total_ms)} · 生成 ${s.gen_tps ?? '—'} t/s · 正文 ${s.text_tps ?? '—'} t/s`);
  }
  for (const r of d.runs || []) {
    lines.push(`  #${r.round} ${r.host} ${r.status ?? 'ERR'} 首块 ${fmtS(r.t_first_chunk)} 总 ${fmtS(r.total_ms)} 出 ${r.output_tokens || 0} (思考 ${r.thoughts_tokens || 0}) ${r.gen_tps ?? '—'} t/s${r.error ? ' · ' + r.error : ''}`);
  }
  testBanner('ag-test-banner', d.running ? '' : ((d.summary || []).some(s => s.ok) ? 'success' : 'error'), lines.join('\n'));
  $('ag-test-banner').style.whiteSpace = 'pre-line';
}
async function agBenchHosts(btn) {
  if (!confirm('将用当前账号向 3 个集群各发 2 次长文请求，约 2–4 分钟，会消耗少量额度。开始？')) return;
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = '测速中…';
  try {
    let d = await postJson('/api/bench/hosts', { rounds: 2 });
    if (!d.ok && !d.running) throw new Error(d.error || '启动失败');
    renderBench(d);
    while (d.running) {
      await new Promise(r => setTimeout(r, 3000));
      d = await getJson('/api/bench/hosts');
      renderBench(d);
    }
  } catch (e) { testBanner('ag-test-banner', 'error', `❌ ${e.message}`); }
  finally { btn.textContent = orig; btn.disabled = false; }
}

// 添加账号
function openAuthModal() {
  if (engine === 'ag' && !agReady()) { showToast('请先启用 AG 引擎', 'warn'); return; }
  $('authTitle').textContent = engine === 'ais' ? '添加 Google AI Studio 账号' : '添加 Google 账号';
  $('authDesc').textContent = engine === 'ais'
    ? '粘贴电脑浏览器里已登录 AI Studio 的 Cookie（Google 不允许在 App 内登录）。'
    : '用 Google 登录授权，完成后自动加入账号池。也可以在「导入」里直接粘贴 Refresh Token。';
  if (engine === 'ais') {
    $('aisAuthArea').style.display = 'block';
    $('agAuthArea').style.display = 'none';
    $('startAuthBtn').style.display = 'none';
    switchAisAuthTab('cookie');
  } else {
    $('aisAuthArea').style.display = 'none';
    $('agAuthArea').style.display = 'block';
    $('authResultArea').style.display = 'none';
    $('agPasteArea').style.display = 'none';
    $('pollStatusText').textContent = '';
    const btn = $('startAuthBtn');
    btn.style.display = 'block'; btn.disabled = false; btn.textContent = '获取授权链接';
  }
  openModal('authModal');
}

function getAisEnvInput() {
  const proxy = $('aisEnvProxy')?.value?.trim() || '';
  const locale = $('aisEnvLocale')?.value?.trim() || navigator.language || 'en-US';
  const timezone = $('aisEnvTimezone')?.value?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return { proxy, locale, timezone };
}

function resetAisDiscover() {
  aisDiscoveredAccounts = [];
  aisSelectedAuthUsers.clear();
  const area = $('aisDiscoverArea');
  if (area) area.style.display = 'none';
  const countEl = $('aisDiscoverCount');
  if (countEl) countEl.textContent = '0';
}

function toggleAllAisDiscover() {
  const allSelectable = aisDiscoveredAccounts.filter(a => !a.signed_out && !a.imported);
  const allSelected = allSelectable.length > 0 && allSelectable.every(a => aisSelectedAuthUsers.has(String(a.auth_user)));
  if (allSelected) {
    aisSelectedAuthUsers.clear();
  } else {
    allSelectable.forEach(a => aisSelectedAuthUsers.add(String(a.auth_user)));
  }
  renderAisDiscoverList();
}

function toggleAisDiscoverUser(authUser) {
  const k = String(authUser);
  if (aisSelectedAuthUsers.has(k)) {
    aisSelectedAuthUsers.delete(k);
  } else {
    aisSelectedAuthUsers.add(k);
  }
  renderAisDiscoverList();
}

function renderAisDiscoverList() {
  const list = $('aisDiscoverList');
  const countEl = $('aisDiscoverCount');
  const selectAllBtn = $('aisSelectAllBtn');
  if (!list) return;
  if (countEl) countEl.textContent = aisDiscoveredAccounts.length;

  const allSelectable = aisDiscoveredAccounts.filter(a => !a.signed_out && !a.imported);
  const allSelected = allSelectable.length > 0 && allSelectable.every(a => aisSelectedAuthUsers.has(String(a.auth_user)));
  if (selectAllBtn) {
    selectAllBtn.textContent = allSelected ? '取消全选' : '全选';
  }

  if (!aisDiscoveredAccounts.length) {
    list.innerHTML = '<div class="muted" style="font-size:12px;">未识别到有效 Google 账号</div>';
    return;
  }

  list.innerHTML = aisDiscoveredAccounts.map(a => {
    const k = String(a.auth_user);
    const checked = aisSelectedAuthUsers.has(k);
    const isSignedOut = !!a.signed_out;
    const isImported = !!a.imported;
    const isDisabled = isSignedOut || isImported;
    let tagHtml = '';
    if (isImported) tagHtml = '<span class="tag tag-warn">已导入</span>';
    else if (isSignedOut) tagHtml = '<span class="tag tag-offline">已登出</span>';
    else tagHtml = '<span class="tag tag-online">可导入</span>';

    return `
      <div style="font-size:12px; margin-top:6px; display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.03); border-radius:6px; padding:6px 8px;">
        <label style="display:flex; align-items:center; gap:8px; cursor:${isDisabled ? 'not-allowed' : 'pointer'}; min-width:0; flex:1; opacity:${isDisabled ? '0.6' : '1'};">
          <input type="checkbox" ${checked ? 'checked' : ''} ${isDisabled ? 'disabled' : ''} onchange="toggleAisDiscoverUser('${escapeHtml(k)}')" style="accent-color:var(--primary);" />
          <span class="mono" style="word-break:break-all;">${escapeHtml(a.email || ('u/' + a.auth_user))}</span>
        </label>
        <div>${tagHtml}</div>
      </div>
    `;
  }).join('');
}

function switchAisAuthTab(tab) {
  // 只剩粘贴 Cookie 一种方式（远程配对属于已删除的 Go 版 AIS）
  $('aisAuthCookiePane').style.display = 'block';
}

async function handleAisCookieImport() {
  const cookies = $('aisCookieInput').value.trim();
  if (!cookies) { showToast('请先粘贴 Cookie', 'warn'); return; }
  const env = getAisEnvInput();

  showToast('正在导入…');
  try {
    if (aisDiscoveredAccounts.length > 0) {
      if (aisSelectedAuthUsers.size === 0) {
        showToast('请至少勾选一个要导入的账号', 'warn');
        return;
      }
      const selected = aisDiscoveredAccounts.filter(a => aisSelectedAuthUsers.has(String(a.auth_user)));
      let count = 0;
      for (const target of selected) {
        await postJson('/ais/api/accounts/import/cookies', {
          label: '',
          cookies,
          cdp: '',
          auth_user: target.auth_user,
          ...env,
        });
        count++;
      }
      showToast(`已成功导入 ${count} 个账号`, 'success');
    } else {
      await postJson('/ais/api/accounts/import/cookies', { label: '', cookies, cdp: '', ...env });
      showToast('导入成功', 'success');
    }

    try { await postJson('/ais/api/control/start', {}); } catch (e) { /* ignore */ }
    modelCache.ais = null;
    $('aisCookieInput').value = '';
    resetAisDiscover();
    closeModal('authModal');
    loadAccounts();
  } catch (e) {
    showToast('导入失败: ' + e.message, 'error');
  }
}


async function requestAuthLink() {
  const btn = $('startAuthBtn');
  btn.disabled = true; btn.textContent = '正在生成…';
  try {
    const d = await postJson('/api/gemini/auth', {});
    if (!d.ok || !d.auth_url) throw new Error(d.error || '获取失败');
    const url = d.auth_url;
    $('authUrlInput').value = url;
    $('authLinkBtn').href = url;
    $('authResultArea').style.display = 'block';
    btn.style.display = 'none';
    $('agPasteArea').style.display = 'block';
    startAgPoll();
  } catch (e) {
    showToast('获取授权链接失败：' + e.message, 'error');
    btn.disabled = false; btn.textContent = '获取授权链接';
  }
}

async function startAgPoll() {
  if (activePollTimer) clearInterval(activePollTimer);
  let before;
  try { before = new Set(((await getJson('/api/status')).accounts || []).map(a => a.email)); } catch (e) { before = new Set(); }
  $('pollStatusText').textContent = '⏳ 等待 Google 授权完成…';
  activePollTimer = setInterval(async () => {
    try {
      const accs = (await getJson('/api/status')).accounts || [];
      const added = accs.find(a => !before.has(a.email));
      if (added) {
        clearInterval(activePollTimer); activePollTimer = null;
        $('pollStatusText').textContent = `🎉 已添加 ${added.email}`;
        setTimeout(() => { closeModal('authModal'); loadAccounts(); }, 1500);
      }
    } catch (e) { /* 继续等 */ }
  }, 2500);
}

async function submitAgCallback() {
  const v = $('agCallbackInput').value.trim();
  if (!v) { showToast('请先粘贴回调网址', 'warn'); return; }
  const d = await postJson('/api/oauth/exchange', { code_or_url: v });
  if (d.ok) {
    showToast(d.message || '授权成功', 'success');
    closeModal('authModal');
    loadAccounts();
  } else showToast(d.error || '授权失败', 'error');
}

// 导入 / 导出
function openImportModal() {
  const jumpEl = $('importAisCookieJump');
  if (engine === 'ais') {
    $('importTitle').textContent = '导入 AIS 账号';
    $('importDesc').textContent = '可粘贴：本 App 导出的 JSON（format wag2api-ais）、wag2api-backup 备份、或单个账号 Cookie（JSON / Netscape / Cookie 头）。';
    $('importInput').value = '';
    $('importInput').placeholder = '{ "format": "wag2api-ais", "accounts": [...] } 或 Cookie 内容';
    if (jumpEl) jumpEl.style.display = 'block';
    openModal('importModal');
    return;
  }
  if (engine === 'ag' && !agReady()) { showToast('请先启用 AG 引擎', 'warn'); return; }
  $('importTitle').textContent = '导入 AG 账号';
  $('importDesc').textContent = '粘贴 Refresh Token（1// 开头，一行一个），或导出的账号 JSON。备份也可以直接粘贴。';
  $('importInput').value = '';
  $('importInput').placeholder = '1//0e... 或 { "accounts": [...] }';
  if (jumpEl) jumpEl.style.display = 'none';
  openModal('importModal');
}

async function importAis(raw) {
  try {
    const env = getAisEnvInput();
    const d = await postJson('/ais/api/accounts/import/cookies', { label: '', cookies: raw, cdp: '', ...env });
    const id = (d.account && d.account.id) || '';
    try { await postJson('/ais/api/control/start', {}); } catch (e) { /* 服务可能已在运行 */ }
    modelCache.ais = null;
    return { ok: true, msg: id ? `导入成功：${id}` : '导入成功' };
  } catch (e) {
    return { ok: false, msg: e.message || '导入失败' };
  }
}

async function importAisBundle(bundle) {
  const list = Array.isArray(bundle && bundle.accounts) ? bundle.accounts : [];
  if (!list.length) {
    return { ok: false, msg: '没有可导入的 AIS 账号' };
  }
  const existing = new Set();
  try {
    const cur = await getJson('/ais/api/accounts');
    if (Array.isArray(cur && cur.accounts)) {
      aisAccountsCache = cur.accounts;
    }
  } catch (e) { /* 读取失败时回退使用缓存 */ }
  (aisAccountsCache || []).forEach(a => {
    if (a && a.id) existing.add(String(a.id).trim().toLowerCase());
    if (a && a.email) existing.add(String(a.email).trim().toLowerCase());
    if (a && a.label) existing.add(String(a.label).trim().toLowerCase());
  });

  const defaultLocale = navigator.language || 'en-US';
  const defaultTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  let okCount = 0;
  const skipped = [];
  const failed = [];

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const email = String(item.email || item.id || item.label || '').trim();
    const key = email.toLowerCase();
    if (key && existing.has(key)) {
      skipped.push(email);
      continue;
    }
    const rawState = item.storage_state !== undefined ? item.storage_state : item.cookies;
    const cookiesStr = typeof rawState === 'string'
      ? rawState.trim()
      : (rawState && typeof rawState === 'object' ? JSON.stringify(rawState) : '');
    if (!cookiesStr) {
      failed.push(`${email || '未知账号'}：缺少 storage_state`);
      continue;
    }
    const label = String(item.label || '').trim(); // 与上游一致：标签留空，邮箱由 AIS 自行识别
    const proxy = String(item.proxy || '').trim();
    const locale = String(item.locale || '').trim() || defaultLocale;
    const timezone = String(item.timezone || '').trim() || defaultTz;
    const authUser = item.auth_user !== undefined && item.auth_user !== null ? item.auth_user : 0;

    try {
      const res = await postJson('/ais/api/accounts/import/cookies', {
        label,
        cookies: cookiesStr,
        cdp: '',
        proxy,
        locale,
        timezone,
        auth_user: authUser,
      });
      const importedId = (res && res.account && res.account.id) || email || label;
      if (item.enabled === false && importedId) {
        try {
          await putJson(`/ais/api/accounts/${encodeURIComponent(importedId)}`, {
            label: label || importedId,
            enabled: false,
            proxy,
            locale,
            timezone,
          });
        } catch (e) { /* 忽略停用状态同步异常 */ }
      }
      if (key) existing.add(key);
      if (importedId) existing.add(String(importedId).trim().toLowerCase());
      okCount++;
    } catch (e) {
      failed.push(`${email || label || '未知账号'}：${e.message || '导入失败'}`);
    }
  }

  if (okCount > 0) {
    try { await postJson('/ais/api/control/start', {}); } catch (e) { /* 服务可能已在运行 */ }
    modelCache.ais = null;
    try {
      const latest = await getJson('/ais/api/accounts');
      if (Array.isArray(latest && latest.accounts)) aisAccountsCache = latest.accounts;
    } catch (e) { /* ignore */ }
  }

  const lines = [`成功 ${okCount} 个，跳过 ${skipped.length} 个，失败 ${failed.length} 个`];
  if (skipped.length) lines.push(`已存在跳过：${skipped.join(', ')}`);
  if (failed.length) lines.push(...failed);
  return {
    ok: okCount > 0 || (skipped.length > 0 && failed.length === 0),
    msg: lines.join('\n'),
  };
}

async function importAg(raw) {
  const d = await postJson('/api/accounts/import', { raw });
  const fails = (d.failed || []).map(f => `${f.email}：${f.error}`).join('\n');
  return { ok: !!d.ok, msg: (d.message || d.error || '') + (fails ? '\n' + fails : '') };
}

async function submitImport() {
  const raw = $('importInput').value.trim();
  if (!raw) { showToast('内容不能为空', 'warn'); return; }
  const btn = $('importBtn');
  btn.disabled = true; btn.textContent = '导入中…';
  try {
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { /* 纯文本 */ }
    const msgs = [];
    let anyOk = false;
    if (parsed && parsed.format === 'wag2api-ais') {
      const r = await importAisBundle(parsed);
      anyOk = r.ok;
      msgs.push(r.msg);
    } else if (parsed && parsed.format === 'wag2api-backup') {
      if (parsed.ais && Array.isArray(parsed.ais.accounts) && parsed.ais.accounts.length) {
        const r = await importAisBundle(parsed.ais);
        anyOk = anyOk || r.ok;
        msgs.push('AIS：' + r.msg);
      }
      if (parsed.ag && (parsed.ag.accounts || []).length) {
        if (agReady()) {
          const r = await importAg(JSON.stringify(parsed.ag));
          anyOk = anyOk || r.ok;
          msgs.push('AG：' + r.msg);
        } else {
          msgs.push('AG：引擎未运行，已跳过');
        }
      }
      if (parsed.note) msgs.push(parsed.note);
    } else {
      const r = engine === 'ais' ? await importAis(raw) : await importAg(raw);
      anyOk = r.ok;
      msgs.push(r.msg);
    }
    const text = msgs.join('\n') || '没有可导入的内容';
    if (msgs.length > 1 || text.includes('\n')) showText('导入结果', '', text);
    else showToast(text, anyOk ? 'success' : 'error');
    if (anyOk) { closeModal('importModal'); loadAccounts(); }
  } catch (e) {
    showToast('导入失败：' + e.message, 'error');
  } finally { btn.disabled = false; btn.textContent = '确认导入'; }
}

async function openExportModal() {
  try {
    if (engine === 'ais') {
      const d = await getJson('/ais-local/export');
      showText(
        '导出 AIS 账号',
        '包含登录 Cookie，等同账号密码，请妥善保管。可在 AIS 引擎「导入」里粘贴恢复。',
        JSON.stringify(d, null, 2)
      );
      return;
    }
    if (!agReady()) { showToast('请先启用 AG 引擎', 'warn'); return; }
    const d = await getJson('/api/accounts/export');
    showText('导出 AG 账号', '全部 Google 账号的 Refresh Token，可在 AG 引擎「导入」里恢复。请妥善保管。', JSON.stringify(d, null, 2));
  } catch (e) { showToast('导出失败：' + e.message, 'error'); }
}

async function openBackupModal() {
  const [aisData, agData] = await Promise.all([
    getJson('/ais-local/export').catch(() => null),
    agReady() ? getJson('/api/accounts/export').catch(() => null) : Promise.resolve(null),
  ]);
  const out = {
    format: 'wag2api-backup',
    version: 2,
    exported_at: new Date().toISOString(),
    ais: aisData,
    ag: agData,
  };
  const aisCount = ((out.ais && out.ais.accounts) || []).length;
  const agCount = ((out.ag && out.ag.accounts) || []).length;
  showText(
    '账号备份',
    `已备份 AIS 账号 ${aisCount} 个、AG 账号 ${agCount} 个（包含登录 Cookie 与 Refresh Token，等同账号密码，请妥善保管）。可在任一引擎「导入」里粘贴恢复。`,
    JSON.stringify(out, null, 2)
  );
}

// ── 3. 接入 ─────────────────────────────────────────────
async function loadModels(e) {
  if (modelCache[e]) return modelCache[e];
  if (e === 'ais') {
    let list = [];
    try {
      const d1 = await getJson('/ais/api/models');
      list = d1.models || d1.data || [];
    } catch (_) {}
    if (!list.length) {
      try {
        const d1v = await getJson('/ais/v1/models');
        list = d1v.data || d1v.models || [];
      } catch (_) {}
    }
    if (!list.length) {
      try {
        const d2 = await getJson('/panel/api/models/ais');
        list = d2.data || d2.models || [];
      } catch (_) {}
    }
    modelCache.ais = list.map(m => ({ id: m.id, name: m.name || m.display_name || m.id, paid: !!m.paid }));
    return modelCache.ais;
  }
  try {
    const d = await getJson('/api/models');
    const list = d.data || d.models || [];
    modelCache.ag = list.map(m => ({ id: m.id, name: m.name || m.display_name || m.id }));
    return modelCache.ag;
  } catch (err) { return []; }
}

async function loadKeys() {
  await refreshEngineInfo();
  applyEngineChrome();
  const base = (window.location.origin.startsWith('http') ? window.location.origin : 'http://127.0.0.1:8800');
  $('baseUrlDisplay').textContent = `${base}/v1`;
  const box = $('keysContent');
  if (engine === 'ag' && !agReady()) { box.innerHTML = agOffHtml(); return; }
  const models = await loadModels(engine);
  const pre = engine === 'ais' ? 'ais:' : 'ag:';
  const eps = engine === 'ais'
    ? `${base}/v1/chat/completions（OpenAI 兼容）\n${base}/v1/responses（OpenAI 兼容）\n${base}/v1/messages（Anthropic 原生）\n${base}/v1beta/models（Gemini 原生）`
    : `${base}/v1/chat/completions（OpenAI 兼容）\n${base}/v1/messages（Anthropic 原生）`;
  const sample = models[0] ? models[0].id : (engine === 'ais' ? 'gemini-2.5-flash' : 'gemini-3.8-flash-high');
  box.innerHTML = `
    <div class="section-title">${META[engine].name} 接入</div>
    <div class="muted">接口</div>
    <div class="code-box">${escapeHtml(eps)}</div>
    <div class="muted" style="margin-top:12px;">指定引擎：模型名加 <span class="mono" style="color:var(--primary)">${pre}</span> 前缀最稳；不加时按模型表自动分流，重名走默认引擎（现在是 ${META[engineInfo.default_engine || 'ais'].name}）。</div>
    <div class="muted" style="margin-top:12px;">OpenAI 接入示例 (Cherry Studio / Chatbox / NextChat)</div>
    <div class="code-box">Base URL : ${escapeHtml(base)}/v1
API Key  : 随便填 (如 123456)
Model    : ${escapeHtml(pre + sample)}</div>
    <div class="muted" style="margin-top:12px;">Claude Code 示例</div>
    <div class="code-box">export ANTHROPIC_BASE_URL=${escapeHtml(base)}
export ANTHROPIC_AUTH_TOKEN=123456
export ANTHROPIC_MODEL=${escapeHtml(pre + sample)}</div>
    <div class="row-between" style="margin-top:14px;">
      <span class="muted">可用模型（${models.length}）· 点一下复制</span>
    </div>
    <div style="margin-top:4px;">${models.map(m => `<span class="model-chip" onclick="copyText('${escapeHtml(pre + m.id)}')" title="${escapeHtml(m.name + (m.paid ? ' · 付费模型' : ''))}">${escapeHtml(m.id)}${m.paid ? ' <span class="tag tag-tier-pro" style="font-size:9px;padding:0 3px;">PAID</span>' : ''}</span>`).join('') || '<span class="muted">暂无</span>'}</div>`;
}

function copyBaseUrl() { copyText($('baseUrlDisplay').textContent); }

// ── 4. 对话 ─────────────────────────────────────────────
function welcomeHtml() {
  return `<div class="chat-bubble assistant">已连接 ${META[engine].name}（${META[engine].vendor}）。选个模型直接提问，可实时看到思考过程。</div>`;
}

async function loadChat() {
  await refreshEngineInfo();
  applyEngineChrome();
  const sel = $('chatModelSelect');
  const box = $('chatMessages');
  if (engine === 'ag' && !agReady()) {
    sel.innerHTML = '';
    box.innerHTML = agOffHtml();
    return;
  }
  box.innerHTML = chatState[engine].html || welcomeHtml();
  box.scrollTop = box.scrollHeight;
  const models = await loadModels(engine);
  if (!models.length) {
    sel.innerHTML = '<option value="">暂无可用模型</option>';
    if (engine === 'ais' && !chatState.ais.html) {
      box.innerHTML = '<div class="chat-bubble assistant">当前无可用模型，请先去「账号」页面添加并刷新账号，或在概览中确认 AIS 服务已启动。</div>';
    }
    return;
  }
  const saved = localStorage.getItem('wag2api_chat_model_' + engine);
  sel.innerHTML = models.map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name && m.name !== m.id ? `${m.name}` : m.id)}</option>`).join('');
  if (saved && models.some(m => m.id === saved)) sel.value = saved;
  sel.onchange = () => localStorage.setItem('wag2api_chat_model_' + engine, sel.value);
}

function clearChat() {
  if (currentAbort) { currentAbort.abort(); currentAbort = null; }
  chatState[engine] = { history: [], html: '' };
  $('chatMessages').innerHTML = welcomeHtml();
  resetSendBtn();
  showToast('已开始新对话');
}

function exportChat() {
  const h = chatState[engine].history;
  if (!h.length) { showToast('当前没有对话内容', 'warn'); return; }
  const md = h.map(m => `### ${m.role === 'user' ? '我' : '模型'}\n\n${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`).join('\n\n');
  showText('导出对话', `${META[engine].name} · ${$('chatModelSelect').value}`, md);
}

function resetSendBtn() {
  const b = $('sendBtn');
  b.textContent = '发送';
  b.style.background = '';
}

function renderBubble(el, thinking, content, final) {
  let html = '';
  if (thinking) html += `<div class="thinking-drawer"><div class="thinking-title">🧠 思考过程</div><div>${escapeHtml(thinking)}</div></div>`;
  html += content ? escapeHtml(content) : (final ? '' : '<span style="color: var(--text-dim);">输出中…</span>');
  el.innerHTML = html;
}

async function sendMessage() {
  if (currentAbort) { currentAbort.abort(); currentAbort = null; resetSendBtn(); return; }
  if (engine === 'ag' && !agReady()) { showToast('AG 引擎未运行', 'warn'); return; }
  const input = $('chatInput');
  const text = input.value.trim();
  const model = $('chatModelSelect').value;
  if (!text) return;
  if (!model) { showToast('没有可用模型', 'warn'); return; }
  input.value = '';

  const eng = engine;
  const st = chatState[eng];
  const box = $('chatMessages');
  const ub = document.createElement('div');
  ub.className = 'chat-bubble user';
  ub.textContent = text;
  box.appendChild(ub);
  const ab = document.createElement('div');
  ab.className = 'chat-bubble assistant';
  ab.innerHTML = '<span style="color: var(--text-dim);">思考中…</span>';
  box.appendChild(ab);
  box.scrollTop = box.scrollHeight;
  st.history.push({ role: 'user', content: text });

  currentAbort = new AbortController();
  const b = $('sendBtn');
  b.textContent = '⏹ 停止';
  b.style.background = '#ef4444';

  let content = '', thinking = '';
  try {
    const isAg = eng === 'ag';
    const res = await fetch(apiUrl(isAg ? '/v1/messages' : '/v1/chat/completions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': localStorage.getItem('wag2api_admin_key') || 'local' },
      signal: currentAbort.signal,
      body: JSON.stringify(isAg
        ? { model: 'ag:' + model, max_tokens: 8192, stream: true, messages: st.history }
        : { model: 'ais:' + model, stream: true, messages: st.history }),
    });
    if (!res.ok) {
      const rawText = await res.text();
      let errMsg = rawText.slice(0, 300);
      try {
        const errObj = JSON.parse(rawText);
        errMsg = errObj?.error?.message || errObj?.message || errMsg;
      } catch (_) {}
      throw new Error(`HTTP ${res.status}: ${errMsg}`);
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder('utf-8');
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let j;
        try { j = JSON.parse(payload); } catch (e) { continue; }
        if (j.error) { content += `\n[错误：${j.error.message || JSON.stringify(j.error)}]`; continue; }
        if (isAg) {
          if (j.type === 'content_block_delta' && j.delta) {
            if (j.delta.type === 'thinking_delta') thinking += j.delta.thinking || '';
            else if (j.delta.type === 'text_delta') content += j.delta.text || '';
          }
        } else if (j.choices && j.choices[0]) {
          const d = j.choices[0].delta || {};
          if (d.reasoning_content) thinking += d.reasoning_content;
          if (d.content) content += d.content;
        }
      }
      renderBubble(ab, thinking, content, false);
      box.scrollTop = box.scrollHeight;
    }
    renderBubble(ab, thinking, content || '（空回复）', true);
    st.history.push({ role: 'assistant', content });
  } catch (e) {
    if (e.name === 'AbortError') ab.innerHTML += '<span style="color: var(--text-dim); margin-left: 8px;">(已停止)</span>';
    else { ab.textContent = `发送失败：${e.message}`; st.history.pop(); }
  } finally {
    currentAbort = null;
    resetSendBtn();
    if (eng === engine) st.html = box.innerHTML;
  }
}

// ── 5. 日志 ─────────────────────────────────────────────
function setAisLogMode(mode) {
  aisLogMode = mode === 'system' ? 'system' : 'requests';
  if ($('tabAisLogReq')) $('tabAisLogReq').classList.toggle('active', aisLogMode === 'requests');
  if ($('tabAisLogSys')) $('tabAisLogSys').classList.toggle('active', aisLogMode === 'system');
  loadLogs();
}

async function viewAisRequestBody(id) {
  try {
    const b = await getJson(`/ais/api/requests/${encodeURIComponent(id)}/body`);
    const text = `=== Request (${b.request_size || 0} bytes) ===\n${b.request || '(空)'}\n\n=== Response (${b.response_size || 0} bytes) ===\n${b.response || '(空)'}`;
    showText(`请求报文：${id}`, b.time ? new Date(b.time).toLocaleString('zh-CN') : '', text);
  } catch (e) {
    showToast(`读取报文失败：${e.message}`, 'error');
  }
}

async function loadLogs() {
  await refreshEngineInfo();
  applyEngineChrome();
  const box = $('logList');
  if (engine === 'ag' && !agReady()) { $('logTitle').textContent = '请求日志'; box.innerHTML = `<div class="card">${agOffHtml()}</div>`; return; }
  try {
    if (engine === 'ais') {
      if (aisLogMode === 'system') {
        let raw;
        try {
          const text = await (await fetch(apiUrl('/ais/logs'), { cache: 'no-store', headers: authHeaders() })).text();
          try { raw = JSON.parse(text); } catch { raw = text; }
        } catch (err) { raw = []; }
        const lines = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.logs) ? raw.logs : (typeof raw === 'string' ? raw.split('\n').filter(Boolean) : []));
        $('logTitle').textContent = `运行日志 (${lines.length})`;
        if (!lines.length) {
          box.innerHTML = '<div class="empty">暂无 AIS 运行日志。启动 AIS 引擎或调用接口后会在此显示。</div>';
          return;
        }
        box.innerHTML = `
          <div class="card" style="padding:10px;">
            <pre class="mono" style="margin:0; font-size:11px; line-height:1.5; white-space:pre-wrap; word-break:break-all; max-height:600px; overflow-y:auto;">${escapeHtml(lines.slice(-200).map(l => typeof l === 'object' ? JSON.stringify(l) : String(l)).join('\n'))}</pre>
          </div>`;
        return;
      }

      // 默认 requests 模式：调 AIS 账本 /ais/api/usage/records
      const fromISO = new Date(Date.now() - 7 * 86400000).toISOString();
      const toISO = new Date().toISOString();
      const recRes = await getJson(`/ais/api/usage/records?from=${encodeURIComponent(fromISO)}&to=${encodeURIComponent(toISO)}&limit=100`).catch(() => ({ items: [] }));
      const items = recRes.items || [];
      $('logTitle').textContent = `请求日志 (${items.length})`;
      if (!items.length) {
        box.innerHTML = '<div class="empty">暂无 AIS 请求记录。调用 API 或在「对话」里发一条，就会出现在这里。</div>';
        return;
      }

      box.innerHTML = items.map(r => {
        const ok = r.status >= 200 && r.status < 300;
        const tm = r.time ? new Date(r.time).toLocaleTimeString('zh-CN', { hour12: false }) : '';
        const inTok = r.input_tokens || 0;
        const cacTok = r.cached_tokens || 0;
        const repTok = r.reply_tokens || 0;
        const rsnTok = r.reasoning_tokens || 0;
        const totTok = r.total_tokens || (inTok + cacTok + repTok + rsnTok);
        const hitRate = (inTok + cacTok) > 0 ? (cacTok / (inTok + cacTok)) : null;

        const tok = [
          `<span>入 <b>${fmtNum(inTok)}</b></span>`,
          cacTok ? `<span>缓存 <b>${fmtNum(cacTok)}</b></span>` : '',
          `<span>出 <b>${fmtNum(repTok)}</b></span>`,
          rsnTok ? `<span>思考 <b>${fmtNum(rsnTok)}</b></span>` : '',
          `<span>合计 <b>${fmtNum(totTok)}</b></span>`,
          hitRate !== null ? `<span>命中 <b>${fmtPct(hitRate)}</b></span>` : '',
        ].filter(Boolean).join('');

        const timingParts = [
          r.duration_ms ? fmtMs(r.duration_ms) : '',
          r.first_event_ms ? '首字 ' + fmtMs(r.first_event_ms) : '',
          fmtTps(repTok + rsnTok, r.duration_ms, r.first_event_ms),
        ].filter(x => x && x !== '--').join(' · ');

        const metaParts = [
          r.queue_ms ? `排队 ${fmtMs(r.queue_ms)}` : '',
          r.tool_calls ? `工具调用 ${r.tool_calls}` : '',
          (r.attempts && r.attempts.length) ? `重试 ${r.attempts.length} 次` : '',
        ].filter(Boolean).join(' · ');

        const accMatch = aisAccountsCache.find(a => a.id === r.account);
        const who = accMatch?.label || r.account || '';
        const attemptErr = (!r.error && Array.isArray(r.attempts))
          ? r.attempts.filter(a => a && a.error).map(a => a.error).join('；')
          : '';
        const noteErr = r.error || attemptErr;

        return `
          <div class="log-card">
            <div class="log-header-row">
              <div class="log-path-wrap">
                <span class="tag ${ok ? 'tag-online' : 'tag-offline'}">${escapeHtml(r.status || '-')}</span>
                <span class="tag tag-global">${escapeHtml(r.channel || r.protocol || 'ais')}</span>
                ${(r.state === 'canceled' || r.state === 'rate_limited') ? `<span class="tag tag-warn">${escapeHtml(r.state)}</span>` : ''}
                <span class="log-path-text">${escapeHtml('POST ' + (r.path || '/v1/chat/completions'))}</span>
              </div>
              <span class="log-time mono">${escapeHtml(tm)}</span>
            </div>
            <div class="log-detail-row">
              <span class="log-model-text">${escapeHtml(r.model || '-')}</span>
              <span class="log-metrics-text">${timingParts}</span>
            </div>
            <div class="log-tokens">${tok}</div>
            ${metaParts ? `<div class="muted mono" style="font-size:11px;">${escapeHtml(metaParts)}</div>` : ''}
            ${who ? `<div class="muted mono" style="font-size:11px;">${escapeHtml(who)}</div>` : ''}
            ${noteErr ? `<div class="log-note-box">⚠️ ${escapeHtml(noteErr)}</div>` : ''}
            ${r.has_body ? `
              <div style="display:flex; justify-content:flex-end; margin-top:6px;">
                <button class="btn btn-outline btn-sm" style="font-size:11px; padding:2px 8px;" data-id="${escapeHtml(r.id)}" onclick="viewAisRequestBody(this.dataset.id)">📄 查看报文</button>
              </div>
            ` : ''}
          </div>
        `;
      }).join('');
      return;
    }

    const raw = await getJson('/api/logs');
    const logs = (Array.isArray(raw) ? raw : raw.logs || []).map(l => ({
      status: l.status, path: 'POST /v1/messages', model: l.model, ms: l.latency_ms, ttft: l.ttft_ms,
      u: l.tokens || {}, hit: l.cache_hit_rate, time: l.timestamp ? new Date(l.timestamp) : null,
      stream: l.is_stream, note: l.error, who: l.email, timing: l.timing,
      dg: l.downgraded ? { to: l.model_used, reason: l.downgrade_reason } : null,
    }));
    $('logTitle').textContent = `请求日志 (${logs.length})`;
    if (!logs.length) { box.innerHTML = '<div class="empty">暂无请求记录。调用 API 或在「对话」里发一条，就会出现在这里。</div>'; return; }
    box.innerHTML = logs.map(l => {
      const ok = l.status >= 200 && l.status < 300;
      const tm = l.time ? l.time.toLocaleTimeString('zh-CN', { hour12: false }) : (l.timeText || '');
      const u = l.u || {};
      const tok = [
        u.input !== undefined ? `<span>入 <b>${fmtNum(u.input)}</b></span>` : '',
        u.cached ? `<span>缓存 <b>${fmtNum(u.cached)}</b></span>` : '',
        u.output !== undefined ? `<span>出 <b>${fmtNum(u.output)}</b></span>` : '',
        u.thoughts ? `<span>思考 <b>${fmtNum(u.thoughts)}</b></span>` : '',
        `<span>合计 <b>${fmtNum(u.total)}</b></span>`,
        l.hit !== null && l.hit !== undefined ? `<span>命中 <b>${fmtPct(l.hit)}</b></span>` : '',
      ].filter(Boolean).join('');
      return `
        <div class="log-card">
          <div class="log-header-row">
            <div class="log-path-wrap">
              <span class="tag ${ok ? 'tag-online' : 'tag-offline'}">${escapeHtml(l.status)}</span>
              ${l.stream ? '<span class="tag tag-global">流式</span>' : ''}
              ${l.dg ? `<span class="tag tag-offline" title="${escapeHtml(l.dg.reason || '')}">降级→${escapeHtml(l.dg.to || '?')}</span>` : ''}
              <span class="log-path-text">${escapeHtml(l.path)}</span>
            </div>
            <span class="log-time mono">${escapeHtml(tm)}</span>
          </div>
          <div class="log-detail-row">
            <span class="log-model-text">${escapeHtml(l.model || '')}</span>
            <span class="log-metrics-text">${[fmtMs(l.ms), l.ttft ? '首字 ' + fmtMs(l.ttft) : '', fmtTps((l.u || {}).output + ((l.u || {}).thoughts || 0), l.ms, l.ttft)].filter(x => x && x !== '--').join(' · ')}</span>
          </div>
          <div class="log-tokens">${tok}</div>
          ${l.timing ? `<div class="muted mono" style="font-size:11px;">${[
            ['token', l.timing.t_token], ['组包', l.timing.t_payload], ['握手', l.timing.conn_reused === false ? l.timing.t_tls : null], ['头', l.timing.t_headers],
            ['思考', l.timing.t_first_thought], ['正文', l.timing.t_first_text],
          ].filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${k} ${fmtSec(v)}`).join(' · ')}${l.timing.conn_reused === true ? ' · 复用连接' : l.timing.conn_reused === false ? ' · 新建连接' : ''}${l.timing.attempts > 1 ? ` · 尝试 ${l.timing.attempts}` : ''}${l.timing.host ? ` · ${escapeHtml(l.timing.host.split('.')[0])}` : ''}</div>` : ''}
          ${l.who ? `<div class="muted mono" style="font-size:11px;">${escapeHtml(l.who)}</div>` : ''}
          ${l.note ? `<div class="log-note-box">⚠️ ${escapeHtml(l.note)}</div>` : ''}
        </div>`;
    }).join('');
  } catch (e) {
    box.innerHTML = `<div class="empty" style="color:var(--danger)">加载失败：${escapeHtml(e.message)}</div>`;
  }
}

async function clearLogs() {
  if (!confirm(`清空 ${META[engine].name} 的日志？`)) return;
  if (engine === 'ais') {
    await Promise.all([
      postJson('/panel/api/logs/clear', {}).catch(() => {}),
      deleteReq('/ais/api/logs').catch(() => {}),
    ]);
  } else if (agReady()) {
    await postJson('/api/logs/clear');
  }
  showToast('日志已清空', 'success');
  loadLogs();
}

// ── 启动 ───────────────────────────────────────────────
(async function init() {
  await refreshEngineInfo();
  applyEngineChrome();
  loadOverview();
  // 自动刷新只在概览可见时进行
  setInterval(() => {
    if (currentTab === 'overview' && !document.hidden) loadOverview();
  }, 15000);
})();

// 控制台回到前台时预热 AG 上游连接 / token；仅在概览可见时刷新概览
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (typeof agReady === 'function' && !agReady()) return;
  postJson('/api/prewarm', { reason: 'foreground' }).catch(() => {});
  if (currentTab === 'overview') loadOverview();
});
