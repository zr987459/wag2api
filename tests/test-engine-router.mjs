// 前门三层路由规则的参考实现与用例表。
// Kotlin 侧 EngineRouter.decide 必须与这里的判定完全一致；
// 改动任何一侧都要同步这张表，否则分流会跑偏。
const WB = ["deepseek-v4.1-flash-1017","hy4-preview","claude-4.0-sonnet","gemini-3.5-flash","gpt-6-astra","gpt-5.6-sol","auto"];
const AG = ["claude-sonnet-4-6","gemini-3.8-flash","gemini-4-argon","gpt-5.6-sol"];  // 注意 gpt-5.6-sol 两边重名

function normalize(p){ p=p.replace(/\/{2,}/g,'/'); if(p.length>1&&p.endsWith('/'))p=p.slice(0,-1); return p; }

function decide(path, model, defaultEngine='wb') {
  const p = normalize(path);
  if (p.startsWith('/ag/')) return ['node', p.slice(3)];
  if (p === '/ag') return ['node', '/'];
  if (p.startsWith('/api/')) return ['node', p];
  if (p === '/v1/messages' || p === '/v1/chat/completions') {
    let m = model || '';
    let forced = m.startsWith('ag:') ? 'ag' : m.startsWith('wb:') ? 'wb' : null;
    let target = forced || (() => {
      const inAg = AG.includes(m), inWb = WB.includes(m);
      if (inAg && !inWb) return 'ag';
      if (inWb && !inAg) return 'wb';
      return defaultEngine;
    })();
    return [target, p];
  }
  return ['wb', p];
}

const cases = [
  ['/v1/messages', 'claude-sonnet-4-6', 'wb', 'ag', '只在 AG 表里'],
  ['/v1/messages', 'claude-4.0-sonnet', 'wb', 'wb',   '只在 WB 表里'],
  ['/v1/messages', 'gpt-5.6-sol',      'wb', 'wb',   '两边重名 → 默认 wb'],
  ['/v1/messages', 'gpt-5.6-sol',      'ag', 'ag',   '两边重名 → 默认 ag'],
  ['/v1/messages', 'ag:claude-4.0-sonnet', 'wb', 'ag', 'ag: 前缀强制'],
  ['/v1/messages', 'wb:claude-sonnet-4-6', 'ag', 'wb', 'wb: 前缀强制'],
  ['/v1/messages', 'unknown-model',    'wb', 'wb',   '未知 → 默认'],
  ['/v1/chat/completions', 'gemini-4-argon', 'wb', 'ag', 'OpenAI 路径也分流'],
  ['/ag/', 'x', 'wb', 'node', '控制台路径'],
  ['/api/status', 'x', 'wb', 'node', 'Node 内部 API'],
  ['/panel/api/overview', 'x', 'wb', 'wb', 'WB 面板'],
  ['//v1//messages/', 'hy4-preview', 'wb', 'wb', '路径归一化'],
];

let pass = 0, fail = 0;
for (const [path, model, def, want, desc] of cases) {
  const [got] = decide(path, model, def);
  const ok = got === want;
  console.log(`${ok ? '✅' : '❌'} ${desc.padEnd(22)} ${path} model=${model} default=${def} → ${got} (期望 ${want})`);
  ok ? pass++ : fail++;
}
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
