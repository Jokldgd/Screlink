#!/usr/bin/env python3
import os
"""SSH 工具：连接 114.67.168.228 执行命令 / 上传文件（paramiko）"""
import sys
import paramiko

HOST = "114.67.168.228"
USER = sys.argv[1] if len(sys.argv) > 1 else "root"
PASSWORD = os.environ.get("RV_SSH_PASSWORD", "")  # TODO: 填入你的服务器 SSH 密码

def connect():
    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    cli.connect(HOST, port=22, username=USER, password=PASSWORD, timeout=15, banner_timeout=15, auth_timeout=15)
    return cli

if __name__ == "__main__":
    mode = sys.argv[2] if len(sys.argv) > 2 else "probe"
    cli = connect()
    if mode == "probe":
        cmds = [
            "uname -a",
            "cat /etc/os-release 2>/dev/null | head -3",
            "whoami && id",
            "uptime",
            "free -h | head -2",
            "df -h / | tail -1",
            "nproc",
            "curl -sI --max-time 8 https://github.com | head -1 || echo 'github 不可达'",
            "which systemctl docker openssl curl tar 2>/dev/null",
        ]
        for c in cmds:
            print(f"$ {c}")
            _, out, err = cli.exec_command(c, timeout=20)
            o = out.read().decode(errors="replace").strip()
            e = err.read().decode(errors="replace").strip()
            print(o or e or "(空)")
            print("-" * 50)
    elif mode == "exec":
        cmd = sys.argv[3]
        _, out, err = cli.exec_command(cmd, timeout=int(sys.argv[4]) if len(sys.argv) > 4 else 60)
        print(out.read().decode(errors="replace"))
        errs = err.read().decode(errors="replace")
        if errs.strip():
            print("[stderr]", errs)
    elif mode == "upload":
        local, remote = sys.argv[3], sys.argv[4]
        sftp = cli.open_sftp()
        sftp.put(local, remote)
        sftp.close()
        print(f"上传完成: {local} -> {remote}")
    elif mode == "write":
        remote, content = sys.argv[3], sys.argv[4]
        sftp = cli.open_sftp()
        with sftp.open(remote, "w") as f:
            f.write(content)
        sftp.close()
        print(f"写入完成: {remote} ({len(content)} 字节)")
    cli.close()
