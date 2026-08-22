# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)（SemVer），格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

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
