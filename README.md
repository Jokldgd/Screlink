# 🎙 Screlink — Discord 式临时房间语音房

> 先**创建房间**获得 **6 位数字房间号**，把号码分享给朋友，凭房间号加入；人走房销、最多 10 人，支持**语音通话 + 屏幕共享**，底层可切换 **腾讯云 TRTC / LiveKit / P2P 直连**三种媒体模式。

| 维度 | 说明 |
|---|---|
| 交互方式 | 创建房间 → 获取房间号 → 凭房间号加入（非 Discord 列表点击进入） |
| 生命周期 | 临时房间：最后一人离开后**自动销毁**，不持久化 |
| 房间上限 | 10 人/房间（`ROOM_MAX_MEMBERS` 可调） |
| 核心功能 | 语音通话（WebRTC）+ 屏幕共享 |
| 媒体模式 | **TRTC（商业 RTC，推荐）> LiveKit（自建 SFU）> P2P 直连（降级）**，自动切换 |

---

## ✨ 功能特性

- **创建/加入**：6 位数字房间号，创建后高亮展示、一键复制；凭号加入，格式校验
- **语音通话**：进入即开麦，静音/取消静音（状态同步给全员）
- **屏幕共享**：
  - 分享画质：1080p 超清（60fps）/ 720p 高清 / 480p 流畅
  - 编码器：H264（硬编，画质好、CPU 低）/ VP8（兼容）〔LiveKit 模式〕
  - 画质策略：智能 / 清晰优先 / 流畅优先（带宽受限时的取舍方向）
  - 系统声音：分享时可同时传输屏幕音频（LiveKit/TRTC 模式）
  - **网络自适应**：分享端上行带宽差时自动降级码率，恢复后自动升回
- **观看端**：清晰度切换（自动/1080p/720p/480p）、**全屏观看**、分享音量调节（LiveKit 模式）
- **成员实时状态**：进出、静音、共享中标识、房主/自己高亮
- **临时生命周期**：最后一人离开 → 房间自动销毁、房间号作废
- **活跃房间列表**：首页实时展示（仅信息，进入凭房间号）

## 🏗 架构

```
┌──────────────┐  REST /api/*   ┌──────────────────┐
│  浏览器前端    │ ─────────────▶ │  信令服务器       │
│  Vue3 + Vite │                │  Fastify + ws    │── 房间数据（内存/Redis，不落库）
│              │ ◀───────────── │  · 创建/加入/离开 │
└──────┬───────┘                │  · 成员状态广播    │
       │  媒体层（三模式自动切换） └────────┬─────────┘
       ▼                                   │ 签发凭据
  ┌──────────────┐  ┌──────────────┐  ┌────┴─────┐
  │ 腾讯云 TRTC   │  │ LiveKit SFU  │  │ P2P Mesh │
  │ 商业RTC·全国   │  │ 自建·服务器   │  │ 浏览器直连│
  │ 边缘节点+弱网  │  │ 114.67.x.x   │  │ 无服务器  │
  └──────────────┘  └──────────────┘  └──────────┘
```

- **两条连接**：浏览器 ↔ 信令服务器（WebSocket，业务状态）；浏览器 ↔ 媒体服务器（音视频）
- **媒体模式选择**：配置了 `TRTC_*` → TRTC；否则配置了 `LIVEKIT_*` → LiveKit；都没有 → P2P 直连
- **临时房间不落库**：房间数据只存 Redis/内存，销毁即清；最后一人离开自动销毁

## 🚀 快速开始（本地直跑）

```bash
# 1. 安装依赖（monorepo）
npm install

# 2. 启动信令服务器（默认内存模式，端口 3000）
npm run dev:server

# 3. 启动前端（端口 5173）
npm run dev:client
```

打开 <http://localhost:5173>：创建房间 → 拿房间号 → 朋友输入房间号加入 → 语音/共享。

- **未配置任何媒体服务器**：自动使用 **P2P 直连**（本机/局域网即可真实语音+屏幕共享）
- 浏览器需 **HTTPS 或 localhost**（安全上下文）才能使用麦克风/屏幕共享

## ☁️ 配置商业 RTC（推荐：腾讯云 TRTC）

到 [腾讯云 TRTC 控制台](https://console.cloud.tencent.com/trtc) 创建应用，拿到 **SDKAppID** 与 **SDK 密钥**，填入 `server/.env`：

```env
TRTC_SDK_APP_ID=1600xxxxxx
TRTC_SECRET_KEY=你的SDK密钥
```

重启信令服务器后，前端自动切换到 TRTC 模式（全国边缘节点 + 商业级弱网对抗，画质对标主流商业语音软件）。

> **安全提示**：`server/.env` 含密钥，已加入 `.gitignore`，**切勿提交到仓库**。部署脚本（`tools/`）中的凭据均为占位符，使用前请替换为你的实际值。

## 🖥 自建 LiveKit（备选）

配置 `LIVEKIT_*` 环境变量（API Key/Secret/URL）即可使用自建 LiveKit SFU；参考 `deploy/livekit/install-livekit.sh`（服务器二进制一键安装）或 `deploy/docker-compose.yml`（Docker 全套）。

## 📦 线上部署（本项目现状）

线上地址：**https://114.67.168.228:7443**（nginx 统一入口，自签证书；首次访问需在浏览器手动信任证书）

| 组件 | 部署情况 |
|---|---|
| nginx | `:7443 ssl`：`/` 前端静态页、`/api` `/ws` 信令反代、`/livekit/` LiveKit 反代 |
| 信令服务器 | Node 22 + Fastify，systemd 服务 `roomvoice-signal`，监听 `127.0.0.1:3000` |
| 媒体 | 腾讯云 TRTC（首选）+ LiveKit v1.13.5（自建，含内置 TURN 3478/UDP）+ P2P 降级 |
| 运维脚本 | `tools/`：`deploy_signal.py` / `deploy_frontend.py` / `ssh_helper.py` 等（paramiko，凭据用环境变量 `RV_SSH_PASSWORD`） |

## 📡 信令协议摘要（WebSocket `/ws`）

统一格式：`{ "type": "...", "payload": {...} }`

**客户端 → 服务器**

| type | payload | 说明 |
|---|---|---|
| `join_room` | `{ roomCode, userName }` | 凭房间号加入（校验存在/满员） |
| `leave_room` | `{}` | 主动离开 |
| `mute_toggle` | `{ muted }` | 静音状态同步（实际麦克风本地控制） |
| `start_screen_share` / `stop_screen_share` | `{}` | 共享状态广播（媒体走媒体服务器） |
| `webrtc_signal` | `{ target, data }` | P2P 模式 SDP/ICE 点对点转发 |
| `ping` | `{ t }` | 心跳（30s） |

**服务器 → 客户端**

| type | 说明 |
|---|---|
| `join_room_ok` | `{ roomCode, roomName, livekitUrl, livekitToken, livekitConfigured, trtcConfigured, trtc, self, members[] }` |
| `error` | `{ code, message }` |
| `member_joined` / `member_left` / `member_muted` | 成员事件（房间广播） |
| `screen_share_started` / `screen_share_stopped` | 共享事件 |
| `room_created` / `room_destroyed` | 全局事件（活跃列表实时刷新） |

**错误码**：`ROOM_NOT_FOUND` / `ROOM_FULL` / `INVALID_ROOM_CODE` / `ALREADY_IN_ROOM` / `NAME_REQUIRED` / `NOT_IN_ROOM` / `INTERNAL`

**REST**：`POST /api/rooms`（创建，返回房间号）｜`GET /api/rooms/:code`（预览）｜`GET /api/rooms`（活跃列表）｜`GET /api/health`

## 🧪 测试

```bash
cd server && npm test   # 信令端到端：创建/加入/满员/静音/共享/销毁/P2P转发/跨房间隔离
```

## 🗺 路线图

- ✅ 创建房间 → 房间号 → 凭号加入
- ✅ 语音通话（TRTC / LiveKit / P2P 三模式自动切换）
- ✅ 屏幕共享（画质/编码器/策略/系统声音/网络自适应）
- ✅ 观看端（清晰度切换/全屏/音量）
- ✅ 成员实时状态、10 人上限、临时销毁、活跃列表
- ⏳ 用户注册/登录（PostgreSQL 表已预留）
- ⏳ 移动端适配、降噪/回声消除、网络质量指示
- ⏳ 域名 + Let's Encrypt 证书（消除自签证书弹窗）

---

> 本项目是临时语音房方案的完整落地实现，架构细节与迭代记录见工作区记忆文件。
