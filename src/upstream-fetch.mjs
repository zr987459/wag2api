/**
 * PR4：上游连接复用
 *
 *  - Bun：原生 fetch 自带连接池，直接用。
 *  - Node（含安卓 nodejs-mobile v18）：内置 fetch(undici) 的空闲连接 4 秒就关，两次对话之间几乎每次都要重新
 *    TCP+TLS 握手。这里改用 https.Agent({ keepAlive: true })，空闲连接一直留到服务端关闭。
 *
 * 返回标准 Response（status/ok/headers/text/json/clone/body 都和 fetch 一致），上层代码不用改。
 * 额外挂两个只读字段，供打点：
 *   resp._gwReused  本次是否复用了已有连接（Bun 下为 null，未知）
 *   resp._gwTlsMs   新建连接时 TCP+TLS 握手耗时（复用为 0，Bun 下为 null）
 *
 * 取消：body.getReader().cancel() 会 destroy 底层请求，不会留下半截连接继续收数据。
 * 复用到已被服务端关掉的空闲连接（ECONNRESET 且尚未收到响应）时自动重发一次，这是 Node 文档推荐做法。
 */
import https from 'https';

const IS_BUN = typeof globalThis.Bun !== 'undefined';
const NULL_BODY = new Set([101, 204, 205, 304]);

export const keepAliveAgent = IS_BUN ? null : new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,   // TCP keepalive 探测间隔，防 NAT/代理悄悄断开
  maxSockets: 16,
  maxFreeSockets: 4,
  scheduling: 'lifo',      // 优先用最近用过的连接，最热
});

function abortError(signal) {
  const r = signal && signal.reason;
  if (r instanceof Error) return r;
  const e = new Error('This operation was aborted');
  e.name = 'AbortError';
  return e;
}

function nodeRequestOnce(url, opts, allowRetry) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const signal = opts.signal;
    if (signal && signal.aborted) { reject(abortError(signal)); return; }
    const headers = { ...(opts.headers || {}) };
    const body = opts.body === undefined || opts.body === null ? null : (typeof opts.body === 'string' ? Buffer.from(opts.body) : Buffer.from(opts.body));
    if (body) headers['Content-Length'] = String(body.length);
    let settled = false;
    let tlsMs = 0;
    const req = https.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      method: opts.method || 'GET', headers, agent: keepAliveAgent,
    });
    const onAbort = () => req.destroy(abortError(signal));
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => { if (signal) signal.removeEventListener('abort', onAbort); };

    req.on('socket', (sock) => {
      if (req.reusedSocket) return;
      const t0 = Date.now();
      sock.once('secureConnect', () => { tlsMs = Date.now() - t0; });
    });

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      // 复用的空闲连接已被对端关闭：请求根本没送达，安全重发一次
      if (allowRetry && req.reusedSocket && (err.code === 'ECONNRESET' || err.code === 'EPIPE')) {
        nodeRequestOnce(url, opts, false).then(resolve, reject);
        return;
      }
      reject(err.name === 'AbortError' ? err : Object.assign(new TypeError('fetch failed: ' + err.message), { cause: err }));
    });

    req.on('response', (res) => {
      settled = true;
      let stream = null;
      if (!NULL_BODY.has(res.statusCode) && (opts.method || 'GET') !== 'HEAD') {
        stream = new ReadableStream({
          start(controller) {
            res.on('data', (chunk) => {
              controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
              if (controller.desiredSize !== null && controller.desiredSize <= 0) res.pause();
            });
            res.on('end', () => { cleanup(); try { controller.close(); } catch (e) {} });
            res.on('error', (e) => { cleanup(); try { controller.error(e); } catch (x) {} });
            res.on('aborted', () => { cleanup(); try { controller.error(new Error('upstream aborted')); } catch (x) {} });
          },
          pull() { res.resume(); },
          cancel() { cleanup(); req.destroy(); res.destroy(); },
        }, { highWaterMark: 16 });
      } else {
        res.resume();
        res.on('end', cleanup);
      }
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (Array.isArray(v)) v.forEach(x => h.append(k, x)); else if (v !== undefined) h.set(k, String(v));
      }
      const resp = new Response(stream, { status: res.statusCode, statusText: res.statusMessage || '', headers: h });
      Object.defineProperty(resp, '_gwReused', { value: Boolean(req.reusedSocket) });
      Object.defineProperty(resp, '_gwTlsMs', { value: req.reusedSocket ? 0 : tlsMs });
      resolve(resp);
    });

    if (body) req.write(body);
    req.end();
  });
}

/** 与 fetch(url, { method, headers, body, signal }) 同形 */
export function upstreamFetch(url, opts = {}) {
  if (IS_BUN) return fetch(url, opts);
  return nodeRequestOnce(url, opts, true);
}

export const RUNTIME = IS_BUN ? 'bun' : 'node';
