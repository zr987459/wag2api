// PR4：连接复用 / 取消即销毁 / 预热 / token 按到期时间刷新（本地 HTTPS 服务，不访问外网）
import assert from 'assert';
import https from 'https';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const { upstreamFetch, keepAliveAgent, RUNTIME } = await import('../src/upstream-fetch.mjs');
const { prewarm } = await import('../src/prewarm.mjs');
const { TokenManager } = await import('../src/token-manager.mjs');

let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log('  ✓', name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
console.log('test-upstream-fetch (' + RUNTIME + ')');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wag-tls-'));
let haveCert = true;
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
} catch { haveCert = false; }

if (RUNTIME === 'node' && haveCert) {
  let conns = 0;
  let streamClosed = false;
  const srv = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      if (req.url === '/echo') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ body, method: req.method })); return; }
      if (req.url === '/429') { res.writeHead(429); res.end('RESOURCE_EXHAUSTED'); return; }
      if (req.url === '/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        let i = 0;
        const iv = setInterval(() => { res.write(`data: ${i++}\n\n`); }, 20);
        res.on('close', () => { clearInterval(iv); streamClosed = true; });
        return;
      }
      res.writeHead(404); res.end('nf');
    });
  });
  srv.keepAliveTimeout = 60000;   // 测试服务端别先关空闲连接（Node 默认 5 秒）
  srv.on('secureConnection', () => conns++);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `https://127.0.0.1:${srv.address().port}`;

  await t('Response 形状与 fetch 一致：status/ok/json/text/clone', async () => {
    const r = await upstreamFetch(base + '/echo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.ok, true);
    const c = await r.clone().text();
    assert.deepStrictEqual(await r.json(), { body: '{"a":1}', method: 'POST' });
    assert.strictEqual(JSON.parse(c).body, '{"a":1}');
    assert.strictEqual(r._gwReused, false);
    assert.ok(r._gwTlsMs >= 0);
    const e = await upstreamFetch(base + '/429', { method: 'POST', body: '{}' });
    assert.strictEqual(e.ok, false); assert.strictEqual(e.status, 429);
    assert.strictEqual(await e.text(), 'RESOURCE_EXHAUSTED');
  });

  await t('连续请求复用同一条 TLS 连接，空闲超 4s 安全回收防僵尸连接', async () => {
    const before = conns;
    await sleep(1500); // 1.5s 连续对话：完美复用
    const r1 = await upstreamFetch(base + '/echo', { method: 'POST', body: 'x' });
    await r1.text();
    assert.strictEqual(r1._gwReused, true, '短间隔请求必须复用连接');
    assert.strictEqual(r1._gwTlsMs, 0);

    await sleep(4500); // 超过 4s 安全上限：自动销毁死连接，新建连接防僵尸阻塞
    const r2 = await upstreamFetch(base + '/echo', { method: 'POST', body: 'y' });
    await r2.text();
    assert.strictEqual(r2._gwReused, false, '超 4s 必须新建连接防 NAT 回收死锁');
  });

  await t('reader.cancel() 销毁底层请求，服务端感知断开', async () => {
    streamClosed = false;
    const r = await upstreamFetch(base + '/stream', { method: 'POST', body: '{}' });
    const reader = r.body.getReader();
    const { value } = await reader.read();
    assert.ok(new TextDecoder().decode(value).startsWith('data: 0'));
    await reader.cancel();
    for (let i = 0; i < 50 && !streamClosed; i++) await sleep(20);
    assert.strictEqual(streamClosed, true);
  });

  await t('fix/ttft：_gwUploadMs 记录请求体写出耗时（Node 下为数字，≤ 响应头耗时）', async () => {
    const big = 'x'.repeat(512 * 1024);
    const t0 = Date.now();
    const r = await upstreamFetch(base + '/echo', { method: 'POST', body: big });
    const headersMs = Date.now() - t0;
    assert.equal(typeof r._gwUploadMs, 'number');
    assert.ok(r._gwUploadMs >= 0 && r._gwUploadMs <= headersMs + 1, `upload ${r._gwUploadMs} headers ${headersMs}`);
    assert.equal((await r.json()).body.length, big.length);
  });

  await t('AbortSignal 中止', async () => {
    const ac = new AbortController();
    const p = upstreamFetch(base + '/stream', { method: 'POST', body: '{}', signal: ac.signal }).then(r => r.body.getReader().read());
    setTimeout(() => ac.abort(), 30);
    // 可能在响应前或响应后中止：两种都不能挂住
    await Promise.race([p.catch(() => 'aborted'), sleep(2000).then(() => { throw new Error('hang'); })]);
    const ac2 = new AbortController(); ac2.abort();
    await assert.rejects(upstreamFetch(base + '/echo', { signal: ac2.signal }), e => e.name === 'AbortError');
  });

  await t('网络错误抛 TypeError（与 fetch 一致）', async () => {
    await assert.rejects(upstreamFetch('https://127.0.0.1:1/x'), e => e instanceof TypeError);
  });

  keepAliveAgent.destroy();
  srv.close();
} else {
  console.log('  - 跳过 TLS 用例（' + (RUNTIME === 'bun' ? 'Bun 用原生 fetch' : '无 openssl') + '）');
}

await t('prewarm：刷新 token、解析 projectId、建连接，20 秒内去重', async () => {
  const calls = [];
  const mgr = { tokenData: { projectId: '' }, getValidAccessToken: async () => { calls.push('token'); return 'tok'; }, ensureProjectId: async function () { calls.push('project'); this.tokenData.projectId = 'p'; return 'p'; } };
  const pool = { getActiveManager: () => mgr };
  const fetchImpl = async (u) => { calls.push('conn:' + new URL(u).hostname); return { status: 404, text: async () => '', _gwReused: false, _gwTlsMs: 42 }; };
  const r = await prewarm(pool, { reason: 'start', force: true, fetchImpl });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.tls_ms, 42);
  assert.deepStrictEqual(calls, ['token', 'project', 'conn:daily-cloudcode-pa.sandbox.googleapis.com']);
  const r2 = await prewarm(pool, { reason: 'network', fetchImpl });
  assert.strictEqual(r2.skipped, true);
  assert.strictEqual(calls.length, 3);
});

await t('token 刷新按 expiresAt 前 10 分钟排期', () => {
  const tm = new TokenManager(null);
  tm.stopKeepAlive();
  const now = 1_000_000_000_000;
  tm.tokenData.expiresAt = now + 60 * 60 * 1000;
  assert.strictEqual(tm.nextRefreshDelay(now), 50 * 60 * 1000);
  tm.tokenData.expiresAt = now + 5 * 60 * 1000;   // 已进入 10 分钟窗口：最快 30 秒
  assert.strictEqual(tm.nextRefreshDelay(now), 30 * 1000);
  tm.tokenData.expiresAt = 0;
  assert.strictEqual(tm.nextRefreshDelay(now), 30 * 1000);
});

console.log(`  ${passed} passed`);
