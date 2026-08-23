# SFU 迁移设计（LiveKit）

> 目标：用 SFU（Selective Forwarding Unit）替代当前 **mesh（星形）** 拓扑，解决「多人同时观看时主机上行/CPU 瓶颈 → 卡顿」，并支持更多观看者与更好的清晰度分配。

## 一、为什么从 mesh 迁到 SFU

| 维度 | mesh（现状） | SFU（LiveKit） |
| --- | --- | --- |
| 主机上行 | 观看者数 × 单路码率（5 人≈40Mbps） | **一路**（固定） |
| 主机 CPU | 为每个观看者各编一路 | **一路编码（Simulcast 可多档）** |
| 多观看者清晰度 | 人越多人均码率越低 | 按观看者带宽/画质自动选 Simulcast 档 |
| 可扩展观看者 | ~6-8 人 | 数十人+ |
| 断线/多分辨率/重连 | 自研 | LiveKit 内置 |

## 二、选型：LiveKit（推荐）

- **开箱即用的 SFU**：Simulcast/SVC、多分辨率、重连、规模扩展均由 LiveKit 承担。
- **客户端 SDK 成熟**（`livekit-client` 浏览器 SDK），与现有前端接入成本可控。
- **自建部署**：Go 单二进制/Docker 镜像，可跑在现有 ECS；配合 Screlink 的 Node 信令做房间与鉴权。
- 备选：`mediasoup`（Node 原生但底层复杂）、`SRS`（偏流模型）。本方案默认 LiveKit。

## 三、总体架构

```
 主机浏览器                          LiveKit SFU                        观看者浏览器
 getDisplayMedia ──publish──►  [room: <房间号>]  ──subscribe──►  按带宽选 Simulcast 档
   (一路, Simulcast)                ▲ 扇出给所有观看者              (各拿合适清晰度)
                                    │
          Screlink Node 信令：房间号创建/校验、LiveKit 房间名映射、存取 token
          （现有 WS 信令保留；媒体面交给 LiveKit）
                                    │
                              coturn（NAT 穿透，保留）
```

- **Screlink 负责**：房间号（`XXX-XXX`）创建/校验、观看者加入校验、生成并分发 LiveKit 访问 token、把自己房间号 ↔ LiveKit 房间名（如 `room-<code>`）映射。
- **LiveKit 负责**：媒体路由（SFU 扇出）、Simulcast 多档、订阅按带宽、断线重连、TURN 打洞（可配 coturn）。

## 四、数据面流程

1. **主机**打开 `https://...:8788` → 建房得到房间号 → 向 Screlink 后端申请一个 **LiveKit 发布 token** → `getDisplayMedia` → 用 `livekit-client` `room.localParticipant.publishTrack(track)`（一路，可开 Simulcast）。
2. **观看者**打开 `http://...:8787` 输房间号 → Screlink 校验 → 发一个 **订阅 token** → 用 `livekit-client` 加入 `room-<code>` → `remoteParticipant.trackPublications` → `subscribe` → 播放。
3. LiveKit 自动为观看者选择合适 Simulcast 档位（可结合观看端清晰度选择）。

## 五、部署（在 `docker-compose.ip.yml` 基础上加 LiveKit）

新增 `docker-compose.sfu.yml`（screlink + coturn + livekit），及 `deploy/livekit.yaml`。

- 端口：LiveKit `7880`(WS/TCP)、`7881`(UDP 防火墙看传输)、`50000-50020`(UDP，可调)；配合 coturn。
- LiveKit 配置要点：`rtc.port_range_start/stop`（UDP 中继段，云防火墙放行）、`rtc.use_external_ip`、`turn.port_range` 关联 coturn。
- Screlink 后端新增 `GET /api/livekit/token`（发布/订阅分别签发），需要 `LIVEKIT_API_KEY/SECRET` 环境变量。

## 六、前端接入要点

- 引入 `livekit-client` SDK（`import { Room, Track } from 'livekit-client'`）。
- **主机**：`const room = new Room(); await room.connect(url, token); await room.localParticipant.publishTrack(await getDisplayMedia(...), { simulcast: true })`。
- **观看者**：`const room = new Room(); await room.connect(url, token); room.on(TrackEvent.TrackSubscribed, (track, pub, participant) => { attach to video })`。
- 保持 Screlink 现有 UI：加入观看/共享屏幕 tab、房间号、清晰度选择、音量/全屏、诊断 `__screlinkDebug()`。
- 画质：720p 为基线；Simulcast 让观看者按带宽取 360/720/1080 档。

## 七、分阶段落地

### Phase 1 — 跑通基本 SFU
- [ ] ECS 部署 LiveKit（compose + livekit.yaml + 防火墙端口）
- [ ] Screlink 后端：LiveKit 房间映射 + `/api/livekit/token`
- [ ] 前端：主机 publish（720p 单档）、观看者 subscribe（浏览器验收）
- [ ] 端到端：1 主机 → N 观看者，主机上行保持一路

### Phase 2 — 清晰度与规模
- [ ] 开启 Simulcast 多档（360/720/1080）
- [ ] 观看端清晰度选择接入 LiveKit 层级
- [ ] 自适应码率交由 LiveKit/浏览器层（保留 Screlink 侧简化的探针）
- [ ] 多人（≥10）实测

### Phase 3 — 语音（可选）
- [ ] v0.7.1 语音并入 LiveKit（统一音视频房间）

## 八、风险与注意

- **本环境无法自动验证 WebRTC 媒体**：SFU 的媒体链路需在真实浏览器端到端验收（见每阶段 checklist）。
- LiveKit 需要正确的 `LIVEKIT_API_KEY/SECRET` 与防火墙 UDP 段；安全组放行 `7880/7881/50000-50020`。
- 迁移期保留 mesh 实现作为 fallback；确认 SFU 稳定后再切默认。
- 国内自建 LiveKit：UDP 中继段需放行，且建议 LiveKit 与 coturn 协同打洞。

## 九、验收清单（Phase 1，真实浏览器）
1. 主机开 `https://...:8788` 共享 → 手机/电脑各加入 → 都能看到画面
2. 主机上行稳定「一路」（ECS 监控 / LiveKit 面板或 `docker stats`）
3. 6-8 人同时观看不再卡顿（主机预览不卡）
4. 观看端清晰度/音量/全屏仍可用
