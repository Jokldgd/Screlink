# Screlink 公网部署（Docker）

把 Screlink 部署到一台有公网 IP 的服务器，实现真正可公网观看：
- **Screlink**：信令 + 页面（同时监听 HTTP 8787 / HTTPS 8788）
- **coturn**：TURN 中继，跨网打洞失败时兜底转发媒体
- （域名模式）**Caddy**：自动 HTTPS 反向代理

提供两种模式：
- **IP 模式**（免 ICP 备案，推荐）：用公网 IP + 非标端口，`docker-compose.ip.yml`
- **域名模式**：用域名 + Caddy 自动证书，`docker-compose.yml`（需备案或海外节点）

## 前置条件

1. 一台有公网 IP 的服务器（推荐 **Ubuntu 22.04 / 24.04**，境外或国内均可），已装 Docker + Compose：
   ```bash
   curl -fsSL https://get.docker.com | sh
   ```
2. （域名模式才需要）一个已解析到该 IP 的域名；IP 模式不需要。

---

## 推荐：IP 模式（免备案，不碰 80/443）

> 阿里云大陆节点没有备案域名时，就用这个。

### 1) 放行安全组端口（阿里云控制台 → 实例 → 安全组 → 入方向）
- `8787` TCP（观看 HTTP）
- `8788` TCP（主机共享 HTTPS）
- `3478` TCP+UDP（TURN 监听）
- `49152`–`65535` UDP（TURN 中继）

### 2) 拉代码、配环境、启动
```bash
git clone https://github.com/Jokldgd/Screlink.git
cd Screlink
cp .env.example .env
nano .env
# 填 PUBLIC_IP=你的公网IP，TURN_PASS=强密码；DOMAIN 留空
docker compose -f docker-compose.ip.yml up -d --build
docker compose -f docker-compose.ip.yml logs -f screlink
```
看到 `Screlink v0.3.0` 且 HTTP/HTTPS 都正常监听即成功。

### 3) 使用
- **观看者**：打开 `http://<公网IP>:8787` 输入房间号
- **主机（共享）**：打开 `https://<公网IP>:8788`（自签名证书，点一次“继续访问”）→ 共享

---

## 域名模式（可选）

1. 域名解析（A 记录）到该服务器公网 IP；放行 `80`、`443`、`3478`、`49152–65535`。
2. `.env` 里填 `PUBLIC_IP` 和 `DOMAIN`、`TURN_PASS`。
3. 启动：`docker compose up -d --build`（用 Caddy 自动申请 HTTPS 证书，观看者和主机都访问 `https://域名`）。

> 阿里云大陆节点 + 域名走 80/443 必须先完成 ICP 备案，否则被拦截。

---

## 验证链路

在另一台设备（手机流量）打开：
- IP 模式：`http://<公网IP>:8787/api/health`
- 域名模式：`https://<域名>/api/health`

返回 `{"status":"ok","version":"0.3.0",...}` 即服务正常。

## 常见问题

| 现象 | 排查 |
| --- | --- |
| 公网地址打不开 | 安全组是否放行对应端口？云防火墙/ufw 是否放行？ |
| 能打开但画面黑/一直连接 | 多为 TURN 未生效：确认 3478 与中继端口放行、`.env` 的 `TURN_PASS` 与 coturn 一致；`docker compose logs coturn` 看有无报错 |
| 局域网正常、公网不行 | 正是需要 TURN 的场景 |
| 主机共享按钮灰/失败 | 主机必须用 HTTPS(8788) 打开，HTTP 端口不是安全上下文 |
