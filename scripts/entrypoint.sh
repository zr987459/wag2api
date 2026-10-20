#!/usr/bin/env bash
# wag2api All-in-One entrypoint
#   默认：原生 wag2api 直接监听 $PORT（100% 向后兼容）
#   合体：ENABLE_NEW_API=1 且配置了 SQL_DSN 时，NewAPI 对外、wag2api 内网 3001
set -euo pipefail

APP_DIR=/app
export PORT="${PORT:-8790}"
NEWAPI_BIN="$APP_DIR/new-api"
WAG_DIR="${WAG_DIR:-$APP_DIR}"
WAG_PORT="${WAG_PORT:-3001}"
NEWAPI_MODE=0

# ---- 1. 判定是否启用 NewAPI 并强制持久化检查（Hark 审查项） ----
if [ "${ENABLE_NEW_API:-0}" = "1" ] || [ -n "${SQL_DSN:-}" ]; then
  if [ -z "${SQL_DSN:-}" ]; then
    echo "[entrypoint] ⚠️ WARN: 启用了 NewAPI 但未配置 SQL_DSN！" >&2
    echo "[entrypoint] ⚠️ Render 免费容器无持久化硬盘，使用临时 SQLite 会导致重启丢失全部用户与卡密！" >&2
    echo "[entrypoint] ⚠️ 为保障数据资产安全，自动回退纯 wag2api 模式。请在环境变量配置 SQL_DSN 后再启用。" >&2
    NEWAPI_MODE=0
  elif [ ! -x "$NEWAPI_BIN" ]; then
    echo "[entrypoint] ⚠️ WARN: $NEWAPI_BIN 不存在或不可执行，回退纯 wag2api 模式" >&2
    NEWAPI_MODE=0
  else
    NEWAPI_MODE=1
  fi
fi

cd "$WAG_DIR"

# ---- 2. 纯 wag2api 模式（向后兼容路径）----
if [ "$NEWAPI_MODE" = "0" ]; then
  echo "[entrypoint] 启动模式: wag2api-only | PORT=$PORT | HOST=${HOST:-0.0.0.0}"
  exec node "$WAG_DIR/src/server.mjs"
fi

# ---- 3. All-in-One 合体模式 ----
echo "[entrypoint] 启动模式: all-in-one | NewAPI(对外):0.0.0.0:$PORT | wag2api(内部算力):127.0.0.1:$WAG_PORT"

# 启动内部 wag2api 引擎（仅内网监听，供 NewAPI 自定义渠道调用）
PORT="$WAG_PORT" HOST=127.0.0.1 node "$WAG_DIR/src/server.mjs" &
WAG_PID=$!

# 启动对外 NewAPI
PORT="$PORT" GIN_MODE=release "$NEWAPI_BIN" --port "$PORT" &
NEWAPI_PID=$!

echo "[entrypoint] wag2api 进程 PID=$WAG_PID, NewAPI 进程 PID=$NEWAPI_PID"

IS_TERMINATING=0
term_handler() {
  echo "[entrypoint] 收到停机信号 (SIGTERM/SIGINT)，执行平滑退出..."
  IS_TERMINATING=1
  kill -TERM "$WAG_PID" "$NEWAPI_PID" 2>/dev/null || true
  wait "$WAG_PID" "$NEWAPI_PID" 2>/dev/null || true
  echo "[entrypoint] 两个进程均已安全退出，进程守护正常结束。"
  exit 0
}
trap term_handler SIGTERM SIGINT

# ---- 4. 守护：任一子进程非预期崩溃退出时快速退出自愈 ----
set +e
wait -n "$WAG_PID" "$NEWAPI_PID"
EXIT_STATUS=$?
set -e

if [ "$IS_TERMINATING" = "1" ]; then
  exit 0
fi

echo "[entrypoint] ⚠️ 检测到子进程异常退出 (退出码=$EXIT_STATUS)，立即终止容器以触发云端自愈重启！" >&2
kill -TERM "$WAG_PID" "$NEWAPI_PID" 2>/dev/null || true
wait 2>/dev/null || true
exit 1
