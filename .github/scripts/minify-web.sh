#!/usr/bin/env bash
# [P4] 打包前压缩控制台静态资源（只改 CI 工作区里的副本，仓库里保留可读源码）。
#  - app.js / style.css：esbuild 压缩。普通 <script> 不打包时 esbuild 不会改顶层函数名，
#    index.html 和模板字符串里的 onclick="xxx()" 仍能找到对应函数；下面再用 acorn 逐个核对。
#  - index.html：去注释和行首缩进（没有 <pre>/<textarea>，空白不影响显示）。
set -euo pipefail
WEB=${1:-app/app/src/main/assets/web}
TMP=$(mktemp -d)
( cd "$TMP" && npm init -y >/dev/null && npm i --no-audit --no-fund esbuild@0.24.0 acorn@8.14.0 >/dev/null )
before=$(du -cb "$WEB"/app.js "$WEB"/style.css "$WEB"/index.html | tail -1 | cut -f1)
cp "$WEB/app.js" "$TMP/app.src.js"
"$TMP/node_modules/.bin/esbuild" "$WEB/app.js" --minify --target=es2019 --charset=utf8 --log-level=warning --outfile="$TMP/app.min.js"
"$TMP/node_modules/.bin/esbuild" "$WEB/style.css" --minify --charset=utf8 --log-level=warning --outfile="$TMP/style.min.css"
# 顶层函数/变量名必须一个不少
NODE_PATH="$TMP/node_modules" node -e '
const a=require("acorn"),fs=require("fs");
const top=f=>new Set(a.parse(fs.readFileSync(f,"utf8"),{ecmaVersion:"latest"}).body.flatMap(n=>n.type==="FunctionDeclaration"?[n.id.name]:n.type==="VariableDeclaration"?n.declarations.map(d=>d.id&&d.id.name).filter(Boolean):[]));
const x=top(process.argv[1]),y=top(process.argv[2]);const miss=[...x].filter(n=>!y.has(n));
if(miss.length){console.error("压缩后缺少顶层名:",miss.join(","));process.exit(1)}
console.log("顶层名核对通过:",x.size);' "$TMP/app.src.js" "$TMP/app.min.js"
node --check "$TMP/app.min.js"
cp "$TMP/app.min.js" "$WEB/app.js"
cp "$TMP/style.min.css" "$WEB/style.css"
node -e '
const fs=require("fs"),f=process.argv[1];
let h=fs.readFileSync(f,"utf8").replace(/<!--[\s\S]*?-->/g,"").split("\n").map(l=>l.trim()).filter(Boolean).join("\n");
fs.writeFileSync(f,h+"\n");' "$WEB/index.html"
after=$(du -cb "$WEB"/app.js "$WEB"/style.css "$WEB"/index.html | tail -1 | cut -f1)
echo "控制台静态资源：$before → $after 字节"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && echo "### 控制台静态资源：$before → $after 字节（app.js/style.css/index.html）" >> "$GITHUB_STEP_SUMMARY"
rm -rf "$TMP"
