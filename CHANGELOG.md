# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)（SemVer），格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.5.1] - 2026-08-22

### 修复

- **修复页面加载即崩溃（点击标签无反应）**：`state` 初始化时引用了其后才声明的 `const QUALITY`，导致 TDZ 的 `ReferenceError`，整个前端 JS 失效。改为在启动共享时才设置画质档位
- 前端测试新增**运行时加载校验**（vm + DOM 桩执行 app.js 顶层），可捕获 `node --check` 发现不了的 TDZ/初始化错误

## [0.5.0] - 2026-08-22

### 新增

- **推流画质档位**：主机侧新增「自动 / 高 / 中 / 低」选择，通过帧率约束与 `RTCRtpSender.setParameters` 码率上限控制推流质量与流量
- **观看端断线自动重连**：连接 `failed`/`disconnected` 时，观看者向主机发送 `renegotiate`，主机重建 PeerConnection 并重新协商；`disconnected` 带 2.5s 防抖避免瞬时抖动反复重连

### 变更

- 信令协议新增 `renegotiate` 消息（观看者 → 主机），详见 docs/PROTOCOL.md
- 主机侧抽取 `setupViewerPc`/`applyMaxBitrate`，新加入与重连复用同一建立流程

## [0.4.0] - 2026-08-22

### 新增

- **观看端控制条**：音量滑块（可调 0–100%）、静音/取消静音按钮、全屏按钮
- 支持全屏切换（含 WebKit/MS 前缀兼容），全屏状态跟随系统事件更新
- 自动播放被拦截时同步静音图标；音量>0 时自动取消静音

### 变更

- 观看端 `unmute-btn` 位置调整为右上角，避免与底部控制条重叠

## [0.3.0] - 2026-08-22

### 新增

- **同时监听 HTTP(8787) + HTTPS(8788)**：`npm start` 即可同时对外提供页面/信令（HTTP）与主机共享所需的 HTTPS 安全上下文（自签名证书），不再需要二选一
- **无域名 / IP 直连模式**：新增 `docker-compose.ip.yml`，用公网 IP + 非标端口部署，**免 ICP 备案**（观看者 `http://IP:8787`，主机共享 `https://IP:8788`，媒体走 coturn）
- 部署文档区分「IP 模式」与「域名模式」两条路径

### 变更

- 服务端始终创建 HTTP+HTTPS 双监听（`npm start` 自动生成自签名证书）
- 冒烟测试适配新的服务初始化

## [0.2.0] - 2026-08-22

### 新增

- **TURN 中继支持**：通过环境变量 `SCRELINK_TURN`（逗号分隔的 `turn:` 地址）、`SCRELINK_TURN_USER`、`SCRELINK_TURN_PASS` 配置，服务端经 `/api/config` 下发给两端；WebRTC 在 STUN 打洞失败时自动改用 TURN 中继，为跨公网观看铺路
- `/api/config` 新增 `iceServers` 字段（STUN + 可选 TURN 的完整 ICE 配置）
- README 增加 TURN / coturn 部署说明与配置项

### 变更

- 客户端 WebRTC 由 `stunUrls` 改用完整的 `iceServers` 配置

## [0.1.2] - 2026-08-22

### 修复

- 静态资源缓存策略改为 `no-cache`：消除浏览器缓存旧版页面/JS 导致的黑屏排查困扰（前端零构建，无缓存收益）

## [0.1.1] - 2026-08-22

### 修复

- **修复 Windows 上观看端黑屏**：主机端将视频编码器限定为 VP8 / H.264，规避 Chromium 内核协商到 VP9/AV1 时硬件解码异常导致的画面全黑
- 观看端 `ontrack` 增加 `streams[0]` 兜底与显式 `play()`：自动播放被浏览器拦截时静音出画面并显示「开启声音」按钮
- 状态文案区分「正在连接 / 已连接等待画面 / 正在播放（含分辨率）/ 连接失败」，便于定位问题

### 新增

- 控制台调试日志（`[screlink]` 前缀）与观看页诊断工具：F12 运行 `__screlinkDebug()` 查看连接与视频状态

## [0.1.0] - 2026-08-22

### 新增

- **屏幕共享核心链路**：主机通过 `getDisplayMedia` 捕获屏幕，经 WebRTC 点对点推流给观看者
- **房间机制**：主机创建房间获得 6 位无歧义房间号（`XXX-XXX` 格式），观看者凭房间号或链接加入
- **多人观看**：单个房间最多 8 名观看者（可配置），主机与每人建立独立 P2P 连接（星形拓扑）
- **系统声音共享**：可选同时共享系统声音
- **信令服务器**：Node.js + WebSocket，房间管理、offer/answer/ICE 转发、心跳检测、异常断开清理
- **单页 Web 前端**：深色主题 UI，共享/观看双模式，分享链接自动生成与复制，`#room=` 链接自动加入
- **HTTPS 模式**：`npm run start:https` 自动生成自签名证书（SAN 含局域网 IP），满足屏幕捕获的安全上下文要求
- **HTTP API**：`GET /api/health`（状态/版本/统计）、`GET /api/config`（前端运行时配置）
- **冒烟测试**：`npm test` 覆盖建房间、加入、多人、信令双向转发、离开/关闭通知、错误码
- **文档**：README、架构说明（ARCHITECTURE.md）、信令协议（PROTOCOL.md）

[0.1.0]: https://github.com/Jokldgd/Screlink/releases/tag/v0.1.0
