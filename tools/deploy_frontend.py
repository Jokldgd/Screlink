#!/usr/bin/env python3
import os
"""服务器端：部署前端静态页 + nginx 统一入口(7443)"""
import paramiko

HOST = "114.67.168.228"
USER = "root"
PASSWORD = os.environ.get("RV_SSH_PASSWORD", "")  # TODO: 填入你的服务器 SSH 密码
LOCAL_TAR = "E:/ai缓存文件/2026-08-24-20-06-03/room-voice/tools/rv-client-dist.tar.gz"

NGINX_CONF = """server {
    listen 7443 ssl;
    server_name 114.67.168.228;

    ssl_certificate     /opt/livekit/tls/cert.pem;
    ssl_certificate_key /opt/livekit/tls/key.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    client_max_body_size 16m;

    root /var/www/roomvoice;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /assets/ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /ws {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    location /livekit/ {
        proxy_pass http://127.0.0.1:7880/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
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

    # 1. 上传前端 dist
    sftp = cli.open_sftp()
    sftp.put(LOCAL_TAR, "/tmp/rv-client.tar.gz")
    sftp.close()
    o, e = run(cli, "mkdir -p /var/www/roomvoice && rm -rf /var/www/roomvoice/* && tar -xzf /tmp/rv-client.tar.gz -C /var/www/roomvoice && ls /var/www/roomvoice")
    print("[1] 前端部署:", o or e)

    # 2. 写 nginx 配置
    sftp = cli.open_sftp()
    with sftp.open("/etc/nginx/sites-available/livekit", "w") as f:
        f.write(NGINX_CONF)
    sftp.close()
    o, e = run(cli, "nginx -t 2>&1")
    print("[2] nginx -t:", o or e)
    run(cli, "systemctl restart nginx; sleep 2")

    # 3. 验证各端点
    for path in ["/", "/api/health", "/livekit/"]:
        o, e = run(cli, f"curl -sk https://127.0.0.1:7443{path} -o /dev/null -w '%{{http_code}}'", 20)
        print(f"[3] https://IP:7443{path} -> HTTP {o or e}")

    cli.close()
    print("=== 前端 + nginx 部署完成 ===")


if __name__ == "__main__":
    main()
