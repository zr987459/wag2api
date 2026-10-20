#!/usr/bin/env bash
# wag2api All-in-One entrypoint
#   默认模式：原生 wag2api 直接监听 $PORT（100% 向后兼容，无堆限制）
#   合体模式：必须显式 ENABLE_NEW_API=1 且配置 SQL_DSN 时，前置 Nginx 监听 $PORT 对外：
#            - /wag/ 专属管理暗门（剥离前缀） -> wag2api (127.0.0.1:3001) 供主人管理加号
#            - 其余全部 -> NewAPI (127.0.0.1:3002) 供群友注册、充值卡密、生成 sk- 独享 Key
set -euo pipefail

APP_DIR=/app
export PORT="${PORT:-8790}"
NEWAPI_BIN="$APP_DIR/new-api"
WAG_DIR="${WAG_DIR:-$APP_DIR}"
WAG_PORT="${WAG_PORT:-3001}"
NEWAPI_PORT="3002"
NEWAPI_MODE=0

# ---- 1. 判定是否启用 NewAPI（显式开关 + 强制要求 SQL_DSN 与 ADMIN_KEY）----
if [ "${ENABLE_NEW_API:-0}" = "1" ]; then
  if [ -z "${SQL_DSN:-}" ]; then
    echo "[entrypoint] ⚠️ WARN: 开启了 ENABLE_NEW_API=1 但未配置 SQL_DSN！" >&2
    echo "[entrypoint] ⚠️ Render 等容器无持久化硬盘，使用临时 SQLite 会导致重启丢失全部用户与卡密！" >&2
    echo "[entrypoint] ⚠️ 为保障数据资产安全，自动回退纯 wag2api 模式。请配置 SQL_DSN 后再启用。" >&2
    NEWAPI_MODE=0
  elif [ -z "${ADMIN_KEY:-}" ]; then
    echo "[entrypoint] ⚠️ ERROR: 启用 All-in-One 模式必须设置 ADMIN_KEY 以保护 /wag/ 管理面板！" >&2
    echo "[entrypoint] ⚠️ 严禁管理面板在公网无密钥裸奔（防凭据泄漏）。请在环境变量配置 ADMIN_KEY。" >&2
    exit 1
  elif [ ! -x "$NEWAPI_BIN" ]; then
    echo "[entrypoint] ⚠️ WARN: $NEWAPI_BIN 不存在或不可执行，回退纯 wag2api 模式" >&2
    NEWAPI_MODE=0
  else
    NEWAPI_MODE=1
  fi
fi

cd "$WAG_DIR"

# ---- 2. 纯 wag2api 模式（向后兼容路径，保持原生行为）----
if [ "$NEWAPI_MODE" = "0" ]; then
  echo "[entrypoint] 启动模式: wag2api-only | PORT=$PORT | HOST=${HOST:-0.0.0.0}"
  exec node "$WAG_DIR/src/server.mjs"
fi

# ---- 3. All-in-One 专业合体模式（Nginx 智能分流 + 双核守护）----
echo "[entrypoint] 启动模式: all-in-one-pro | Nginx(对外):0.0.0.0:$PORT"
echo "[entrypoint] 分流规则: /wag/ 专属管理暗门 -> wag2api:3001 | 商业系统与API -> NewAPI:3002"

# 仅在合体模式下为 Node 注入堆限制，安全守住 512MB 内存底线
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=192}"

# 1. 启动内部 wag2api 算力与管理引擎 (127.0.0.1:3001)
PORT="$WAG_PORT" HOST=127.0.0.1 node "$WAG_DIR/src/server.mjs" &
WAG_PID=$!

# 2. 启动内部 NewAPI 商业管理中心 (127.0.0.1:3002)
PORT="$NEWAPI_PORT" GIN_MODE=release "$NEWAPI_BIN" --port "$NEWAPI_PORT" &
NEWAPI_PID=$!

# 3. 动态渲染 Nginx 端口模板并启动前置代理
mkdir -p /tmp/client_body /tmp/proxy_temp /tmp/fastcgi_temp /tmp/uwsgi_temp /tmp/scgi_temp
envsubst '${PORT}' < /app/scripts/nginx.conf.template > /tmp/nginx.conf
nginx -c /tmp/nginx.conf -g 'daemon off;' &
NGINX_PID=$!

echo "[entrypoint] wag2api pid=$WAG_PID, new-api pid=$NEWAPI_PID, nginx pid=$NGINX_PID"

IS_TERMINATING=0
term_handler() {
  echo "[entrypoint] 收到停机信号 (SIGTERM/SIGINT)，执行优雅平滑退出..."
  IS_TERMINATING=1
  kill -QUIT "$NGINX_PID" 2>/dev/null || true
  kill -TERM "$WAG_PID" "$NEWAPI_PID" 2>/dev/null || true
  wait "$WAG_PID" "$NEWAPI_PID" "$NGINX_PID" 2>/dev/null || true
  echo "[entrypoint] 所有子进程均已安全退出，进程守护正常结束。"
  exit 0
}
trap term_handler SIGTERM SIGINT

# ---- 4. 守护：任一子进程异常崩溃退出时快速退出自愈 ----
set +e
wait -n "$WAG_PID" "$NEWAPI_PID" "$NGINX_PID"
EXIT_STATUS=$?
set -e

if [ "$IS_TERMINATING" = "1" ]; then
  exit 0
fi

echo "[entrypoint] ⚠️ 检测到子进程异常退出 (退出码=$EXIT_STATUS)，立即终止容器以触发云端自愈重启！" >&2
kill -TERM "$WAG_PID" "$NEWAPI_PID" "$NGINX_PID" 2>/dev/null || true
wait 2>/dev/null || true
exit 1
