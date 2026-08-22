# 架构说明

## 总览

Screlink 是一个「信令服务器 + Web 客户端」的屏幕共享系统。核心思想：**服务器只管房间和信令，媒体流在浏览器之间点对点（P2P）传输**。

```
┌────────────────────────┐          ┌──────────────────────────┐
│        主机浏览器        │          │        观看者浏览器        │
│  getDisplayMedia 捕获    │          │   <video> 播放远端流      │
│  RTCPeerConnection × N  │◄────────►│   RTCPeerConnection × 1   │
└───────────┬────────────┘  WebRTC   └───────────┬──────────────┘
            │      (SRTP 媒体流，不经过服务器)      │
            │ WebSocket 信令（SDP / ICE）          │ WebSocket 信令
            ▼                                    ▼
┌───────────────────────────────────────────────────────────┐
│                  Node.js 信令服务器                        │
│  HTTP 静态服务 (public/) + /api/*                         │
│  WebSocket /ws：房间管理、offer/answer/ICE 转发、心跳清理    │
└───────────────────────────────────────────────────────────┘
```

## 目录结构

```
Screlink/
├── server/            # Node.js 服务端（ESM）
│   ├── index.js       # 入口：解析参数、启动 HTTP(S)
│   ├── app.js         # 组装：HTTP 路由 + /api/* + 静态 + WS
│   ├── signaling.js   # 核心：房间管理、信令转发、心跳
│   ├── static.js      # 极简静态文件服务（防目录穿越）
│   ├── https.js       # 自签名证书生成/加载（SAN 含局域网 IP）
│   └── config.js      # 环境变量配置 + 版本号来源
├── public/            # Web 前端（零构建，原生 JS）
│   ├── index.html
│   ├── style.css
│   └── app.js         # 双角色客户端：共享/观看 + WebRTC
├── scripts/
│   └── smoke-test.js  # 端到端冒烟测试（HTTP API + 信令流程）
└── docs/              # 本文档与协议文档
```

## 拓扑：星形（Mesh）

- 主机与每个观看者各建立一条 P2P 连接，主机把屏幕流 `addTrack` 到每条连接。
- 优点：实现简单、低延迟、服务器零媒体负载。
- 代价：主机上行带宽随观看人数线性增长。默认上限 8 人，对局域网/小规模场景足够。
- 未来可演进为 SFU（服务器转发）以支持更大规模，信令协议无需改动。

## 一次共享的完整流程

```
主机                        服务器                        观看者
 │  WS connect                 │                            │
 │ ── {type:"create"} ───────► │                            │
 │ ◄── {type:"created",room} ─ │                            │
 │  getDisplayMedia()          │                            │
 │                             │ ◄── WS connect             │
 │                             │ ◄── {type:"join",room}     │
 │                             │ ── {type:"joined"} ──────► │
 │ ◄── {type:"viewer-joined"}  │                            │
 │  新建 PC、addTrack、createOffer                            │
 │ ── {type:"offer",to,sdp} ─► │ ── offer ────────────────► │
 │                             │   setRemoteDescription     │
 │                             │   createAnswer             │
 │ ◄── answer ──────────────── │ ◄─ {type:"answer",sdp} ─── │
 │  ICE candidates ◄────────►（双向经服务器转发）             │
 │ ════════════════ WebRTC 媒体流（P2P，不经服务器）═════════► │
```

## 关键设计决策

1. **版本号单一来源**：版本只写在 `package.json`，`server/config.js` 读取后通过 `/api/config` 和 `/api/health` 暴露给前端，避免多处维护不一致。
2. **主机永远是 offer 方**：只有主机推流，offer/answer 不会发生「双方同时 offer」的冲突，无需 perfect negotiation。
3. **观看者信令不路由到其他观看者**：观看者的 offer/answer/ice 一律转发给本房间主机，主机侧按 `to` 精确路由，杜绝串房间。
4. **ICE 候选缓存**：候选可能先于远端 SDP 到达，客户端用 `queueIce/flushIce` 缓存再注入。
5. **心跳清理**：服务器每 30s 发 WebSocket ping，未回应则断开；断连即触发房间清理与通知。
6. **房间生命周期 = 共享会话**：主机断开即关房间，简单可靠（等待室列入 v0.2）。
7. **零前端构建**：原生 ES6 + 原生 CSS，无打包工具，`npm install` 仅装服务端两个依赖（`ws`、`selfsigned`）。

## 安全说明（v0.1.0）

- 媒体流本身由浏览器 WebRTC 加密（DTLS-SRTP），端到端传输。
- 信令（SDP/ICE）在局域网内为明文 WebSocket；公网部署务必使用 HTTPS/WSS（见 README「部署」）。
- 房间号 6 位取自 32 字符无歧义字母表（约 10 亿组合），并带有随机性；但 v0.1.0 无鉴权，**请勿用于敏感内容**，后续版本规划访问密码。
- 自签名证书仅用于局域网内启用屏幕捕获所需的安全上下文，浏览器会提示警告，属预期行为。

## 已知限制

见 README「已知限制」一节；均列入路线图版本计划。
