// WorkBuddy Mobile 交互逻辑 - 同源直连 (http://127.0.0.1:8800)

let currentTab = 'overview';
let activePollTimer = null;
let currentAuthUrl = '';

function showToast(msg) {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.style.cssText = 'position: fixed; top: 20px; left: 50%; transform: translateX(-50%); z-index: 9999; pointer-events: none;';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s ease';
    setTimeout(() => el.remove(), 300);
  }, 2000);
}

function copyAuthUrl() {
  if (currentAuthUrl) {
    copyText(currentAuthUrl);
    const btn = document.getElementById('copyAuthUrlBtn');
    if (btn) {
      btn.textContent = '✅ 已复制';
      setTimeout(() => { btn.textContent = '📋 复制链接'; }, 2000);
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadOverview();
  setInterval(() => {
    if (document.visibilityState === 'visible' && currentTab === 'overview') {
      loadOverview();
    }
  }, 8000);
});

// Tab 切换
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));

  const view = document.getElementById(`view-${tab}`);
  if (view) view.classList.add('active');

  const nav = document.querySelector(`.nav-item[data-tab="${tab}"]`);
  if (nav) nav.classList.add('active');

  if (tab === 'overview') loadOverview();
  if (tab === 'accounts') loadAccounts();
  if (tab === 'keys') loadKeys();
  if (tab === 'logs') loadLogs();
}

// 1. 概览
async function loadOverview() {
  const statusPill = document.getElementById('headerStatus');
  const statusText = document.getElementById('headerStatusText');

  try {
    const res = await fetch('/panel/api/overview', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const isOnline = (data.healthy > 0 || data.total > 0);
    statusText.textContent = isOnline ? '网关在线' : '等待账号';
    statusPill.style.color = isOnline ? 'var(--primary)' : 'var(--warning)';
    statusPill.style.background = isOnline ? 'rgba(16, 185, 129, 0.15)' : 'rgba(245, 158, 11, 0.15)';

    document.getElementById('statAccounts').textContent = `${data.healthy || 0} / ${data.total || 0}`;

    // 优先采用服务端精确累计数据，无则回退账号用量统计
    let todayReq = data.today_requests !== undefined ? data.today_requests : 0;
    let todayTokens = data.today_tokens !== undefined ? data.today_tokens : 0;
    if (todayReq === 0 && todayTokens === 0) {
      (data.accounts || []).forEach(a => {
        const u = a.token_usage || {};
        todayReq += (u.request_count || 0);
        todayTokens += (u.total_tokens || 0);
      });
    }

    document.getElementById('statTodayReq').textContent = todayReq.toLocaleString();
    document.getElementById('statTodayTokens').textContent = todayTokens.toLocaleString();
    document.getElementById('statActiveKeys').textContent = data.healthy || 0;
    const infoCore = document.getElementById('infoCoreUrl');
    if (infoCore) infoCore.textContent = window.location.origin;
    await refreshEngineState();
    await loadPool();
    await loadPort();
    await loadGatewayState();
  } catch (e) {
    statusText.textContent = '连接中断';
    statusPill.style.color = 'var(--danger)';
    statusPill.style.background = 'rgba(239, 68, 68, 0.15)';
  }
}

// 2. 账号
async function loadAccounts() {
  const container = document.getElementById('accountList');
  try {
    const res = await fetch('/panel/api/overview', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const accounts = data.accounts || [];
    document.getElementById('accountCount').textContent = accounts.length;

    if (accounts.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 40px; color: var(--text-dim);">
          暂无账号，点击上方「+ 授权新账号」快速添加
        </div>`;
      return;
    }

    const pool = await loadPool();
    const poolMap = {};
    (pool && pool.accounts ? pool.accounts : []).forEach(x => { poolMap[x.uid] = x; });
    const selectedUid = (pool && pool.selected_uid) || '';

    container.innerHTML = accounts.map(a => {
      const initial = (a.nickname || 'U').charAt(0).toUpperCase();
      const p = poolMap[a.uid] || {};
      const cooling = !!p.cooling;
      const disabled = !!p.disabled || !!a.disabled;
      const isActive = selectedUid && selectedUid === a.uid;

      const isOnline = !disabled && !cooling;
      const statusClass = isOnline ? 'tag-online' : 'tag-offline';
      let statusText = '● 在线';
      if (disabled) statusText = '● 已禁用';
      else if (cooling) statusText = `● 冷却 ${p.cooldown_sec || 0}s`;

      const realmText = a.realm === 'global' ? '国际版' : '国内版';
      const tokensUsed = (a.token_usage && a.token_usage.total_tokens) ? a.token_usage.total_tokens.toLocaleString() : '0';
      const creditsDisplay = a.credits >= 0 ? `· 积分 ${a.credits}` : '';
      const activeTag = isActive ? '<span class="tag tag-online">当前</span>' : '';

      return `
        <div class="item-card">
          <div class="item-main">
            <div class="item-avatar">${initial}</div>
            <div class="item-info">
              <div class="item-title">
                <span>${escapeHtml(a.nickname)}</span>
                <span class="tag tag-global">${realmText}</span>
                <span class="tag ${statusClass}">${statusText}</span>
                ${activeTag}
              </div>
              <div class="item-sub">UID: ${escapeHtml(a.uid)} ${creditsDisplay} · 消耗: ${tokensUsed} tokens</div>
            </div>
          </div>
          <div style="display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end;">
            <button class="btn btn-outline btn-sm" onclick="testAccount('${escapeHtml(a.uid)}', this)">测试</button>
            <button class="btn btn-outline btn-sm" onclick="exportOne('${escapeHtml(a.uid)}')">导出</button>
            <button class="btn btn-outline btn-sm" onclick="selectAccount('${escapeHtml(a.uid)}').then(()=>{loadAccounts();loadPool();})">使用</button>
            <button class="btn btn-outline btn-sm" onclick="toggleAccount('${escapeHtml(a.uid)}', ${!disabled})">${disabled ? '启用' : '禁用'}</button>
            <button class="btn btn-outline btn-sm" style="color: var(--danger); border-color: rgba(239, 68, 68, 0.4);" onclick="deleteAccount('${escapeHtml(a.uid)}')">删除</button>
          </div>
        </div>`;
    }).join('');
  } catch (e) {
    container.innerHTML = `<div style="text-align: center; padding: 40px; color: var(--danger);">加载失败: ${e.message}</div>`;
  }
}

// 授权弹窗
function openAuthModal() {
  document.getElementById('authModal').classList.add('active');
  document.getElementById('authResultArea').style.display = 'none';
  document.getElementById('startAuthBtn').style.display = 'block';
  document.getElementById('startAuthBtn').disabled = false;
  document.getElementById('startAuthBtn').textContent = '获取授权链接';
  if (activePollTimer) {
    clearInterval(activePollTimer);
    activePollTimer = null;
  }
}

async function requestAuthLink() {
  const btn = document.getElementById('startAuthBtn');
  btn.disabled = true;
  btn.textContent = '正在向官方申请链接...';

  try {
    const res = await fetch('/panel/api/login/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ realm: 'global' })
    });
    const data = await res.json();
    if (data.ok && data.url) {
      currentAuthUrl = data.url;
      const urlInput = document.getElementById('authUrlInput');
      if (urlInput) urlInput.value = data.url;

      const linkBtn = document.getElementById('authLinkBtn');
      linkBtn.href = data.url;
      linkBtn.onclick = (e) => {
        window.open(data.url, '_blank');
      };
      document.getElementById('authResultArea').style.display = 'block';
      btn.style.display = 'none';

      // 启动自动轮询
      startAuthPolling(data.state);
    } else {
      alert('获取授权链接失败：' + (data.error || JSON.stringify(data)));
      btn.disabled = false;
      btn.textContent = '获取授权链接';
    }
  } catch (e) {
    alert('请求失败：' + e.message);
    btn.disabled = false;
    btn.textContent = '获取授权链接';
  }
}

function startAuthPolling(state) {
  if (activePollTimer) clearInterval(activePollTimer);
  const statusDiv = document.createElement('div');
  statusDiv.id = 'pollStatusText';
  statusDiv.style.cssText = 'font-size: 12px; color: var(--warning); margin-top: 8px; text-align: center; line-height: 1.6;';
  statusDiv.innerHTML = '⏳ 正在等待浏览器完成登录授权...<br><span style="color:var(--text-dim);font-size:11px;">完成后系统将自动检测并入库，无需刷新</span>';
  
  const oldText = document.getElementById('pollStatusText');
  if (oldText) oldText.remove();
  document.getElementById('authResultArea').appendChild(statusDiv);

  activePollTimer = setInterval(async () => {
    try {
      const res = await fetch('/panel/api/login/poll?state=' + encodeURIComponent(state));
      const data = await res.json();
      if (data.done) {
        clearInterval(activePollTimer);
        activePollTimer = null;
        statusDiv.style.color = 'var(--primary)';
        statusDiv.innerHTML = `🎉 <b>授权成功！</b><br>已添加账号 <b>${escapeHtml(data.nickname || data.uid)}</b>，已自动载入池中！`;
        setTimeout(() => {
          closeModal('authModal');
          loadAccounts();
          loadOverview();
        }, 1800);
      }
    } catch (ignored) {}
  }, 2500);
}

// 3. 接入配置
async function loadKeys() {
  const container = document.getElementById('keyList');
  const baseOrigin = window.location.origin;
  document.getElementById('baseUrlDisplay').textContent = `${baseOrigin}/v1`;

  container.innerHTML = `
    <div class="card" style="margin-bottom: 12px;">
      <div class="section-title">本地免鉴权模式已启用</div>
      <p style="font-size: 13px; color: var(--text-muted); line-height: 1.6;">
        App 运行在手机独立本地沙箱中，为保障第三方客户端极简接入，所有本地请求均免密放行。
      </p>
      <div style="font-size: 13px; color: var(--text-main); margin-top: 10px; font-family: var(--font-mono);">
        API 接口: <span style="color: var(--primary);">${baseOrigin}/v1/chat/completions</span><br>
        API Key: <span style="color: var(--accent);">任意填写（如 123456）</span>
      </div>
    </div>`;
}

function copyBaseUrl() {
  const base = window.location.origin.startsWith('http') ? window.location.origin : 'http://127.0.0.1:8800';
  copyText(`${base}/v1`);
}

// 4. 即时对话工作台 (直接调用本地引擎流式 SSE)
let chatHistory = [];
let currentAbortController = null;

function clearChat() {
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
  chatHistory = [];
  const messagesBox = document.getElementById('chatMessages');
  messagesBox.innerHTML = `
    <div class="chat-bubble assistant">
      ✨ 对话已重置，上下文已全部清空。请输入您想咨询的问题！
    </div>
  `;
  const sendBtn = document.getElementById('sendBtn');
  sendBtn.textContent = '发送';
  sendBtn.style.background = '';
  showToast('已重置为全新对话');
}

async function sendMessage() {
  const sendBtn = document.getElementById('sendBtn');

  // 若当前正在生成，点击按钮则立即掐断
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
    sendBtn.textContent = '发送';
    sendBtn.style.background = '';
    return;
  }

  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text) return;

  const model = document.getElementById('chatModelSelect').value;
  input.value = '';
  const messagesBox = document.getElementById('chatMessages');

  // 用户气泡
  const userBubble = document.createElement('div');
  userBubble.className = 'chat-bubble user';
  userBubble.textContent = text;
  messagesBox.appendChild(userBubble);

  chatHistory.push({ role: 'user', content: text });

  // Assistant 气泡占位
  const aiBubble = document.createElement('div');
  aiBubble.className = 'chat-bubble assistant';
  aiBubble.innerHTML = '<span style="color: var(--text-dim);">思考中...</span>';
  messagesBox.appendChild(aiBubble);
  messagesBox.scrollTop = messagesBox.scrollHeight;

  currentAbortController = new AbortController();
  sendBtn.textContent = '⏹ 停止';
  sendBtn.style.background = '#ef4444';

  let assistantContent = '';
  let thinkingContent = '';

  try {
    const response = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      signal: currentAbortController.signal,
      body: JSON.stringify({
        model: model,
        messages: chatHistory,
        stream: true
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    aiBubble.innerHTML = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // 保留不完整行

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (trimmed.startsWith('data: ')) {
          try {
            const parsed = JSON.parse(trimmed.slice(6));
            if (parsed.error) {
              assistantContent += `\n[错误: ${parsed.error.message || JSON.stringify(parsed.error)}]`;
            } else if (parsed.choices && parsed.choices[0]) {
              const delta = parsed.choices[0].delta || {};
              if (delta.reasoning_content) {
                thinkingContent += delta.reasoning_content;
              }
              if (delta.content) {
                assistantContent += delta.content;
              }
            }
          } catch (err) {}
        }
      }

      // 实时渲染思维链与正文
      let html = '';
      if (thinkingContent) {
        html += `<div class="thinking-block">💭 ${escapeHtml(thinkingContent)}</div>`;
      }
      html += escapeHtml(assistantContent) || '<span style="color: var(--text-dim);">输入中...</span>';
      aiBubble.innerHTML = html;
      messagesBox.scrollTop = messagesBox.scrollHeight;
    }

    chatHistory.push({ role: 'assistant', content: assistantContent });
  } catch (e) {
    if (e.name === 'AbortError') {
      aiBubble.innerHTML += '<span style="color: var(--text-dim); margin-left: 8px;">(已中止)</span>';
    } else {
      aiBubble.textContent = `发送失败: ${e.message}`;
    }
  } finally {
    currentAbortController = null;
    sendBtn.textContent = '发送';
    sendBtn.style.background = '';
  }
}

// 通用工具
function closeModal(id) {
  document.getElementById(id).classList.remove('active');
  if (activePollTimer) {
    clearInterval(activePollTimer);
    activePollTimer = null;
  }
}

function copyText(str) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(str).then(() => {
      showToast('已复制到剪贴板！');
    }).catch(() => {
      fallbackCopy(str);
    });
  } else {
    fallbackCopy(str);
  }
}

function fallbackCopy(str) {
  const ta = document.createElement('textarea');
  ta.value = str;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    showToast('已复制到剪贴板！');
  } catch (e) {
    prompt('请手动选择复制以下内容：', str);
  } finally {
    document.body.removeChild(ta);
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function deleteAccount(uid) {
  if (!confirm('确定从本地移除此账号凭据吗？')) return;
  try {
    const res = await fetch('/panel/api/accounts/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid })
    });
    const d = await res.json();
    if (d.ok) {
      showToast('已移除账号凭据');
      loadAccounts();
      loadOverview();
    } else {
      alert('删除失败');
    }
  } catch (e) {
    alert('请求失败: ' + e.message);
  }
}

// 导入导出模块
function openImportModal() {
  document.getElementById('importModal').classList.add('active');
  const input = document.getElementById('importInput');
  input.value = '';
  input.focus();
}

async function submitImport() {
  const input = document.getElementById('importInput');
  const raw = input.value.trim();
  if (!raw) return alert('请输入要导入的凭据文本');

  try {
    const res = await fetch('/panel/api/tokens/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw })
    });
    const data = await res.json();
    if (data.ok) {
      showToast(data.msg || '导入成功！');
      closeModal('importModal');
      loadAccounts();
      loadOverview();
    } else {
      alert('导入失败：' + (data.msg || JSON.stringify(data)));
    }
  } catch (e) {
    alert('请求失败: ' + e.message);
  }
}

async function openExportModal() {
  const modal = document.getElementById('exportModal');
  const output = document.getElementById('exportOutput');
  output.value = '正在提取当前所有账号凭据...';
  modal.classList.add('active');

  try {
    const res = await fetch('/panel/api/tokens/export', { cache: 'no-store' });
    const text = await res.text();
    output.value = text;
  } catch (e) {
    output.value = '提取失败: ' + e.message;
  }
}

function copyExportJson() {
  const output = document.getElementById('exportOutput');
  if (output && output.value) {
    copyText(output.value);
  }
}

// 5. 运行日志
async function loadLogs() {
  const container = document.getElementById('logList');
  try {
    const res = await fetch('/panel/api/logs', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const logs = data.logs || [];
    document.getElementById('logCount').textContent = logs.length;
    document.getElementById('logSummaryReq').textContent = (data.today_requests || 0).toLocaleString();
    document.getElementById('logSummaryTokens').textContent = (data.today_tokens || 0).toLocaleString();

    if (logs.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 40px; color: var(--text-dim);">
          暂无请求记录。调用 API 或在「对话」中测试后将在此实时展示流水。
        </div>`;
      return;
    }

    container.innerHTML = logs.map(l => {
      const isSuccess = l.status >= 200 && l.status < 300;
      const statusClass = isSuccess ? 'tag-online' : 'tag-offline';
      const statusTag = `<span class="tag ${statusClass}">${l.status}</span>`;
      const timeStr = escapeHtml(l.time || '');
      const method = escapeHtml(l.method || 'POST');
      const path = escapeHtml(l.path || '');
      const model = escapeHtml(l.model || '');
      const latency = l.latency_ms ? `${l.latency_ms}ms` : '';
      const tokensStr = l.tokens > 0 ? `${l.tokens.toLocaleString()} tok` : '';
      const noteStr = l.note ? `<div style="font-size: 11px; color: var(--danger); margin-top: 4px; font-family: var(--font-mono); word-break: break-all;">⚠️ ${escapeHtml(l.note)}</div>` : '';

      return `
        <div class="item-card" style="padding: 10px 14px; margin-bottom: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
            <div style="display: flex; align-items: center; gap: 6px;">
              ${statusTag}
              <span style="font-family: var(--font-mono); font-weight: 600; font-size: 13px; color: var(--text-main);">${method} ${path}</span>
            </div>
            <span style="font-size: 11px; color: var(--text-dim); font-family: var(--font-mono);">${timeStr}</span>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--text-muted);">
            <span style="font-family: var(--font-mono); color: var(--accent);">${model}</span>
            <span style="font-family: var(--font-mono); font-size: 11px;">${[latency, tokensStr].filter(Boolean).join(' · ')}</span>
          </div>
          ${noteStr}
        </div>`;
    }).join('');
  } catch (e) {
    container.innerHTML = `<div style="text-align: center; padding: 40px; color: var(--danger);">加载日志失败: ${escapeHtml(e.message)}</div>`;
  }
}

async function clearLogs() {
  if (!confirm('确定清空所有本地运行日志吗？')) return;
  try {
    await fetch('/panel/api/logs/clear', { method: 'POST' });
    showToast('日志已清空');
    loadLogs();
  } catch (e) {
    alert('清空失败: ' + e.message);
  }
}


// ── 双引擎管理 ───────────────────────────────────────────

async function refreshEngineState() {
  try {
    const res = await fetch('/panel/api/engine/state', { cache: 'no-store' });
    if (!res.ok) return;
    const d = await res.json();

    const wbEl = document.getElementById('engineWbState');
    if (wbEl) { wbEl.textContent = '● 就绪'; wbEl.className = 'engine-state on'; }

    const agEl = document.getElementById('engineAgState');
    if (agEl) {
      const st = d.state || 'OFF';
      const map = {
        READY:    ['● 就绪',      'on'],
        STARTING: ['● 启动中',    'warn'],
        FAILED:   ['● 异常',      'err'],
        DRAINING: ['● 停止中',    'warn'],
        STOPPING: ['● 停止中',    'warn'],
        OFF:      [d.supported ? '● 已关闭' : '● 不支持', ''],
      };
      const [text, cls] = map[st] || ['● 未知', ''];
      agEl.textContent = text;
      agEl.className = 'engine-state ' + cls;
    }

    const toggle = document.getElementById('nodeEnabledToggle');
    if (toggle && toggle.dataset.init !== '1') {
      toggle.checked = d.enabled !== false;
      toggle.dataset.init = '1';
    }
  } catch (e) { /* 静默 */ }
}

async function toggleNodeEngine(on) {
  try {
    await fetch('/panel/api/engine/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: on })
    });
    setTimeout(refreshEngineState, 800);
  } catch (e) {
    alert('切换失败：' + e.message);
  }
}

async function restartAgEngine() {
  if (!confirm('重启 AG 引擎？正在进行的请求会被中断。')) return;
  try {
    await fetch('/panel/api/engine/restart', { method: 'POST' });
    setTimeout(refreshEngineState, 1200);
  } catch (e) {
    alert('重启失败：' + e.message);
  }
}

function openAgConsole() {
  window.location.href = '/ag/';
}

// ── 账号池调度 ────────────────────────────────────────────

async function loadPool() {
  try {
    const res = await fetch('/panel/api/pool', { cache: 'no-store' });
    if (!res.ok) return;
    const d = await res.json();
    const sel = document.getElementById('activeAccountSelect');
    if (sel) {
      const cur = d.selected_uid || '';
      sel.innerHTML = '<option value="">自动轮询</option>';
      (d.accounts || []).forEach(a => {
        const opt = document.createElement('option');
        opt.value = a.uid;
        let label = a.nickname || a.uid.slice(0, 10);
        if (a.cooling) label += `（冷却 ${a.cooldown_sec}s）`;
        if (a.disabled) label += '（已禁用）';
        opt.textContent = label;
        sel.appendChild(opt);
      });
      sel.value = cur;
    }
    return d;
  } catch (e) { return null; }
}

async function selectAccount(uid) {
  try {
    await fetch('/panel/api/pool/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid })
    });
  } catch (e) { alert('切换失败：' + e.message); }
}

async function clearCooldowns() {
  try {
    await fetch('/panel/api/pool/clear-cooldown', { method: 'POST' });
    loadPool();
    alert('已清除所有账号冷却');
  } catch (e) { alert('操作失败：' + e.message); }
}

async function refreshTokens() {
  try {
    const r = await fetch('/panel/api/tokens/refresh', { method: 'POST' });
    const d = await r.json();
    alert(d.msg || '已在后台刷新 Token');
  } catch (e) { alert('刷新失败：' + e.message); }
}

async function toggleAccount(uid, disabled) {
  try {
    await fetch('/panel/api/pool/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid, disabled })
    });
    loadAccounts();
    loadPool();
  } catch (e) { alert('操作失败：' + e.message); }
}

// ── 端口设置 ──────────────────────────────────────────────

async function loadPort() {
  try {
    const res = await fetch('/panel/api/settings/port', { cache: 'no-store' });
    if (!res.ok) return;
    const d = await res.json();
    const el = document.getElementById('portInput');
    if (el) el.value = d.port || 8800;
  } catch (e) {}
}

async function savePort() {
  const el = document.getElementById('portInput');
  const port = parseInt(el.value, 10);
  if (!port || port < 1024 || port > 65535) {
    alert('端口需在 1024~65535 之间');
    return;
  }
  try {
    const r = await fetch('/panel/api/settings/port', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port })
    });
    const d = await r.json();
    alert(d.msg || (d.ok ? '已保存' : '保存失败'));
  } catch (e) { alert('保存失败：' + e.message); }
}


// ── 网关总开关 ────────────────────────────────────────────

async function loadGatewayState() {
  try {
    const res = await fetch('/panel/api/settings/gateway', { cache: 'no-store' });
    if (!res.ok) return;
    const d = await res.json();
    const t = document.getElementById('gatewayToggle');
    const txt = document.getElementById('gatewayStateText');
    if (t) { t.checked = d.enabled !== false; t.dataset.init = '1'; }
    if (txt) {
      txt.textContent = d.enabled ? '运行中 · 客户端可访问' : '已关闭 · 客户端将断开';
      txt.style.color = d.enabled ? 'var(--text-muted)' : 'var(--warning)';
    }
  } catch (e) {}
}

async function toggleGateway(on) {
  if (!on && !confirm('关闭网关后，所有客户端将无法访问，确定吗？')) {
    document.getElementById('gatewayToggle').checked = true;
    return;
  }
  try {
    const r = await fetch('/panel/api/settings/gateway', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: on })
    });
    const d = await r.json();
    if (!on) {
      alert('网关已关闭。如需重新打开，请回到本页面开启开关。');
    }
    setTimeout(loadGatewayState, 500);
  } catch (e) {
    alert('操作失败：' + e.message);
  }
}

// ── 单账号导出 ────────────────────────────────────────────

async function exportOne(uid) {
  try {
    const r = await fetch('/panel/api/accounts/export-one', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid })
    });
    const d = await r.json();
    if (!d.ok) { alert(d.msg || '导出失败'); return; }
    const text = JSON.stringify(d.account, null, 2);
    // 弹窗展示 + 复制
    showTextDialog('导出账号凭据', text);
  } catch (e) { alert('导出失败：' + e.message); }
}

function showTextDialog(title, text) {
  const old = document.getElementById('__dlg');
  if (old) old.remove();
  const wrap = document.createElement('div');
  wrap.id = '__dlg';
  wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
  const box = document.createElement('div');
  box.style.cssText = 'background:var(--card-bg,#161b26);border-radius:14px;padding:16px;width:100%;max-width:520px;max-height:80vh;display:flex;flex-direction:column;';
  const h = document.createElement('div');
  h.textContent = title;
  h.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:10px;color:var(--text-main,#fff);';
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.readOnly = true;
  ta.style.cssText = 'flex:1;min-height:200px;background:rgba(0,0,0,.4);color:#ddd;border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:10px;font-family:monospace;font-size:11px;resize:vertical;';
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;margin-top:12px;';
  const bCopy = document.createElement('button');
  bCopy.textContent = '复制';
  bCopy.className = 'btn btn-primary';
  bCopy.style.flex = '1';
  bCopy.onclick = () => { ta.select(); document.execCommand('copy'); bCopy.textContent = '已复制 ✓'; };
  const bClose = document.createElement('button');
  bClose.textContent = '关闭';
  bClose.className = 'btn btn-outline';
  bClose.style.flex = '1';
  bClose.onclick = () => wrap.remove();
  row.appendChild(bCopy); row.appendChild(bClose);
  box.appendChild(h); box.appendChild(ta); box.appendChild(row);
  wrap.appendChild(box);
  document.body.appendChild(wrap);
}

// ── 连通性测试 ────────────────────────────────────────────

async function testAccount(uid, btn) {
  const orig = btn ? btn.textContent : '';
  if (btn) { btn.textContent = '测试中…'; btn.disabled = true; }
  try {
    const r = await fetch('/panel/api/accounts/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid })
    });
    const d = await r.json();
    let msg;
    if (d.ok) {
      msg = `✅ 连通正常\n耗时 ${d.elapsed_ms}ms\n端点 ${d.endpoint || '-'}`;
    } else if (d.partial) {
      msg = `⚠️ 账号可用，但上游繁忙\n${d.msg}\n耗时 ${d.elapsed_ms}ms`;
    } else {
      msg = `❌ 测试失败\n${d.msg}\n耗时 ${d.elapsed_ms}ms`;
    }
    alert(msg);
  } catch (e) {
    alert('测试失败：' + e.message);
  } finally {
    if (btn) { btn.textContent = orig; btn.disabled = false; }
  }
}

async function testAllAccounts() {
  const pool = await loadPool();
  const list = (pool && pool.accounts ? pool.accounts : []).filter(a => !a.disabled);
  if (list.length === 0) { alert('没有可测试的账号'); return; }

  const lines = [];
  for (const a of list) {
    try {
      const r = await fetch('/panel/api/accounts/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: a.uid })
      });
      const d = await r.json();
      const mark = d.ok ? '✅' : (d.partial ? '⚠️' : '❌');
      const name = a.nickname || a.uid.slice(0, 8);
      lines.push(`${mark} ${name} · ${d.elapsed_ms}ms${d.ok ? '' : ' · ' + d.msg}`);
    } catch (e) {
      lines.push(`❌ ${a.nickname || a.uid} · ${e.message}`);
    }
  }
  alert('连通性测试结果\n\n' + lines.join('\n'));
  loadPool();
}
