#!/usr/bin/env bash
# wag2api Linux 一键安装 / 升级（systemd）
#   curl -fsSL https://raw.githubusercontent.com/zr987459/wag2api/main/scripts/install.sh | sudo bash
# 卸载：sudo bash install.sh uninstall
set -euo pipefail
REPO="zr987459/wag2api"
BIN=/usr/local/bin/wag2api
DATA=/var/lib/wag2api
ENVF=/etc/wag2api.env
UNIT=/etc/systemd/system/wag2api.service

[ "$(id -u)" = 0 ] || { echo "请用 root 运行（sudo）"; exit 1; }

if [ "${1:-}" = "uninstall" ]; then
  systemctl disable --now wag2api 2>/dev/null || true
  rm -rf "$BIN" /opt/wag2api "$UNIT"; systemctl daemon-reload
  echo "已卸载。数据保留在 $DATA，配置在 $ENVF，不需要可手动删除。"; exit 0
fi

URL="https://github.com/$REPO/releases/latest/download"
APP=/opt/wag2api
NODE=$(command -v node || true)
NODE_MAJOR=0
[ -n "$NODE" ] && NODE_MAJOR=$("$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)

if [ "${WAG2API_MODE:-auto}" != "binary" ] && [ "$NODE_MAJOR" -ge 18 ]; then
  # 轻量版：机器上已有 Node ≥ 18，只下载约 60KB 的代码包
  echo "→ 检测到 Node $NODE_MAJOR，安装轻量版"
  mkdir -p "$APP"
  curl -fsSL "$URL/wag2api-node.tar.gz" | tar xz -C "$APP"
  EXEC="$NODE $APP/src/server.mjs"
  rm -f "$BIN"
else
  case "$(uname -m)" in
    x86_64|amd64) ARCH=x64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) echo "暂不支持的架构：$(uname -m)"; exit 1 ;;
  esac
  if command -v xz >/dev/null 2>&1; then
    echo "→ 下载 wag2api-linux-$ARCH（压缩包约 30MB）"
    curl -fL --progress-bar "$URL/wag2api-linux-$ARCH.xz" | xz -dc > "$BIN.tmp"
  else
    echo "→ 下载 wag2api-linux-$ARCH（约 90MB，安装 xz-utils 可缩小到约 30MB）"
    curl -fL --progress-bar -o "$BIN.tmp" "$URL/wag2api-linux-$ARCH"
  fi
  chmod +x "$BIN.tmp" && mv "$BIN.tmp" "$BIN"
  EXEC="$BIN"
fi

id wag2api >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin wag2api
mkdir -p "$DATA" && chown -R wag2api:wag2api "$DATA"

if [ ! -f "$ENVF" ]; then
  cat > "$ENVF" <<CONF
# 修改后执行：sudo systemctl restart wag2api
PORT=8790
HOST=0.0.0.0
DATA_DIR=$DATA
AUTO_KEY=1
# ADMIN_KEY=  留空则首次启动自动生成，保存在 $DATA/keys.json
CONF
fi

cat > "$UNIT" <<UNITF
[Unit]
Description=wag2api - Antigravity to Anthropic/OpenAI API gateway
After=network-online.target
Wants=network-online.target

[Service]
User=wag2api
EnvironmentFile=$ENVF
ExecStart=$EXEC
Restart=always
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNITF

systemctl daemon-reload
systemctl enable wag2api >/dev/null 2>&1
systemctl restart wag2api
sleep 2

PORT=$(grep -oP '^PORT=\K\d+' "$ENVF" || echo 8790)
KEY=$(grep -oP '"admin_key":\s*"\K[^"]+' "$DATA/keys.json" 2>/dev/null || true)
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo
echo "✔ wag2api 已运行（开机自启）"
[ "$EXEC" = "$BIN" ] || echo "  版本:   轻量版（使用系统 Node）"
echo "  控制台: http://${IP:-127.0.0.1}:$PORT"
[ -n "$KEY" ] && echo "  密钥:   $KEY"
echo "  日志:   journalctl -u wag2api -f"
echo "  配置:   $ENVF"
