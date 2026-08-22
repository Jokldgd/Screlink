# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)（SemVer），格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

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
