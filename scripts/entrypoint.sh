#!/usr/bin/env bash
# wag2api All-in-One entrypoint
#   默认：原生 wag2api 直接监听 $PORT（100% 向后兼容）
#   合体：ENABLE_NEW_API=1 或检测到 SQL_DSN 时，NewAPI 对外、wag2api 内网 3001
set -euo pipefail

APP_DIR=/app
PORT="${PORT:-3000}"
NEWAPI_BIN="$APP_DIR/new-api"
WAG_DIR="${WAG_DIR:-$APP_DIR}"
NEWAPI_MODE=0

# ---- 1. 判定是否启用 NewAPI ----
if [ "${ENABLE_NEW_API:-0}" = "1" ] || [ -n "${SQL_DSN:-}" ]; then
  if [ -x "$NEWAPI_BIN" ]; then
    NEWAPI_MODE=1
  else
    echo "[entrypoint] WARN: ENABLE_NEW_API 已开启但 $NEWAPI_BIN 不存在/不可执行，回退纯 wag2api 模式" >&2
  fi
fi

cd "$WAG_DIR"

# ---- 2. 纯 wag2api 模式（向后兼容路径）----
if [ "$NEWAPI_MODE" = "0" ]; then
  echo "[entrypoint] mode=wag2api-only  PORT=$PORT  HOST=${HOST:-0.0.0.0}"
  exec node "$WAG_DIR/src/server.mjs"
fi

# ---- 3. All-in-One 合体模式 ----
echo "[entrypoint] mode=all-in-one  new-api:0.0.0.0:$PORT  wag2api:127.0.0.1:3001"

# wag2api 仅内网监听 3001，NewAPI 作为对外入口
PORT=3001 HOST=127.0.0.1 node "$WAG_DIR/src/server.mjs" &
WAG_PID=$!

# new-api 对外监听 $PORT（Render 注入）；GIN_MODE 关闭调试噪声
PORT="$PORT" GIN_MODE=release "$NEWAPI_BIN" --port "$PORT" &
NEWAPI_PID=$!

echo "[entrypoint] wag2api pid=$WAG_PID  new-api pid=$NEWAPI_PID"

# 收到 SIGTERM/SIGINT 时转发给两个子进程，等待其优雅退出
term() {
  echo "[entrypoint] received signal, shutting down..."
  kill -TERM "$WAG_PID" "$NEWAPI_PID" 2>/dev/null || true
}
trap term SIGTERM SIGINT

# ---- 4. 内存与进程守护：任一子进程退出 → 整体快速退出（触发容器自愈）----
set +e
wait -n "$WAG_PID" "$NEWAPI_PID"
EXIT_CODE=$?
set -e

echo "[entrypoint] a child process exited (code=$EXIT_CODE), terminating container" >&2
kill -TERM "$WAG_PID" "$NEWAPI_PID" 2>/dev/null || true
wait 2>/dev/null || true
exit 1
