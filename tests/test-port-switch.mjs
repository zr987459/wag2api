// 安卓「改监听端口热切换」的前端逻辑与 Kotlin 关键约束的静态检查。
// 真正的绑定/重启在 Kotlin 里，CI 的 APK 构建负责编译；这里守住约定不被改坏。
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = new URL('../', import.meta.url);
const read = p => fs.readFileSync(new URL(p, root), 'utf8');
const web = 'app/app/src/main/assets/web/';
const kt = 'app/app/src/main/java/com/wag2api/app/';
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ✓', name); };

const appJs = read(web + 'app.js');
const css = read(web + 'style.css');
const html = read(web + 'index.html');
const server = read(kt + 'LocalGatewayServer.kt');
const svc = read(kt + 'GatewayService.kt');
const main = read(kt + 'MainActivity.kt');

// 取出 app.js 里的纯函数在沙箱里跑
const fnSrc = appJs.match(/function urlWithPort\([\s\S]*?\n}\n/)[0];
const ctx = { URL };
vm.runInNewContext(fnSrc + ';this.urlWithPort = urlWithPort;', ctx);

t('urlWithPort 只换端口，保留路径/查询/hash', () => {
  assert.equal(ctx.urlWithPort('http://127.0.0.1:8800/', 9900), 'http://127.0.0.1:9900/');
  assert.equal(ctx.urlWithPort('http://127.0.0.1:8800/#accounts', 18800), 'http://127.0.0.1:18800/#accounts');
  assert.equal(ctx.urlWithPort('http://127.0.0.1:8800/panel/api/engine/state', 9001), 'http://127.0.0.1:9001/panel/api/engine/state');
});

t('前端：ok 后轮询新端口 engine/state 再跳转，失败读回退原因', () => {
  assert.match(appJs, /\/panel\/api\/engine\/state/);
  assert.match(appJs, /已切换到端口 \$\{np\}/);
  assert.match(appJs, /location\.replace\(urlWithPort\(location\.href, np\)\)/);
  assert.match(appJs, /switch_error/);
});

t('dual / standalone 模式不显示端口框，且 savePort 直接拒绝', () => {
  assert.match(html, /class="host-only"[^>]*>[\s\S]{0,200}id="portInput"/);
  assert.match(css, /body\.dual \.host-only[\s\S]{0,60}display: none !important/);
  assert.match(css, /body\.standalone \.host-only[\s\S]{0,30}display: none !important/);
  assert.match(appJs, /if \(isDual\(\) \|\| isStandalone\(\)\)[^\n]*PORT 环境变量/);
});

t('Kotlin：先检查可绑定再保存，先回响应再热切换', () => {
  const branch = server.slice(server.indexOf('path == "/panel/api/settings/port"'), server.indexOf('1.16 API'));
  const iBind = branch.indexOf('GatewayService.canBind(np)');
  const iSave = branch.indexOf('GatewayService.setPort(context, np)');
  const iResp = branch.indexOf('sendJsonResponse(output, 200, res.toString())');
  const iSwitch = branch.indexOf('GatewayService.switchFrontDoorPort(');
  assert.ok(iBind > 0 && iSave > iBind, 'canBind 必须在 setPort 之前');
  assert.ok(iResp > iSave && iSwitch > iResp, '响应必须在热切换之前发出');
  assert.match(branch, /put\("new_port", np\)/);
});

t('Kotlin：热切换先起新前门、成功再停旧的，失败回退旧端口，不碰 AG 引擎', () => {
  const body = svc.slice(svc.indexOf('private fun restartFrontDoor'), svc.indexOf('override fun onBind'));
  assert.ok(body.indexOf('next.startBlocking()') < body.indexOf('old?.stop()'));
  assert.match(body, /setPort\(applicationContext, oldPort\)/);
  assert.match(body, /updateNotification\(\)/);
  assert.doesNotMatch(body, /engine\.(stop|start|restart)\(/);
});

t('MainActivity：127.0.0.1 任意端口留在 WebView，启动按 getPort 加载', () => {
  assert.match(main, /uri\.host == "127\.0\.0\.1"/);
  assert.match(main, /GatewayService\.getPort\(applicationContext\)/);
  assert.match(main, /loadUrl\("http:\/\/127\.0\.0\.1:\$port\/"\)/);
});

console.log(`port-switch: ${n} passed`);
