#!/usr/bin/env python3
import os
"""服务器端部署：livekit(7880) + nginx(7443 WSS 反代 + 自签证书)"""
import paramiko

HOST = "114.67.168.228"
USER = "root"
PASSWORD = os.environ.get("RV_SSH_PASSWORD", "")  # TODO: 填入你的服务器 SSH 密码

LIVEKIT_CFG = """port: 7880
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50100
  use_external_ip: true
keys:
  devkey: {SECRET}
room:
  empty_timeout: 60
logging:
  level: info
"""

NGINX_CONF = """server {{
    listen 7443 ssl;
    server_name {IP};

    ssl_certificate     /opt/livekit/tls/cert.pem;
    ssl_certificate_key /opt/livekit/tls/key.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    client_max_body_size 16m;

    location / {{
        proxy_pass http://127.0.0.1:7880;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }}
}}
"""


def run(cli, cmd, timeout=60):
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

    # 1. 读取/生成 secret
    o, _ = run(cli, "grep 'devkey:' /opt/livekit/livekit.yaml")
    secret = o.split(":", 1)[-1].strip() if o else ""
    if not secret:
        o, _ = run(cli, "openssl rand -hex 16")
        secret = o.strip()
    print(f"[1] API_SECRET = {secret}")

    # 2. 重写 livekit.yaml（无 TLS，纯 WS 7880）
    sftp = cli.open_sftp()
    with sftp.open("/opt/livekit/livekit.yaml", "w") as f:
        f.write(LIVEKIT_CFG.replace("{SECRET}", secret))
    sftp.close()
    run(cli, "systemctl restart livekit; sleep 3")
    o, e = run(cli, "systemctl is-active livekit; ss -tlnp 2>/dev/null | grep ':7880' || echo '7880 未监听'")
    print("[2] livekit 状态:\n", o, e)

    # 3. 安装 nginx（若未安装）
    o, _ = run(cli, "which nginx || echo NO_NGINX")
    if "NO_NGINX" in o or not o:
        print("[3] 安装 nginx ...")
        o, e = run(cli, "apt-get update -qq && apt-get install -y -qq nginx 2>&1 | tail -3", 240)
        print(o or e)
    else:
        print("[3] nginx 已存在")

    # 4. 写 nginx 配置
    conf = NGINX_CONF.replace("{IP}", HOST)
    sftp = cli.open_sftp()
    with sftp.open("/etc/nginx/sites-available/livekit", "w") as f:
        f.write(conf)
    sftp.close()
    run(cli, "rm -f /etc/nginx/sites-enabled/default")
    run(cli, "ln -sf /etc/nginx/sites-available/livekit /etc/nginx/sites-enabled/livekit")
    o, e = run(cli, "nginx -t 2>&1")
    print("[4] nginx 配置检查:\n", o or e)
    run(cli, "systemctl restart nginx; sleep 2")
    o, _ = run(cli, "systemctl is-active nginx")
    print("[5] nginx 状态:", o)

    # 5. 验证 7443 TLS
    import socket, ssl
    try:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        with socket.create_connection((HOST, 7443), timeout=8) as sock:
            with ctx.wrap_socket(sock, server_hostname=HOST) as ss:
                print(f"[6] WSS 入口握手成功: {ss.version()} {ss.cipher()[0]}")
    except Exception as ex:
        print(f"[6] TLS 检查失败: {ex}")

    cli.close()
    print("=== 部署完成 ===")
    print(f"客户端连接: wss://{HOST}:7443  |  API_KEY=devkey  |  API_SECRET={secret}")


if __name__ == "__main__":
    main()
