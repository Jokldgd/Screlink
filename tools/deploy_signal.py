#!/usr/bin/env python3
import os
"""服务器端：部署信令服务器（roomvoice-signal）"""
import paramiko

HOST = "114.67.168.228"
USER = "root"
PASSWORD = os.environ.get("RV_SSH_PASSWORD", "")  # TODO: 填入你的服务器 SSH 密码
LOCAL_TAR = "E:/ai缓存文件/2026-08-24-20-06-03/room-voice/tools/rv-server.tar.gz"

ENV = """PORT=3000
HOST=127.0.0.1
STORE_MODE=memory
REDIS_URL=redis://localhost:6379
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=REPLACE_WITH_YOUR_LIVEKIT_SECRET
LIVEKIT_URL=wss://114.67.168.228:7443/livekit
LIVEKIT_HOST=http://127.0.0.1:7880
TRTC_SDK_APP_ID=1600158867
TRTC_SECRET_KEY=REPLACE_WITH_YOUR_TRTC_SECRET_KEY
ROOM_MAX_MEMBERS=10
HEARTBEAT_TIMEOUT_MS=90000
"""

UNIT = """[Unit]
Description=RoomVoice Signal Server
After=network.target

[Service]
WorkingDirectory=/opt/roomvoice/server
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=3
EnvironmentFile=/opt/roomvoice/server/.env
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
"""


def run(cli, cmd, timeout=120):
    _, out, err = cli.exec_command(cmd, timeout=timeout)
    o = out.read().decode(errors="replace").strip()
    e = err.read().decode(errors="replace").strip()
    return o, e


def main():
    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    cli.connect(HOST, port=22, username=USER, password=PASSWORD,
                timeout=15, banner_timeout=15, auth_timeout=15,
                allow_agent=False, look_for_keys=False)

    # 1. 上传并解压
    sftp = cli.open_sftp()
    sftp.put(LOCAL_TAR, "/tmp/rv-server.tar.gz")
    sftp.close()
    o, e = run(cli, "mkdir -p /opt/roomvoice && rm -rf /opt/roomvoice/server && tar -xzf /tmp/rv-server.tar.gz -C /opt/roomvoice && ls /opt/roomvoice/server")
    print("[1] 解压:", o or e)

    # 2. npm install（npmmirror）
    o, e = run(cli, "cd /opt/roomvoice/server && npm config set registry https://registry.npmmirror.com && npm install --omit=dev --no-audit --no-fund 2>&1 | tail -3", 600)
    print("[2] npm install:", o or e)

    # 3. 写 .env
    sftp = cli.open_sftp()
    with sftp.open("/opt/roomvoice/server/.env", "w") as f:
        f.write(ENV)
    sftp.close()
    print("[3] .env 已写入")

    # 4. systemd 服务
    sftp = cli.open_sftp()
    with sftp.open("/etc/systemd/system/roomvoice-signal.service", "w") as f:
        f.write(UNIT)
    sftp.close()
    o, e = run(cli, "systemctl daemon-reload && systemctl enable roomvoice-signal && systemctl restart roomvoice-signal && sleep 3 && systemctl is-active roomvoice-signal", 60)
    print("[4] 服务:", o or e)

    # 5. 验证
    o, e = run(cli, "curl -s http://127.0.0.1:3000/api/health", 30)
    print("[5] health:", o or e)
    o, e = run(cli, "ss -tlnp 2>/dev/null | grep ':3000' || echo '3000 未监听'", 30)
    print("[5] 监听:", o or e)

    cli.close()
    print("=== 信令服务器部署完成 ===")


if __name__ == "__main__":
    main()
