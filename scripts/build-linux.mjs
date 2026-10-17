// 构建 Linux 单文件版：把网页打包进程序，再用 Bun 编译成可执行文件（无需安装 Node）
// 用法：node scripts/build-linux.mjs [x64|arm64 ...]
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const build = path.join(root, 'build', 'src');
const dist = path.join(root, 'dist');
fs.rmSync(path.join(root, 'build'), { recursive: true, force: true });
fs.mkdirSync(build, { recursive: true });
fs.mkdirSync(dist, { recursive: true });
fs.cpSync(path.join(root, 'src'), build, { recursive: true });
const embedded = {
  dashboard: fs.readFileSync(path.join(root, 'src', 'dashboard.html'), 'utf-8'),
  token: fs.readFileSync(path.join(root, 'src', 'token-page.html'), 'utf-8'),
};
fs.writeFileSync(path.join(build, 'embedded.mjs'), 'export default ' + JSON.stringify(embedded) + ';\n');

const bun = process.env.BUN || 'bun';
const arches = process.argv.slice(2).length ? process.argv.slice(2) : ['x64', 'arm64'];
for (const a of arches) {
  const out = path.join(dist, `wag2api-linux-${a}`);
  execFileSync(bun, ['build', path.join(build, 'server.mjs'), '--compile', '--minify-whitespace', `--target=bun-linux-${a}`, '--outfile', out], { stdio: 'inherit' });
  console.log('✔', out);
}
