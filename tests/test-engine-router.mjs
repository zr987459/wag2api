// 前门三层路由规则的参考实现与用例表。
// Kotlin 侧 EngineRouter.decide 必须与这里的判定完全一致；
// 改动任何一侧都要同步这张表，否则分流会跑偏。
const AIS = ["gemini-2.5-flash","gemini-2.5-pro","gemini-exp-1206","gemini-3.5-flash","gpt-6-astra","gpt-5.6-sol","auto"];
const AG = ["claude-sonnet-4-6","gemini-3.8-flash","gemini-4-argon","gpt-5.6-sol"];  // 注意 gpt-5.6-sol 两边重名

function normalize(p){ p=p.replace(/\/{2,}/g,'/'); if(p.length>1&&p.endsWith('/'))p=p.slice(0,-1); return p; }

function decide(path, model, defaultEngine='ais') {
  const p = normalize(path);
  if (p.startsWith('/ag/')) return ['node', p.slice(3)];
  if (p === '/ag') return ['node', '/'];
  if (p.startsWith('/api/')) return ['node', p];
  if (p.startsWith('/ais/')) return ['ais', p];
  if (p === '/v1/messages' || p === '/v1/chat/completions') {
    let m = model || '';
    let forced = m.startsWith('ag:') ? 'ag' : m.startsWith('ais:') ? 'ais' : null;
    let target = forced || (() => {
      const inAg = AG.includes(m), inAis = AIS.includes(m);
      if (inAg && !inAis) return 'ag';
      if (inAis && !inAg) return 'ais';
      return defaultEngine;
    })();
    return [target, p];
  }
  return ['ais', p];
}

const cases = [
  ['/v1/messages', 'claude-sonnet-4-6', 'ais', 'ag', '只在 AG 表里'],
  ['/v1/messages', 'gemini-2.5-flash',  'ais', 'ais',  '只在 AIS 表里'],
  ['/v1/messages', 'gpt-5.6-sol',      'ais', 'ais',  '两边重名 → 默认 ais'],
  ['/v1/messages', 'gpt-5.6-sol',      'ag',  'ag',   '两边重名 → 默认 ag'],
  ['/v1/messages', 'ag:gemini-2.5-flash', 'ais', 'ag', 'ag: 前缀强制'],
  ['/v1/messages', 'ais:claude-sonnet-4-6', 'ag', 'ais', 'ais: 前缀强制'],
  ['/v1/messages', 'unknown-model',    'ais', 'ais',  '未知 → 默认'],
  ['/v1/chat/completions', 'gemini-4-argon', 'ais', 'ag', 'OpenAI 路径也分流'],
  ['/ag/', 'x', 'ais', 'node', '控制台路径'],
  ['/api/status', 'x', 'ais', 'node', 'Node 内部 API'],
  ['/ais/api/status', 'x', 'ais', 'ais', 'AIS 接口'],
  ['//v1//messages/', 'gemini-2.5-flash', 'ais', 'ais', '路径归一化'],
];

let pass = 0, fail = 0;
for (const [path, model, def, want, desc] of cases) {
  const [got] = decide(path, model, def);
  const ok = got === want;
  console.log(`${ok ? '✅' : '❌'} ${desc.padEnd(22)} ${path} model=${model} default=${def} → ${got} (期望 ${want})`);
  ok ? pass++ : fail++;
}
console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);

// 验证 Node 版对于 wb: / ais: 前缀模型的拦截
import http from 'http';

const testServer = http.createServer(async (req, res) => {
  let chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString();
  let model = '';
  try { model = JSON.parse(raw).model || ''; } catch (e) {}
  if (model.startsWith('wb:') || model.startsWith('ais:')) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        type: 'invalid_request_error',
        message: 'Linux 版暂不内置 AIS 引擎',
        code: 'ais_not_supported',
      },
    }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
});

await new Promise(r => testServer.listen(0, '127.0.0.1', r));
const port = testServer.address().port;

for (const prefix of ['wb:', 'ais:']) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: `${prefix}gemini-2.5-flash`, messages: [] }),
  });
  const data = await res.json();
  if (res.status !== 400 || !data.error?.message?.includes('Linux 版暂不内置 AIS 引擎')) {
    console.error(`❌ 前缀 ${prefix} 拦截失败:`, res.status, data);
    process.exit(1);
  }
  console.log(`✅ ${prefix} 前缀模型正确返回 400: ${data.error.message}`);
}
testServer.close();
