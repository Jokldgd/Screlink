# Screlink 公网部署（Docker）

一套命令把你本地的 Screlink 部署到一台有公网 IP 的服务器上，实现**真正可公网观看**：
- **Screlink**：信令 + 页面（容器内 8787）
- **coturn**：TURN 中继，跨网打洞失败时兜底转发媒体
- **Caddy**：自动申请/续期 HTTPS 证书，对外反向代理到 Screlink（含 WebSocket）

> 推荐使用**境外轻量云服务器**（香港 / 新加坡 / 美国等）——**免 ICP 备案**，一条命令即可拿到 `https://域名`。

## 前置条件

1. 一台有公网 IP 的服务器（linux，推荐 Debian/Ubuntu），已安装 Docker 和 Docker Compose：
   ```bash
   curl -fsSL https://get.docker.com | sh
   ```
2. 一个域名，已解析（A 记录）到这台服务器的公网 IP。
3. 云防火墙/安全组**放行端口**：
   - `80` / `443`（TCP，Caddy http/https）
   - `3478`（TCP+UDP，TURN 监听）
   - `49152`–`65535`（UDP，TURN 中继）

## 部署步骤

1. **把仓库弄到服务器上并进入目录**
   ```bash
   git clone https://github.com/Jokldgd/Screlink.git
   cd Screlink
   ```

2. **配置 `.env`**
   ```bash
   cp .env.example .env
   nano .env
   ```
   修改：
   ```ini
   DOMAIN=screlink.example.com        # 你的域名（已解析到服务器 IP）
   TURN_USER=screlink
   TURN_PASS=改成你的强密码            # TURN 凭据，连接浏览器与服务器的共用
   ```

3. **启动**
   ```bash
   docker compose up -d --build
   ```
   首次会拉取 coturn / caddy 镜像并构建 Screlink 镜像。

4. **查看状态**
   ```bash
   docker compose ps
   docker compose logs -f screlink
   ```
   看到 `Screlink v0.2.0` 与 HTTP 服务启动日志即正常。

## 使用

- **主机**打开：`https://你的域名` → 点「共享屏幕」→ 得到房间号/链接
- **观看者**打开：`https://你的域名/#room=房间号`（或直接点你发去的链接）

> 因为走的是有效 HTTPS，主机能正常调起屏幕捕获（无需 localhost/自签名），观看者也不会有证书警告。

## 验证链路

在另一台设备（如手机流量）打开：
```
https://你的域名/api/health
```
返回 `{"status":"ok","version":"0.2.0",...}` 即服务正常。

## 常见问题

| 现象 | 排查 |
| --- | --- |
| 域名打开证书错误/连不上 | 域名是否解析到该 IP？防火墙是否放行 80/443？ |
| 能连上但画面黑/一直连接 | 大多是 TURN 未生效：确认 3478 与中继端口放行、`.env` 里的 `TURN_PASS` 与 coturn 一致。可用 `docker compose logs coturn` 看有无报错 |
| 局域网看正常、公网不行 | 正是需要 TURN 的场景；检查 TURN 可达性 |
| Caddy 证书申请失败 | 域名必须解析到本机且 80/443 可达（Let's Encrypt 校验） |

## 无域名时（进阶）

若暂不想要域名，Caddy 可改用 `tls internal`，或用 Screlink 自带的 HTTPS 模式——但都会出现自签名证书警告，仅适合小范围试用。推荐还是配一个域名，体验最佳。
