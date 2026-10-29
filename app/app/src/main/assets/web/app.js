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
let currentAisPairing = null;
let aisDiscoveredAccounts = [];
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
function fmtMs(ms) { return ms === null || ms === undefined || ms === 0 ? '--' : ms >= 10000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms'; }

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

async function getJson(url, opts, retried) {
  const finalUrl = apiUrl(url);
  const res = await fetch(finalUrl, { cache: 'no-store', ...opts, headers: authHeaders(opts && opts.headers) });
  if (res.status === 401 && !retried && (url.startsWith('/api/') || url.startsWith('/panel/api/') || url.startsWith('/ais/api/'))) {
    const k = prompt('此网关设置了管理密钥（ADMIN_KEY），请输入：', '');
    if (k) { localStorage.setItem('wag2api_admin_key', k.trim()); return getJson(url, opts, true); }
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* 非 JSON */ }
  if (!res.ok && !(data && typeof data === 'object')) throw new Error(`HTTP ${res.status}`);
  // AIS 的错误以 JSON {error:{message}} 返回，必须当失败处理，不能误报成功
  if (!res.ok && url.startsWith('/ais/')) {
    const err = data && data.error;
    const msg = (err && (err.message || err.code)) || (typeof err === 'string' ? err : '') || (data && data.message) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

function postJson(url, body) {
  return getJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
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
  if (id === 'authModal' && activePollTimer) { clearInterval(activePollTimer); activePollTimer = null; }
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
      const models = modelsRes.models || [];
      const accounts = accountsRes.accounts || [];

      const to = new Date().toISOString();
      const from = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const usage = await getJson(`/ais/api/usage?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`).catch(() => null);
      const totals = usage?.totals || {};

      const readyAccs = accounts.filter(a => a.state === 'ready' || a.enabled).length;
      $('ovAccounts').textContent = `${readyAccs} / ${accounts.length}`;
      $('ovReq').textContent = fmtNum(totals.requests || 0);
      $('ovTokens').textContent = fmtNum(totals.total_tokens || 0);
      evEl.textContent = status.state || (isRunning ? '● RUNNING' : '● STOPPED');
      evEl.style.color = isRunning ? 'var(--primary)' : 'var(--warning)';
      setHeader(isRunning, isRunning ? 'AIS 运行中' : 'AIS 已停止');

      renderAisOverview(status, models, accounts, totals, usage);
    } catch (e) {
      setHeader(false, 'AIS 未响应');
      evEl.textContent = '● 异常';
      evEl.style.color = 'var(--danger)';
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

function renderAisOverview(status, models, accounts, totals, usage) {
  const box = $('overviewStatsContainer');
  if (!box) return;
  const isRunning = status.state === 'RUNNING' || status.running;
  const costStr = usage && usage.cost !== undefined ? `$${Number(usage.cost).toFixed(4)}` : '--';
  box.innerHTML = `
    <div class="card">
      <div class="row-between">
        <div>
          <div style="font-size: 14px; font-weight: 600;">AIS 引擎服务</div>
          <div class="muted">状态：<span class="tag ${isRunning ? 'tag-online' : 'tag-offline'}">${escapeHtml(status.state || (isRunning ? 'RUNNING' : 'STOPPED'))}</span> · 可用模型：<b>${models.length}</b> 个 · 活跃请求：<b>${status.active_requests || 0}</b></div>
        </div>
        <button class="btn btn-sm ${isRunning ? 'btn-outline' : 'btn-primary'}" onclick="${isRunning ? 'stopAisService()' : 'startAisService()'}">
          ${isRunning ? '⏹ 停止服务' : '▶ 启动服务'}
        </button>
      </div>
    </div>

    <div class="card">
      <div class="section-title"><span>近 24 小时用量摘要</span></div>
      <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px; margin-top:8px;">
        <div class="kv"><span class="k">成功请求</span><span class="v" style="color:var(--primary); font-weight:600;">${fmtNum(totals.succeeded || 0)}</span></div>
        <div class="kv"><span class="k">失败 / 限流</span><span class="v" style="color:var(--danger); font-weight:600;">${fmtNum((totals.failed || 0) + (totals.rate_limited || 0))}</span></div>
        <div class="kv"><span class="k">输入 Token</span><span class="v mono">${fmtNum(totals.input_tokens || 0)}</span></div>
        <div class="kv"><span class="k">输出 Token</span><span class="v mono">${fmtNum(totals.output_tokens || totals.reply_tokens || 0)}</span></div>
        <div class="kv"><span class="k">缓存 Token</span><span class="v mono">${fmtNum(totals.cached_tokens || 0)}</span></div>
        <div class="kv"><span class="k">预估费用</span><span class="v mono">${costStr}</span></div>
      </div>
      ${usage && usage.recent ? `<div class="muted" style="margin-top:10px; font-size:12px;">最近 ${usage.recent.minutes} 分钟内：${usage.recent.requests} 次请求 · ${fmtNum(usage.recent.tokens)} Tokens</div>` : ''}
    </div>
  `;
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
    await fetch(apiUrl('/ais/api/logs'), { method: 'DELETE', headers: authHeaders() }).catch(() => {});
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

function setTokenStatsRange(r) {
  tokenStatsRange = r;
  localStorage.setItem('wag2api_token_stats_range', r);
  tokenStatsTrendIndex = null;
  loadAgTokenStats(false);
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
        <button class="btn btn-outline btn-sm" onclick="loadAgTokenStats(true)">🔄 刷新</button>
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

async function loadAisAccounts() {
  const box = $('accountList');
  const sch = $('schedulerCard');
  if (sch) sch.style.display = 'none';
  try {
    const res = await getJson('/ais/api/accounts');
    if (engine !== 'ais') return;
    const accounts = res.accounts || [];
    $('accountCount').textContent = accounts.length;

    if (!accounts.length) {
      box.innerHTML = '<div class="empty">暂无 AIS 账号，点击右上角「+ 添加」或「导入」</div>';
      return;
    }

    const stateLabels = {
      ready: { text: '● 正常', cls: 'tag-online' },
      disabled: { text: '● 已停用', cls: 'tag-offline' },
      auth_required: { text: '● 需认证', cls: 'tag-offline' },
      cooldown: { text: '● 冷却中', cls: 'tag-warn' },
      busy: { text: '● 忙碌', cls: 'tag-warn' },
      unavailable: { text: '● 不可用', cls: 'tag-offline' },
    };

    box.innerHTML = accounts.map(a => {
      const id = escapeHtml(a.id);
      const stInfo = stateLabels[a.state] || { text: `● ${escapeHtml(a.state || '未知')}`, cls: a.enabled ? 'tag-online' : 'tag-offline' };
      const lastRef = aisRefreshTimes[a.id] ? new Date(aisRefreshTimes[a.id]).toLocaleTimeString('zh-CN', { hour12: false }) : '未手动刷新';
      const modelsCount = (a.models && a.models.length) || 0;
      return `
        <div class="account-card">
          <div class="account-card-header">
            <div class="item-avatar">${escapeHtml((a.id || 'A').charAt(0).toUpperCase())}</div>
            <div class="account-card-info">
              <div class="account-title-row">
                <span class="account-name" style="word-break:break-all;">${id}</span>
                <span class="tag ${stInfo.cls}">${stInfo.text}</span>
                <span class="tag tag-global">${escapeHtml(a.benefit_tier || 'Free')}</span>
              </div>
              <div class="account-meta mono">模型数: ${modelsCount} · 上次刷新: ${lastRef}</div>
            </div>
          </div>
          ${a.message ? `<div class="log-note-box" style="margin-top:8px;">⚠️ ${escapeHtml(a.message)}</div>` : ''}
          <div class="account-actions-wrap" style="margin-top:10px;">
            <div class="account-actions-row">
              <button class="btn btn-outline btn-sm" onclick="aisRefreshAccount('${id}')">🔄 刷新</button>
              <button class="btn btn-outline btn-sm" onclick="aisToggleAccount('${id}', ${!a.enabled})">${a.enabled ? '⏸ 停用' : '▶ 启用'}</button>
              <button class="btn btn-outline btn-sm" style="color:var(--danger); border-color:rgba(239,68,68,0.4);" onclick="aisDeleteAccount('${id}')">🗑 删除</button>
            </div>
          </div>
        </div>`;
    }).join('');
  } catch (e) {
    box.innerHTML = `<div class="empty" style="color:var(--danger)">加载失败：${escapeHtml(e.message)}</div>`;
  }
}

async function aisRefreshAccount(id) {
  showToast(`正在刷新 ${id}…`);
  try {
    const res = await postJson(`/ais/api/accounts/${encodeURIComponent(id)}/refresh`, {});
    aisRefreshTimes[id] = Date.now();
    showToast(`刷新成功 · 模型数: ${res.models ?? (res.account && res.account.models && res.account.models.length) ?? 0}`, 'success');
    loadAccounts();
  } catch (e) {
    showToast(`刷新失败: ${e.message}`, 'error');
  }
}

async function aisToggleAccount(id, enabled) {
  try {
    await fetch(apiUrl(`/ais/api/accounts/${encodeURIComponent(id)}`), {
      method: 'PUT',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    showToast(enabled ? '账号已启用' : '账号已停用', 'success');
    loadAccounts();
  } catch (e) {
    showToast(`操作失败: ${e.message}`, 'error');
  }
}

async function aisDeleteAccount(id) {
  if (!confirm(`确定删除账号 ${id} 吗？`)) return;
  try {
    await fetch(apiUrl(`/ais/api/accounts/${encodeURIComponent(id)}`), {
      method: 'DELETE',
      headers: authHeaders(),
    });
    delete aisRefreshTimes[id];
    showToast('已删除账号', 'success');
    loadAccounts();
  } catch (e) {
    showToast(`删除失败: ${e.message}`, 'error');
  }
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
  let latText = '--';
  if (lat !== null && lat !== undefined && Number(lat) > 0) {
    const num = Number(lat);
    latText = num >= 1000 ? (num / 1000).toFixed(1) + 's' : Math.round(num) + 'ms';
  }
  const failStreak = Number(p.fail_streak) || 0;
  return `
${failStreak >= 3 ? `<div class="account-perf-row mono"><span class="fail-streak-warn">连续失败 ${failStreak} 次</span></div>` : ''}
  `;
}

function renderAccountTestBanner(res) {
  if (!res) return '';
  if (res.ok) {
    const lat = res.latency_ms !== null && res.latency_ms !== undefined ? res.latency_ms + 'ms' : '--';
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
      showToast(`可用 · ${res.latency_ms ?? 0}ms`, 'success');
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
              <button class="btn btn-outline btn-sm" onclick="agExportOne('${em}')">📤 导出</button>
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
  if (t === 'PRO') return '<span class="tag tag-tier-pro">PRO</span>';
  if (t === 'FREE') return '<span class="tag tag-tier-free">FREE</span>';
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

async function agSelect(email) {
  await postJson('/api/accounts/select', { email });
  showToast(email ? `已锁定账号 ${email}` : '已切换为全自动智能轮询', 'success');
  loadAgAccounts();
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
async function agExportOne(email) {
  const d = await getJson('/api/accounts/export?email=' + encodeURIComponent(email));
  showText('导出账号', '含 Refresh Token，可在任意 wag2api 的 AG 引擎导入。请妥善保管。', JSON.stringify(d, null, 2));
}
async function agTestActive(btn) {
  const orig = btn.textContent;
  btn.textContent = '测试中…'; btn.disabled = true;
  testBanner('ag-test-banner', '', '正在请求 Google…');
  try {
    const d = await postJson('/api/gemini/test', {});
    const lines = (d.models || []).map(m => `${m.ok ? '✅' : '❌'} ${m.name} · ${m.message || ''}`);
    testBanner('ag-test-banner', d.all_ok ? 'success' : d.ok ? 'warning' : 'error',
      `${d.validation_account || ''}\n${lines.join('\n') || d.message || ''}`);
    $('ag-test-banner').style.whiteSpace = 'pre-line';
  } catch (e) { testBanner('ag-test-banner', 'error', `❌ ${e.message}`); }
  finally { btn.textContent = orig; btn.disabled = false; }
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
    ? '粘贴 AI Studio Cookie 或使用命令行远程添加配对。'
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

function switchAisAuthTab(tab) {
  const isCookie = tab === 'cookie';
  $('tabAisCookieBtn').className = 'btn btn-sm btn-outline' + (isCookie ? ' active' : '');
  $('tabAisPairingBtn').className = 'btn btn-sm btn-outline' + (!isCookie ? ' active' : '');
  $('aisAuthCookiePane').style.display = isCookie ? 'block' : 'none';
  $('aisAuthPairingPane').style.display = !isCookie ? 'block' : 'none';
  if (!isCookie) loadAisPairingToken();
}

async function handleAisDiscover() {
  const cookies = $('aisCookieInput').value.trim();
  if (!cookies) { showToast('请先粘贴 Cookie', 'warn'); return; }
  showToast('正在识别账号…');
  try {
    const res = await postJson('/ais/api/accounts/import/cookies/discover', { cookies });
    const accs = res.accounts || [];
    aisDiscoveredAccounts = accs;
    const list = $('aisDiscoverList');
    if (!accs.length) {
      list.innerHTML = '<div class="muted" style="font-size:12px;">未识别到有效 Google 账号</div>';
    } else {
      list.innerHTML = accs.map(a => `
        <div style="font-size:12px; margin-top:4px; display:flex; justify-content:space-between; align-items:center;">
          <span class="mono">${escapeHtml(a.email || '序号 ' + a.auth_user)}</span>
          <span class="tag ${a.imported ? 'tag-warn' : (a.signed_out ? 'tag-offline' : 'tag-online')}">${a.imported ? '已导入' : (a.signed_out ? '已登出' : '可用')}</span>
        </div>
      `).join('');
    }
    $('aisDiscoverArea').style.display = 'block';
  } catch (e) {
    showToast('识别失败: ' + e.message, 'error');
  }
}

async function handleAisCookieImport() {
  const cookies = $('aisCookieInput').value.trim();
  if (!cookies) { showToast('请先粘贴 Cookie', 'warn'); return; }
  showToast('正在导入…');
  try {
    const unimported = (aisDiscoveredAccounts || []).filter(a => !a.imported);
    if (unimported.length > 1) {
      let count = 0;
      for (const a of unimported) {
        await postJson('/ais/api/accounts/import/cookies', { cookies, auth_user: a.auth_user, label: a.email });
        count++;
      }
      showToast(`已导入 ${count} 个账号`, 'success');
    } else {
      const first = unimported[0];
      const payload = first ? { cookies, auth_user: first.auth_user, label: first.email } : { cookies };
      await postJson('/ais/api/accounts/import/cookies', payload);
      showToast('导入成功', 'success');
    }
    // 首次有账号时生成服务不会自动起来，导入后主动启动一次
    try { await postJson('/ais/api/control/start', {}); } catch (e) { showToast('账号已导入，但启动服务失败: ' + e.message, 'warn'); }
    $('aisCookieInput').value = '';
    $('aisDiscoverArea').style.display = 'none';
    aisDiscoveredAccounts = [];
    closeModal('authModal');
    loadAccounts();
  } catch (e) {
    showToast('导入失败: ' + e.message, 'error');
  }
}

let currentPairingToken = null;
async function loadAisPairingToken() {
  const tokenEl = $('aisPairingTokenText');
  const expEl = $('aisPairingExpires');
  const cmdEl = $('aisPairingCmdText');
  tokenEl.textContent = '获取中…';
  expEl.textContent = '';
  try {
    const res = await postJson('/ais/api/pairing', {});
    currentPairingToken = res.token || '';
    tokenEl.textContent = currentPairingToken || '--';
    if (res.expires_at) {
      const d = new Date(res.expires_at);
      expEl.textContent = '有效期至 ' + d.toLocaleTimeString('zh-CN', { hour12: false });
    }
    const origin = window.location.origin.startsWith('http') ? window.location.origin : 'http://127.0.0.1:8800';
    cmdEl.textContent = `aistudio2api setup --remote ${origin}`;
  } catch (e) {
    tokenEl.textContent = '获取失败';
    expEl.textContent = e.message;
  }
}

function copyAisPairingToken() {
  if (currentPairingToken) copyText(currentPairingToken);
  else showToast('暂无配对令牌', 'warn');
}

function copyAisPairingCmd() {
  const cmd = $('aisPairingCmdText').textContent;
  copyText(cmd);
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
  if (engine === 'ag' && !agReady()) { showToast('请先启用 AG 引擎', 'warn'); return; }
  $('importTitle').textContent = engine === 'ais' ? '导入 AIS 账号' : '导入 AG 账号';
  $('importDesc').textContent = engine === 'ais'
    ? '粘贴 Cookie（支持 Cookie-Editor JSON / Cookie 请求头 / cookies.txt）。'
    : '粘贴 Refresh Token（1// 开头，一行一个），或导出的账号 JSON。备份也可以直接粘贴。';
  $('importInput').value = '';
  $('importInput').placeholder = engine === 'ais' ? '粘贴 Cookie 文本或 JSON…' : '1//0e... 或 { "accounts": [...] }';
  openModal('importModal');
}

async function importAis(raw) {
  try {
    const d = await postJson('/ais/api/accounts/import/cookies', { cookies: raw });
    const id = (d.account && d.account.id) || '';
    try { await postJson('/ais/api/control/start', {}); } catch (e) { /* 服务可能已在运行 */ }
    return { ok: true, msg: id ? `导入成功：${id}` : '导入成功' };
  } catch (e) {
    return { ok: false, msg: e.message || '导入失败' };
  }
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
    if (parsed && parsed.format === 'wag2api-backup') {
      if (parsed.ag && (parsed.ag.accounts || []).length) {
        if (agReady()) { const r = await importAg(JSON.stringify(parsed.ag)); anyOk = anyOk || r.ok; msgs.push('AG：' + r.msg); }
        else msgs.push('AG：引擎未运行，已跳过');
      }
      if (parsed.note) msgs.push(parsed.note);
    } else {
      const r = engine === 'ais' ? await importAis(raw) : await importAg(raw);
      anyOk = r.ok; msgs.push(r.msg);
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
      showToast('AIS 账号不支持导出，请妥善保存 Cookie', 'info');
      return;
    }
    if (!agReady()) { showToast('请先启用 AG 引擎', 'warn'); return; }
    const d = await getJson('/api/accounts/export');
    showText('导出 AG 账号', '全部 Google 账号的 Refresh Token，可在 AG 引擎「导入」里恢复。请妥善保管。', JSON.stringify(d, null, 2));
  } catch (e) { showToast('导出失败：' + e.message, 'error'); }
}

async function openBackupModal() {
  const out = { format: 'wag2api-backup', version: 2, exported_at: new Date().toISOString(), ag: null, note: 'AIS 账号不支持导出，请使用 Cookie 重新导入' };
  if (agReady()) { try { out.ag = await getJson('/api/accounts/export'); } catch (e) { /* 空 */ } }
  const n = ((out.ag && out.ag.accounts) || []).length;
  showText('账号备份', `已备份 AG 账号共 ${n} 个（AIS 账号请使用 Cookie 重新导入）。可在 AG 引擎「导入」里粘贴恢复。`, JSON.stringify(out, null, 2));
}

// ── 3. 接入 ─────────────────────────────────────────────
async function loadModels(e) {
  if (modelCache[e]) return modelCache[e];
  try {
    const d = await getJson(e === 'ais' ? '/panel/api/models/ais' : '/api/models');
    const list = d.data || d.models || [];
    modelCache[e] = list.map(m => ({ id: m.id, name: m.name || m.display_name || m.id }));
  } catch (err) { return []; }
  return modelCache[e];
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
  const eps = `${base}/v1/chat/completions（OpenAI 兼容）\n${base}/v1/messages（Anthropic 原生）`;
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
    <div style="margin-top:4px;">${models.map(m => `<span class="model-chip" onclick="copyText('${escapeHtml(pre + m.id)}')" title="${escapeHtml(m.name)}">${escapeHtml(m.id)}</span>`).join('') || '<span class="muted">暂无</span>'}</div>`;
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
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

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
async function loadLogs() {
  await refreshEngineInfo();
  applyEngineChrome();
  const box = $('logList');
  if (engine === 'ag' && !agReady()) { $('logTitle').textContent = '请求日志'; box.innerHTML = `<div class="card">${agOffHtml()}</div>`; return; }
  try {
    if (engine === 'ais') {
      let raw;
      try {
        const text = await (await fetch(apiUrl('/ais/logs'), { cache: 'no-store', headers: authHeaders() })).text();
        try { raw = JSON.parse(text); } catch { raw = text; }
      } catch (err) { raw = []; }
      const lines = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.logs) ? raw.logs : (typeof raw === 'string' ? raw.split('\n').filter(Boolean) : []));
      $('logTitle').textContent = `运行日志 (${lines.length})`;
      if (!lines.length) {
        box.innerHTML = '<div class="empty">暂无 AIS 日志。启动 AIS 引擎或调用接口后会在此显示。</div>';
        return;
      }
      box.innerHTML = `
        <div class="card" style="padding:10px;">
          <pre class="mono" style="margin:0; font-size:11px; line-height:1.5; white-space:pre-wrap; word-break:break-all; max-height:600px; overflow-y:auto;">${escapeHtml(lines.slice(-200).map(l => typeof l === 'object' ? JSON.stringify(l) : String(l)).join('\n'))}</pre>
        </div>`;
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
              <span class="log-path-text">${escapeHtml(l.path)}</span>
              ${l.stream ? '<span class="tag tag-global">流式</span>' : ''}
              ${l.dg ? `<span class="tag tag-offline" title="${escapeHtml(l.dg.reason || '')}">降级→${escapeHtml(l.dg.to || '?')}</span>` : ''}
            </div>
            <span class="mono" style="font-size: 11px; color: var(--text-dim);">${escapeHtml(tm)}</span>
          </div>
          <div class="log-detail-row">
            <span class="log-model-text">${escapeHtml(l.model || '')}</span>
            <span class="log-metrics-text">${[fmtMs(l.ms), l.ttft ? '首字 ' + fmtMs(l.ttft) : ''].filter(x => x && x !== '--').join(' · ')}</span>
          </div>
          <div class="log-tokens">${tok}</div>
          ${l.timing ? `<div class="muted mono" style="font-size:11px;">${[
            ['token', l.timing.t_token], ['组包', l.timing.t_payload], ['握手', l.timing.conn_reused === false ? l.timing.t_tls : null], ['头', l.timing.t_headers],
            ['思考', l.timing.t_first_thought], ['正文', l.timing.t_first_text],
          ].filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `${k} ${v}ms`).join(' · ')}${l.timing.conn_reused === true ? ' · 复用连接' : l.timing.conn_reused === false ? ' · 新建连接' : ''}${l.timing.attempts > 1 ? ` · 尝试 ${l.timing.attempts}` : ''}${l.timing.host ? ` · ${escapeHtml(l.timing.host.split('.')[0])}` : ''}</div>` : ''}
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
  if (engine === 'ais') await postJson('/panel/api/logs/clear');
  else if (agReady()) await postJson('/api/logs/clear');
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
