#!/usr/bin/env bash
# RoomVoice 服务器端 LiveKit 部署脚本（在服务器上以 root 执行）
set -euo pipefail

IP="114.67.168.228"
API_KEY="devkey"
LIVEKIT_DIR="/opt/livekit"
BIN="${LIVEKIT_DIR}/livekit-server"

echo ">>> [0/5] 检查二进制 ..."
if [ ! -x "${BIN}" ]; then
  echo "    二进制不存在，从 ghfast.top 镜像下载 ..."
  cd /tmp
  curl -sL --max-time 240 -o livekit.tar.gz \
    "https://ghfast.top/https://github.com/livekit/livekit/releases/download/v1.13.5/livekit_1.13.5_linux_amd64.tar.gz"
  SZ=$(stat -c%s livekit.tar.gz 2>/dev/null || echo 0)
  if [ "$SZ" -lt 10000000 ]; then
    echo "!!! 下载不完整 (${SZ} 字节)，退出"
    exit 1
  fi
  mkdir -p "${LIVEKIT_DIR}"
  tar -xzf livekit.tar.gz -C "${LIVEKIT_DIR}"
  chmod +x "${BIN}"
fi
echo "    版本: $(${BIN} --version)"

API_SECRET="${LIVEKIT_API_SECRET:-$(openssl rand -hex 16)}"

echo ">>> [1/5] 生成自签名 TLS 证书 (CN=${IP}) ..."
mkdir -p "${LIVEKIT_DIR}/tls"
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "${LIVEKIT_DIR}/tls/key.pem" -out "${LIVEKIT_DIR}/tls/cert.pem" \
  -days 3650 -subj "/CN=${IP}" -addext "subjectAltName=IP:${IP}" 2>/dev/null

echo ">>> [2/5] 写入 livekit.yaml ..."
cat > "${LIVEKIT_DIR}/livekit.yaml" <<YAML
port: 7443
tls:
  cert: ${LIVEKIT_DIR}/tls/cert.pem
  key: ${LIVEKIT_DIR}/tls/key.pem
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

echo ">>> [3/5] 注册 systemd 服务 ..."
cat > /etc/systemd/system/livekit.service <<'UNIT'
[Unit]
Description=LiveKit Server (RoomVoice)
After=network.target

[Service]
ExecStart=/opt/livekit/livekit-server --config /opt/livekit/livekit.yaml
Restart=on-failure
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable livekit
systemctl restart livekit
sleep 3

echo ">>> [4/5] 服务状态 ..."
systemctl is-active livekit || { echo "!!! 服务未运行，查看日志:"; journalctl -u livekit -n 20 --no-pager; exit 1; }
ss -tlnp 2>/dev/null | grep -E ':7443|:7881' || true

echo ">>> [5/5] 防火墙放行 ..."
ufw allow 7443/tcp >/dev/null 2>&1 || true
ufw allow 7881/tcp >/dev/null 2>&1 || true
ufw allow 50000:50100/udp >/dev/null 2>&1 || true
echo "    ufw 规则已添加（如未启用 ufw 则忽略）"

echo ""
echo "============================================================"
echo "  LiveKit 部署完成！"
echo "  客户端连接地址: wss://${IP}:7443"
echo "  管理地址(HTTPS): https://${IP}:7443"
echo "  API_KEY   = ${API_KEY}"
echo "  API_SECRET= ${API_SECRET}"
echo "============================================================"
