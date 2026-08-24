#!/usr/bin/env bash
# ============================================================
# 在 Linux 服务器上安装并启动 LiveKit（无需 Docker）
# 用法:
#   LIVEKIT_DOMAIN=your-domain.com bash install-livekit.sh
#   （LIVEKIT_DOMAIN 不填则使用公网 IP 自动生成配置）
# 产物:
#   /opt/livekit/livekit-server   二进制
#   /opt/livekit/livekit.yaml     配置（自动生成密钥）
#   /etc/systemd/system/livekit.service   systemd 服务
# ============================================================
set -euo pipefail

VERSION="v1.13.5"
LIVEKIT_DIR="/opt/livekit"
BIN="${LIVEKIT_DIR}/livekit-server"
CFG="${LIVEKIT_DIR}/livekit.yaml"
DOMAIN="${LIVEKIT_DOMAIN:-}"
API_KEY="${LIVEKIT_API_KEY:-devkey}"
API_SECRET="${LIVEKIT_API_SECRET:-$(openssl rand -hex 16)}"

if [[ $EUID -eq 0 ]]; then SUDO=""; else SUDO="sudo"; fi

echo ">>> 下载 livekit-server ${VERSION} ..."
cd /tmp
curl -sLO --retry 3 "https://github.com/livekit/livekit/releases/download/${VERSION}/livekit_${VERSION#v}_linux_amd64.tar.gz" \
  || { echo "下载失败，请检查网络或使用代理"; exit 1; }
$SUDO mkdir -p "$LIVEKIT_DIR"
$SUDO tar -xzf "livekit_${VERSION#v}_linux_amd64.tar.gz" -C "$LIVEKIT_DIR"
$SUDO chmod +x "$BIN"
echo ">>> 版本: $($BIN --version)"

# 无域名时尝试取公网 IP
if [[ -z "$DOMAIN" ]]; then
  DOMAIN=$(curl -s --max-time 5 ifconfig.me || echo localhost)
fi

cat > /tmp/livekit.yaml <<YAML
port: 7880
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50100
  use_external_ip: true
keys:
  ${API_KEY}: ${API_SECRET}
room:
  empty_timeout: 60
logging:
  level: info
YAML
$SUDO cp /tmp/livekit.yaml "$CFG"

cat > /tmp/livekit.service <<UNIT
[Unit]
Description=LiveKit Server
After=network.target

[Service]
ExecStart=${BIN} --config ${CFG}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
$SUDO cp /tmp/livekit.service /etc/systemd/system/livekit.service
$SUDO systemctl daemon-reload
$SUDO systemctl enable --now livekit
sleep 2
$SUDO systemctl --no-pager status livekit | head -8

echo ""
echo "============================================================"
echo "  LiveKit 已启动！"
echo "  管理地址(HTTP): http://${DOMAIN}:7880"
echo "  浏览器连接地址: ws://${DOMAIN}:7880  (有域名+证书后为 wss://)"
echo "  API_KEY   = ${API_KEY}"
echo "  API_SECRET= ${API_SECRET}"
echo "============================================================"
echo "把上述 KEY/SECRET/URL 填入 server/.env 并重启信令服务器："
echo "  LIVEKIT_API_KEY=${API_KEY}"
echo "  LIVEKIT_API_SECRET=${API_SECRET}"
echo "  LIVEKIT_URL=ws://${DOMAIN}:7880"
echo "  LIVEKIT_HOST=http://${DOMAIN}:7880"
echo ""
echo "安全组请放行: 7880/7881 TCP, 50000-50100 UDP"
