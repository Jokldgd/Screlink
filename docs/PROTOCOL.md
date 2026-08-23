# 信令协议

WebSocket 端点：`/ws`。所有消息均为 UTF-8 编码的 JSON 文本，格式 `{ "type": "...", ... }`。

## 角色与拓扑

- 每个 WebSocket 连接 = 一个节点（peer），由服务器分配唯一 `peerId`（UUID）。
- 节点通过 `create` 成为**主机**，通过 `join` 成为**观看者**；两者互斥，重复操作返回 `already-in-room`。
- 一个房间 = 1 主机 + N 观看者（默认 N ≤ 8）。
- 媒体协商：主机永远发起 `offer`，观看者回 `answer`（只有主机推流，不存在协商冲突）。

## 客户端 → 服务器

### create

请求创建房间，本连接成为主机。

```json
{ "type": "create" }
```

### join

请求加入房间。`room` 大小写不敏感，分隔符可省略（`abc123` / `ABC-123` 等价）。

```json
{ "type": "join", "room": "ABC-123" }
```

### offer / answer / ice

转发类消息。主机侧 `to` 必须是本房间某观看者的 `peerId`；观看者侧的 `to` 会被忽略（观看者消息一律路由给本房间主机）。

```json
{ "type": "offer", "to": "<viewerPeerId>", "sdp": { "type": "offer", "sdp": "..." } }
{ "type": "answer", "to": "<hostPeerId>", "sdp": { "type": "answer", "sdp": "..." } }
{ "type": "ice", "to": "<peerId>", "candidate": { "candidate": "...", "sdpMid": "...", "sdpMLineIndex": 0 } }
```

### renegotiate

观看者在连接中断（`failed`/`disconnected`）时请求主机重新协商。由观看者发送，服务器转发给本房间主机；主机收到后重建与该观看者的 PeerConnection 并重新发起 `offer`。

```json
{ "type": "renegotiate" }
```

### leave

主动离开房间（服务器也会在连接断开时自动清理）。

```json
{ "type": "leave" }
```

## 服务器 → 客户端

| 消息 | 接收者 | 载荷 | 含义 |
| --- | --- | --- | --- |
| `created` | 主机 | `room`, `peerId`, `viewerCount` | 房间创建成功，`room` 为 `XXX-XXX` 展示格式 |
| `joined` | 观看者 | `room`, `peerId`, `viewerCount` | 加入成功 |
| `error` | 发起者 | `code` | 操作失败，见错误码表 |
| `viewer-joined` | 主机 | `peerId`, `viewerCount` | 有新观看者加入，主机应立即向其发起 offer |
| `viewer-left` | 主机 | `peerId`, `viewerCount` | 观看者离开，主机应关闭对应 PeerConnection |
| `offer` | 观看者 | `from`(主机 peerId), `sdp` | 收到协商请求 |
| `answer` | 主机 | `from`(观看者 peerId), `sdp` | 协商应答 |
| `ice` | 双方 | `from`, `candidate` | ICE 候选 |
| `host-left` | 全体观看者 | `reason`: `"left"` \| `"disconnected"` | 主机离开，房间已关闭 |

## 错误码

| code | 说明 |
| --- | --- |
| `bad-json` | 消息不是合法 JSON |
| `unknown-type` | 未知消息类型 |
| `already-in-room` | 该连接已在房间中（重复 create/join） |
| `room-not-found` | 房间不存在或已关闭 |
| `room-full` | 房间观看人数已达上限 |
| `not-in-room` | 未加入房间却发送了转发类消息 |

## 房间号规则

- 长度 6 位，取自 32 字符无歧义字母表：`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`（去掉 0/O、1/I）。
- 展示格式 `XXX-XXX`；服务端归一化后匹配（去除非字母数字字符、转大写）。
- 空间约 32⁶ ≈ 10.7 亿；服务器生成时保证当前不重复。

## HTTP API

### `GET /api/health`

```json
{
  "status": "ok",
  "version": "0.1.0",
  "rooms": 2,
  "viewers": 5,
  "roomsCreated": 12,
  "sessionsServed": 30,
  "peakConcurrentViewers": 7,
  "startedAt": 1784700000000,
  "uptimeMs": 3600000
}
```

### `GET /api/config`

前端启动时拉取运行时配置：

```json
{
  "version": "0.2.0",
  "maxViewersPerRoom": 8,
  "roomCodeLength": 6,
  "iceServers": [
    { "urls": ["stun:stun.l.google.com:19302"] },
    { "urls": ["turn:turn.example.com:3478"], "username": "user", "credential": "pass" }
  ],
  "stunUrls": ["stun:stun.l.google.com:19302"],
  "lanHttpUrls": ["http://192.168.31.7:8787"],
  "lanHttpsUrls": []
}
```

- `iceServers`：客户端构建 `RTCPeerConnection` 时使用的完整 ICE 配置（STUN + 可配置的 TURN 中继）。`turnUrls` 为空时仅含 STUN。

### `GET /api/stats`

可观测性接口：服务器运行状态 + 各房间明细（含各类型转发消息计数）。

```json
{
  "status": "ok",
  "version": "0.8.0",
  "rooms": 2,
  "viewers": 5,
  "roomsCreated": 12,
  "sessionsServed": 30,
  "peakConcurrentViewers": 7,
  "messages": { "offer": 40, "answer": 40, "ice": 120, "renegotiate": 0 },
  "startedAt": 1784700000000,
  "uptimeMs": 3600000,
  "roomsDetail": [
    { "room": "ABC-123", "viewers": 3, "viewerIds": ["..."], "createdAt": 1784700000000, "ageMs": 60000 }
  ],
  "turn": { "configured": false, "urls": [], "maxViewersPerRoom": 8 }
}
```

## 生命周期与清理

- 连接断开（含网络异常、心跳超时、页面关闭）视为离开：观看者离开通知主机；主机离开广播 `host-left` 并销毁房间。
- 心跳：服务器每 30s 发一次 WS ping，30s 内无 pong 即断开连接。
- 客户端应在收到 `viewer-left` / `host-left` 后立刻销毁对应 `RTCPeerConnection`。
- 关键生命周期事件以单行 JSON 输出到日志（`room-created` / `viewer-joined` / `viewer-left` / `room-closed`），便于采集。
