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

### Docker 一键部署（推荐）

仓库内已带 `docker-compose.yml`：**Screlink + coturn(TURN) + Caddy(自动 HTTPS)**。详见 [DEPLOY.md](DEPLOY.md)。在境外轻量云服务器（免备案）上一行命令即可上线。

## 文档

- [架构说明](docs/ARCHITECTURE.md)
- [信令协议](docs/PROTOCOL.md)
- [更新日志](CHANGELOG.md)

## 版本

当前版本 **v0.6.6**，采用语义化版本（SemVer）。变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## 更新计划

### v0.5.x — 稳定性与观看体验
- **断线自动重连**：观看端连接中断后自动重建 PeerConnection（目前需要手动刷新）
- **推流画质/码率/帧率选择**：主机端提供清晰度档位（自动 / 高 / 中 / 低）
- **画面比例切换**：观看端「适应窗口 ⇄ 原始尺寸」
- 更友好的连接状态提示与网络质量反馈

### v0.6.x — 房间与易用性
- **房间等待室**：主机先创建房间，观看者先加入等待，主机再开始共享
- **自定义/固定房间号**、**房间访问口令**（简单鉴权）
- **观看者列表**（谁在观看）、房间空闲自动回收（TTL）

### v0.7.x — 远程控制与协作
- **远程控制**：观看者经 WebRTC DataChannel 发送鼠标/键盘，实现「跟随式远程协助」
- 可选白板/标注、多人同时共享（各自切换）

### v1.0 — 生产可用
- **SFU 转发**：用 mediasoup/coturn 方案承载更多观看者（当前星形 mesh，主机上行随人数线性增长）
- **账号体系 + 常驻房间链接**（可重复使用的固定 URL）
- **移动端体验优化**（手势、横屏、画面缩放）
- **隐私与安全**：共享水印、录制/共享提示、细粒度访问控制
- **运维增强**：`/api/health` 指标扩展、日志结构、主动告警；可选 Electron 桌面客户端一键启动
- **国际化**：README 与界面双语

> **近期先做**：端到端验证（电脑共享 + 手机流量观看、确认 TURN 链路与实际画质），再按上面优先级推进。

## 已知限制

- 共享期间主机刷新页面会关闭房间，观看者需重新加入
- 观看者刷新会自动重连，但连接中断不自动恢复（v0.5 计划）
- 观看人数较多时受主机上行带宽限制（mesh 拓扑，v1.0 移入 SFU）
- 跨公网依赖 TURN；未配置 TURN 时仅部分网络可点对点直连
- 当前无账户/口令，房间号不设防（v0.6 计划加入口令）

## License

[MIT](LICENSE) © Jokldgd
