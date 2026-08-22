# Screlink

> 轻量级浏览器屏幕共享：主机一键共享屏幕，观看者凭房间链接实时观看。

Screlink 由两部分组成：一个极简的 **Node.js 信令服务器**（房间管理 + WebRTC 信令转发），以及一个**单页 Web 前端**（同一页面既是「共享端」也是「观看端」）。音视频画面通过 **WebRTC 点对点传输**，不经过服务器，因此服务器只需极低带宽。

- ✨ **零安装**：共享端和观看端都只要一个现代浏览器（推荐 Chrome / Edge）
- 🔗 **房间链接**：主机创建房间获得 `ABC-123` 形式的房间号与分享链接
- 👥 **多人观看**：默认支持最多 8 人同时观看
- 🎧 **可选系统声音**：可同时共享系统声音
- 🖥️ **跨设备局域网共享**：同一 Wi-Fi 下手机、平板、电脑都能看

## 快速开始

要求：Node.js ≥ 18.17（开发环境为 Node 22）。

```bash
git clone https://github.com/Jokldgd/Screlink.git
cd Screlink
npm install
npm start
```

启动后浏览器打开 <http://localhost:8787>：

- **共享屏幕**：点「共享屏幕」→ 选择要共享的屏幕或窗口 → 得到房间号，把链接发给观看者
- **加入观看**：输入房间号，或直接打开主持人发来的链接（自动加入）

## 局域网 / 公网使用

`getDisplayMedia`（屏幕捕获）要求**安全上下文**：

| 场景 | 做法 |
| --- | --- |
| 本机自己测试 | `http://localhost:8787` 直接可用 |
| 局域网共享给其他人 | 主机运行 `npm run start:https`，打开 `https://<本机IP>:8788` 并信任自签名证书；观看者用 HTTP 链接即可 |
| 公网共享 | 把 8787 端口映射出去 + 反向代理挂上有效 HTTPS 证书（见下文「部署」） |

> 小技巧：即使主机用 `http://localhost` 共享，观看者仍可通过 `http://<局域网IP>:8787` 输入房间号观看——共享页会自动列出「局域网观看链接」。

## 配置

全部通过环境变量（前缀 `SCRELINK_`）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SCRELINK_PORT` | `8787` | HTTP 端口 |
| `SCRELINK_HTTPS_PORT` | `8788` | HTTPS 端口（`npm run start:https`） |
| `SCRELINK_HOST` | `0.0.0.0` | 监听地址 |
| `SCRELINK_MAX_VIEWERS` | `8` | 每房间最大观看人数 |
| `SCRELINK_STUN` | `stun:stun.l.google.com:19302` | STUN 服务器，逗号分隔 |
| `SCRELINK_TURN` | 空 | TURN 中继地址，逗号分隔（如 `turn:turn.example.com:3478`） |
| `SCRELINK_TURN_USER` | 空 | TURN 用户名（可选） |
| `SCRELINK_TURN_PASS` | 空 | TURN 密码（可选） |
| `SCRELINK_CERT_DAYS` | `365` | 自签名证书有效期（天） |

## 部署（公网）

1. `npm ci --omit=dev && npm start`（或使用 PM2 / Docker）
2. 用 Caddy / Nginx 反向代理 `8787` 端口并挂上有效 TLS 证书（推荐 Caddy，自动申请证书）：

   ```
   share.example.com {
       reverse_proxy 127.0.0.1:8787
   }
   ```

3. **配置 TURN 中继**（跨网打洞失败时的兜底，公网必配）。在同机安装 [coturn](https://github.com/coturn/coturn)，然后启动 Screlink：

   ```bash
   SCRELINK_TURN=turn:your-turn-host:3478 \
   SCRELINK_TURN_USER=user \
   SCRELINK_TURN_PASS=pass \
   npm start
   ```

4. 防火墙放行对应端口。观看者打开 `https://share.example.com/#room=XXX-XXX` 即可。

> 说明：无 STUN/TURN 时，同一局域网内可正常观看；跨公网（如手机流量）观看基本需要 TURN。

## 文档

- [架构说明](docs/ARCHITECTURE.md)
- [信令协议](docs/PROTOCOL.md)
- [更新日志](CHANGELOG.md)

## 版本

当前版本 **v0.1.0**，采用语义化版本（SemVer）。变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## 路线图

- v0.2：观看端画质/帧率自适应、房间等待室（主机可先开房间后共享）
- v0.3：观看端断线自动重连、NAT 穿透失败的 TURN 中继
- v0.4：远程控制（鼠标键盘）、多人同时共享（各自切换）
- v1.0：账号体系、常驻房间链接、部署 Docker 镜像

## 已知限制（v0.1.0）

- 共享期间若主机刷新页面，房间会关闭，观看者需重新加入
- 观看者刷新页面会自动重新加入，但主机与观看者的连接不自动重连（v0.3 计划）
- 跨公网 NAT 时依赖双方能通过 STUN 打洞，复杂网络环境需要 TURN（v0.3 计划）

## License

[MIT](LICENSE) © Jokldgd
