#!/usr/bin/env bash
# WebView 版 AIS 模拟器实测。只打印状态码、模型数量、回复前 50 个字；不打印 Cookie、请求头、SAPISIDHASH。
# 每个接口只请求 1 次（GitHub 机房 IP 可能被 Google 风控）。
set -u
OUT=emu-out
mkdir -p "$OUT"
RESULT="$OUT/result.txt"
: > "$RESULT"
say() { echo "$*"; echo "$*" >> "$RESULT"; }
PKG=com.wag2api.app.debug
BASE=http://127.0.0.1:18800
FAIL=0

redact() {
  # 去掉任何可能带 Cookie / 授权信息的行
  grep -viE 'cookie|sapisid|authorization|x-goog|__secure|psid|apisid|bearer' || true
}

finish() {
  curl -s -m 20 "$BASE/ais/api/logs" | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin); print("\n".join(d.get("logs",[])))
except Exception as e: print("logs unavailable:",e)' | redact > "$OUT/ais-logs.txt" 2>/dev/null || true
  curl -s -m 20 "$BASE/ais/api/webview" | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin)
  for a in d.get("accounts",[]):
    a.pop("email",None); a.pop("label",None); a["id"]="(hidden)"
  print(json.dumps(d,ensure_ascii=False,indent=1))
except Exception as e: print("{}")' > "$OUT/webview.json" 2>/dev/null || true
  adb logcat -d -v time 2>/dev/null | grep -E 'AIS-WV|AIS |chromium|cr_|WebView|AndroidRuntime|FATAL|wag2api' | redact | tail -n 1500 > "$OUT/logcat-filtered.txt" || true
  rm -f "$OUT"/.thr "$OUT"/.req.json "$OUT"/.resp.json "$OUT"/.resp.sse "$OUT"/.import.json "$OUT"/.import.out
  say "== 结束：$( [ $FAIL -eq 0 ] && echo 全部通过 || echo 有失败 )"
}
trap finish EXIT

if [ -z "${AIS_TEST_COOKIE:-}" ]; then
  say "::error::缺少 AIS_TEST_COOKIE"
  FAIL=1; exit 1
fi


# [P4] 内存/线程快照：只记 PSS、线程名统计、存活 WebView 数，不含任何账号信息
MEM="$OUT/meminfo.txt"
: > "$MEM"
pss_app() { adb shell dumpsys meminfo "$PKG" 2>/dev/null | tr -d '\r' | awk '/TOTAL PSS:/{print $3; exit} /^ *TOTAL /{print $2; exit}'; }
pss_renderer() { adb shell dumpsys meminfo 2>/dev/null | tr -d '\r' | awk '/Total PSS by process/{f=1;next} f&&/^$/{exit} f&&/sandboxed_process/{gsub(/[K,:]/,"",$1); s+=$1; n++} END{printf "%d %d\n", s+0, n+0}'; }
threads() { local pid; pid=$(adb shell pidof "$PKG" 2>/dev/null | tr -d '\r' | awk '{print $1}'); [ -n "$pid" ] || { echo "0"; return; }
  adb shell "cat /proc/$pid/task/*/comm" 2>/dev/null | tr -d '\r' | sed -E 's/[-_:]?[0-9]+$//' | sort | uniq -c | sort -rn > "$OUT/.thr"
  echo "$(awk '{s+=$1} END{print s+0}' "$OUT/.thr")"; }
live_wv() { curl -s -m 10 "$BASE/ais/api/webview" | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("live_webviews","?"))
except Exception: print("?")'; }
snap() {  # $1=标签
  local app r t w
  app=$(pss_app); r=$(pss_renderer); t=$(threads); w=$(live_wv)
  say "   [$1] App PSS $(( ${app:-0} / 1024 )) MB；WebView 渲染进程 ${r#* } 个共 $(( ${r%% *} / 1024 )) MB；线程 $t；存活 AIS WebView $w"
  { echo "== $1"; echo "app_pss_kb=${app:-0} renderer_pss_kb=${r%% *} renderer_procs=${r#* } threads=$t live_webviews=$w"; echo "-- 线程（名称去编号后计数）"; cat "$OUT/.thr" 2>/dev/null; } >> "$MEM"
}

APK=$(ls app/app/build/outputs/apk/debug/*.apk | head -1)
say "APK: $(basename "$APK") $(( $(stat -c %s "$APK") / 1024 )) KB"
adb install -r -g "$APK" >/dev/null 2>&1 || adb install -r "$APK"
say "WebView: $(adb shell dumpsys webviewupdate 2>/dev/null | grep -m1 -E 'Current WebView package' | tr -d '\r' | sed 's/^ *//')"

adb logcat -c
adb shell am start -n $PKG/com.wag2api.app.MainActivity >/dev/null
adb forward tcp:18800 tcp:8800 >/dev/null

ok=0
for i in $(seq 1 60); do
  c=$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$BASE/health" || true)
  if [ "$c" = "200" ]; then ok=1; break; fi
  sleep 2
done
say "前门 /health: $( [ $ok -eq 1 ] && echo 200 || echo 未就绪 )"
[ $ok -eq 1 ] || { FAIL=1; exit 1; }

# [P4] 控制台（压缩后的 app.js/style.css）能取到且无脚本错误
sleep 15
for f in / /app.js /style.css; do
  c=$(curl -s -o /dev/null -m 10 -w '%{http_code} %{size_download}' "$BASE$f")
  say "   控制台 $f: $c 字节"
  [ "${c%% *}" = "200" ] || FAIL=1
done
if adb logcat -d 2>/dev/null | grep -E 'Uncaught' | grep -q 'source: http://127.0.0.1'; then
  say "   ::error::控制台脚本报错："; adb logcat -d | grep -E 'Uncaught' | grep 'source: http://127.0.0.1' | head -5 | redact | tee -a "$RESULT"; FAIL=1
else
  say "   控制台脚本无报错"
fi
# 回桌面（控制台 Activity 退到后台），空闲 20 秒后记第一组数
adb shell input keyevent KEYCODE_HOME >/dev/null 2>&1 || true
sleep 20
say "内存 A：启动后空闲（未创建 AIS WebView）"
snap "A 空闲·未用 AIS"

# 1. 导入账号（Cookie 经 stdin 交给 python 写成请求体文件，不进命令行参数、不打印）
printf '%s' "$AIS_TEST_COOKIE" | python3 -c 'import json,sys
json.dump({"label":"ci-test","cookies":sys.stdin.read().strip(),"cdp":"","auth_user":0,"locale":"en-US","timezone":"UTC"}, sys.stdout)' > "$OUT/.import.json"
code=$(curl -s -m 30 -o "$OUT/.import.out" -w '%{http_code}' -X POST "$BASE/ais/api/accounts/import/cookies" -H 'content-type: application/json' --data-binary @"$OUT/.import.json")
rm -f "$OUT/.import.json"
say "1. 导入账号: HTTP $code"
if [ "$code" != "200" ]; then
  python3 -c 'import json,sys
try: print("   错误:", (json.load(open(sys.argv[1])).get("error") or {}).get("message","")[:200])
except Exception: print("   错误: 无法解析")' "$OUT/.import.out" | redact | tee -a "$RESULT"
  FAIL=1; exit 1
fi

# 1b. [beta] 控制台面板路径：账号「刷新/测试」（真机 v2.0.0-beta.1 在这里报 Must be called on the UI thread）
MP=$(curl -s -m 20 "$BASE/ais/api/webview" | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("multi_profile"))
except Exception: print("?")')
say "   WebView 多 Profile: $MP"
AID=$(curl -s -m 20 "$BASE/ais/api/accounts" | python3 -c 'import sys,json
try:
  a=json.load(sys.stdin).get("accounts",[]); print(a[0]["id"] if a else "")
except Exception: print("")')
if [ -z "$AID" ]; then say "1b. 面板账号列表为空"; FAIL=1; exit 1; fi
AIDQ=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$AID")
code=$(curl -s -m 300 -o "$OUT/.resp.json" -w '%{http_code}' -X POST "$BASE/ais/api/accounts/$AIDQ/refresh" -H 'content-type: application/json' --data-binary '{}')
RINFO=$(python3 -c 'import json,sys
try:
  d=json.load(open(sys.argv[1])); acc=d.get("account") or {}
  err=(d.get("error") or {}).get("message","") if isinstance(d.get("error"),dict) else str(d.get("error") or "")
  ui="UI thread" in json.dumps(d,ensure_ascii=False)
  print("models=%s state=%s ui_thread_error=%s %s" % (d.get("models",0), acc.get("state","?"), "yes" if ui else "no", ("错误: "+err[:150]) if err else ""))
except Exception: print("models=0 解析失败")' "$OUT/.resp.json" | redact)
say "1b. 面板 刷新/测试账号: HTTP $code，$RINFO"
case "$RINFO" in
  *"ui_thread_error=yes"*) FAIL=1 ;;
esac
RM=$(echo "$RINFO" | sed -n 's/^models=\([0-9]*\).*/\1/p')
if [ "$code" != "200" ] || [ -z "$RM" ] || [ "$RM" -le 0 ]; then FAIL=1; fi
# 再查一次账号卡片状态（控制台展示用）
STATE=$(curl -s -m 20 "$BASE/ais/api/accounts" | python3 -c 'import sys,json
try:
  a=json.load(sys.stdin).get("accounts",[])[0]; print(a.get("state","?"), "message=" + ("UI thread" if "UI thread" in str(a.get("message")) else ("有" if a.get("message") else "无")))
except Exception: print("?")')
say "   面板账号卡片: $STATE"
case "$STATE" in *"UI thread"*) FAIL=1 ;; esac

# 2. 模型列表（第一次会创建 WebView 并完成 WAA 初始化，给足时间）
code=$(curl -s -m 300 -o "$OUT/.resp.json" -w '%{http_code}' "$BASE/ais/v1/models")
read -r N MODEL < <(python3 -c 'import json,sys
try: ids=[m["id"] for m in json.load(open(sys.argv[1])).get("data",[])]
except Exception: ids=[]
bad=("image","tts","live","audio","embed","veo","imagen","robotics","native","lyria","learnlm")
c=[i for i in ids if "flash" in i and not any(b in i for b in bad)] or [i for i in ids if not any(b in i for b in bad)]
print(len(ids), c[0] if c else "-")' "$OUT/.resp.json")
say "2. /ais/v1/models: HTTP $code，模型 $N 个"
if [ "$code" != "200" ] || [ "$MODEL" = "-" ]; then
  python3 -c 'import json,sys
try: print("   错误:", (json.load(open(sys.argv[1])).get("error") or {}).get("message","")[:200])
except Exception: pass' "$OUT/.resp.json" | redact | tee -a "$RESULT"
  say "   没有可用模型，停止（见 ais-logs.txt / webview.json）"; FAIL=1; exit 1
fi
code2=$(curl -s -m 30 -o "$OUT/.resp.json" -w '%{http_code}' "$BASE/v1/models")
N2=$(python3 -c 'import json,sys
try: print(len(json.load(open(sys.argv[1])).get("data",[])))
except Exception: print(0)' "$OUT/.resp.json")
say "   前门 /v1/models: HTTP $code2，合计 $N2 个；测试模型 ais:$MODEL"

PROMPT='用一句话回答：天空为什么是蓝色的？'
body() { python3 -c 'import json,sys
m,stream,prompt=sys.argv[1],sys.argv[2]=="1",sys.argv[3]
print(json.dumps({"model":"ais:"+m,"messages":[{"role":"user","content":prompt}],"max_tokens":1024,"stream":stream},ensure_ascii=False))' "$MODEL" "$1" "$PROMPT"; }

# 3. 非流式 chat.completions
body 0 > "$OUT/.req.json"
code=$(curl -s -m 300 -o "$OUT/.resp.json" -w '%{http_code}' -X POST "$BASE/v1/chat/completions" -H 'content-type: application/json' --data-binary @"$OUT/.req.json")
TXT=$(python3 -c 'import json,sys
try:
  d=json.load(open(sys.argv[1]))
  if "choices" in d: print((d["choices"][0]["message"].get("content") or "")[:50].replace("\n"," "))
  else: print("错误: "+str((d.get("error") or {}).get("message",""))[:150])
except Exception as e: print("解析失败")' "$OUT/.resp.json" | redact)
say "3. 非流式 /v1/chat/completions: HTTP $code，回复: $TXT"
[ "$code" = "200" ] || FAIL=1

# 4. 流式 chat.completions
body 1 > "$OUT/.req.json"
code=$(curl -s -N -m 300 -o "$OUT/.resp.sse" -w '%{http_code}' -X POST "$BASE/v1/chat/completions" -H 'content-type: application/json' --data-binary @"$OUT/.req.json")
TXT=$(python3 -c 'import json,sys
n=0; t=""; err=""
for line in open(sys.argv[1],encoding="utf-8",errors="replace"):
  line=line.strip()
  if not line.startswith("data:"): continue
  p=line[5:].strip()
  if p=="[DONE]": continue
  try: d=json.loads(p)
  except Exception: continue
  n+=1
  e=d.get("error")
  if e: err=str(e.get("message","") if isinstance(e,dict) else e)[:150]
  for c in d.get("choices",[]):
    t+=(c.get("delta") or {}).get("content") or ""
s="%d 块，回复: %s" % (n, t[:50].replace("\n"," "))
if err: s+="，错误: "+err
print(s)' "$OUT/.resp.sse" | redact)
say "4. 流式 /v1/chat/completions: HTTP $code，$TXT"
[ "$code" = "200" ] || FAIL=1

# 5. Anthropic /v1/messages（非流式）
body 0 > "$OUT/.req.json"
code=$(curl -s -m 300 -o "$OUT/.resp.json" -w '%{http_code}' -X POST "$BASE/v1/messages" -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' --data-binary @"$OUT/.req.json")
TXT=$(python3 -c 'import json,sys
try:
  d=json.load(open(sys.argv[1]))
  if d.get("type")=="message": print("".join(b.get("text","") for b in d.get("content",[]) if b.get("type")=="text")[:50].replace("\n"," "))
  else: print("错误: "+str((d.get("error") or {}).get("message",""))[:150])
except Exception: print("解析失败")' "$OUT/.resp.json" | redact)
say "5. /v1/messages: HTTP $code，回复: $TXT"
[ "$code" = "200" ] || FAIL=1


# [P4] 内存：请求后（WebView 存活）→ 空闲超过 10 分钟（WebView 应被回收）
sleep 5
say "内存 B：AIS 请求刚结束（账号 WebView 存活）"
snap "B 请求后"
say "等待空闲回收（IDLE 10 分钟 + 回收器 60 秒周期，最多等 13 分钟）…"
for i in $(seq 1 26); do
  sleep 30
  w=$(live_wv)
  [ "$w" = "0" ] && break
done
sleep 30
say "内存 C：空闲 $(( i * 30 / 60 + 1 )) 分钟左右"
snap "C 空闲回收后"
[ "$(live_wv)" = "0" ] || { say "   ::error::空闲后 AIS WebView 未回收"; FAIL=1; }
# 安装体积（debug 包，未经 R8，仅供参考）
apkdir=$(adb shell pm path "$PKG" 2>/dev/null | tr -d '\r' | head -1 | cut -d: -f2 | xargs dirname 2>/dev/null)
code_kb=$(adb shell su 0 du -sk "$apkdir" 2>/dev/null | tr -d '\r' | awk '{print $1}')
data_kb=$(adb shell su 0 du -sk /data/data/$PKG 2>/dev/null | tr -d '\r' | awk '{print $1}')
say "安装体积（debug 包）：代码 ${code_kb:-?} KB，数据 ${data_kb:-?} KB"
echo "install_code_kb=${code_kb:-?} install_data_kb=${data_kb:-?}" >> "$MEM"

[ $FAIL -eq 0 ]
