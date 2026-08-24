#!/usr/bin/env python3
import os
"""服务器端：安装 Node.js 22（npmmirror 镜像）"""
import paramiko

HOST = "114.67.168.228"
USER = "root"
PASSWORD = os.environ.get("RV_SSH_PASSWORD", "")  # TODO: 填入你的服务器 SSH 密码

NODE_VER = "v22.14.0"
TARBALL = f"node-{NODE_VER}-linux-x64.tar.xz"
URL = f"https://npmmirror.com/mirrors/node/{NODE_VER}/{TARBALL}"


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

    o, _ = run(cli, "which node && node -v || echo NO_NODE")
    print("[0] 现有 node:", o)
    if o and o != "NO_NODE" and "v22" in o:
        print("Node 22 已存在，跳过安装")
        cli.close()
        return

    print(f"[1] 下载 Node {NODE_VER} ...")
    o, e = run(cli, f"cd /tmp && rm -f {TARBALL} && curl -sL --max-time 240 -o {TARBALL} '{URL}' && ls -lh {TARBALL}", 300)
    print(o or e)

    print("[2] 解压到 /opt/node ...")
    o, e = run(cli, f"mkdir -p /opt/node && tar -xJf /tmp/{TARBALL} -C /opt/node --strip-components=1 && /opt/node/bin/node -v", 120)
    print(o or e)

    print("[3] 配置 PATH 软链 ...")
    o, e = run(cli, "ln -sf /opt/node/bin/node /usr/local/bin/node; ln -sf /opt/node/bin/npm /usr/local/bin/npm; ln -sf /opt/node/bin/npx /usr/local/bin/npx; node -v && npm -v", 60)
    print(o or e)

    print("[4] npm 源切换 npmmirror ...")
    o, e = run(cli, "npm config set registry https://registry.npmmirror.com; npm config get registry", 30)
    print(o or e)

    cli.close()
    print("=== Node 安装完成 ===")


if __name__ == "__main__":
    main()
