#!/usr/bin/env python3
import os
"""修复并重启服务器上的 LiveKit：重写 livekit.yaml（正确 TLS 字段）→ 重启 → 验证"""
import paramiko

HOST = "114.67.168.228"
USER = "root"
PASSWORD = os.environ.get("RV_SSH_PASSWORD", "")  # TODO: 填入你的服务器 SSH 密码

CONFIG = """port: 7880
tls_port: 7443
cert_file: /opt/livekit/tls/cert.pem
key_file: /opt/livekit/tls/key.pem
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


def main():
    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    cli.connect(HOST, port=22, username=USER, password=PASSWORD,
                timeout=15, banner_timeout=15, auth_timeout=15,
                allow_agent=False, look_for_keys=False)

    def run(cmd, timeout=30):
        _, out, err = cli.exec_command(cmd, timeout=timeout)
        o = out.read().decode(errors="replace").strip()
        e = err.read().decode(errors="replace").strip()
        return o, e

    # 1. 从现有配置读取 API_SECRET
    o, _ = run("grep 'devkey:' /opt/livekit/livekit.yaml")
    secret = o.split(":", 1)[-1].strip() if o else ""
    if not secret:
        print("[!] 未找到现有 secret，生成新的")
        o, _ = run("openssl rand -hex 16")
        secret = o.strip()
    print(f"[1] API_SECRET = {secret}")

    # 2. 写入正确配置
    cfg = CONFIG.replace("{SECRET}", secret)
    sftp = cli.open_sftp()
    with sftp.open("/opt/livekit/livekit.yaml", "w") as f:
        f.write(cfg)
    sftp.close()
    print("[2] livekit.yaml 已重写")

    # 3. 重启并验证
    o, e = run("systemctl restart livekit; sleep 4; systemctl is-active livekit; echo '---'; ss -tlnp 2>/dev/null | grep -E ':7443|:7880'; echo '---'; journalctl -u livekit -n 15 --no-pager 2>/dev/null | tail -15", 40)
    print("[3] 服务状态:")
    print(o)
    if e:
        print("[stderr]", e)

    # 4. 放行端口（ufw 可能未启用）
    o, _ = run("ufw allow 7443/tcp >/dev/null 2>&1; ufw allow 7880/tcp >/dev/null 2>&1; ufw allow 7881/tcp >/dev/null 2>&1; ufw allow 50000:50100/udp >/dev/null 2>&1; echo ufw_done")
    print("[4] 防火墙:", o)

    # 5. 健康检查（本地测试 TLS）
    import socket, ssl
    try:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        with socket.create_connection((HOST, 7443), timeout=8) as sock:
            with ctx.wrap_socket(sock, server_hostname=HOST) as ss:
                print(f"[5] TLS 握手成功: {ss.version()} {ss.cipher()[0]}")
    except Exception as ex:
        print(f"[5] TLS 检查失败: {ex}")

    cli.close()
    print("=== 完成 ===")


if __name__ == "__main__":
    main()
