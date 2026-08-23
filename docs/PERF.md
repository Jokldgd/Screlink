# 性能、压力测试与优化设计

## 一、职责边界（哪些能自动化，哪些要真浏览器）

Screlink 的“压力”分布在三层：

| 层 | 承载 | 能否本环境自动测试 |
| --- | --- | --- |
| **信令/转发服务器**（Node） | 房间管理、offer/answer/ice/renegotiate 转发 | ✅ 已做（见下“控制面基准”） |
| **浏览器端**（编码/解码） | 屏幕 VP8/H264 编码、语音 Opus 编码 | ❌ 需真实浏览器（见“媒体面设计”） |
| **TURN/coturn**（公网回传） | 无法 P2P 时的媒体中继带宽 | ⚠️ 部分（见“带宽”小节） |

## 二、控制面基准（自动化，`npm run bench`）

在 `127.0.0.1` 单机实测（2026-08）：

| 场景 | 吞吐 | 延迟 | 备注 |
| --- | --- | --- | --- |
| A 单会话高复杂度（2000 条协商消息） | ≈8400 msg/s | p50 0ms / p95 1ms / p99 1ms | 单会话峰值，亚毫秒转发 |
| B 高并发（3房×6观看者×300条） | ≈11800 msg/s | — | 5400/5400 全部收到 |
| C 同时（高并发 + 加入/离开抖动） | ≈9700 msg/s | — | health 正常，抖动不崩 |
| 内存 | 10.1→14.0 MB | — | 负载下小幅增长，无泄漏爆炸 |

**结论**：信令服务器远不是瓶颈。真实瓶颈在浏览器编码与 TURN 回传带宽。

## 三、媒体面压力测试设计（真实浏览器手测）

以下三项在**真实浏览器**执行（主机 Chrome/Edge，观看端手机流量）。四项建议各跑 **1 分钟**观察。

### 场景 1：画面复杂度高（单独）
1. 主机打开一个**高动态/高细节**内容：例如浏览器全屏播放 4K 视频、或一屏大量滚动文字+图表。
2. 主机选「高」画质共享。
3. 观看端 F12 控制台运行 `getStatsSample()`（见下方代码），记录：
   - `inbound-rtp/video` 的 `framesPerSecond`（实际解码帧率）、`frameWidth/Height`、`bytesReceived`
   - `remote-inbound-rtp` 的 `packetsLost`、`roundTripTime`
4. 主机开 **任务管理器** 看 Chrome 的 CPU；观察是否掉帧（共享帧率 vs 解码帧率差距）。

### 场景 2：语音压力大（单独）
1. 主机播放**大音量、高采样**的音频（如音乐/人声混响），勾选“同时共享系统声音”，画质选「低」（语音场景画面次要）。
2. 观看端记录 `inbound-rtp/audio` 的 `jitter`、`packetsLost`、`concealmentRatio`（PLC 丢包隐藏率，过高=破音）。
3. 观察是否出现明显破音/不同步。

### 场景 3：同时（画面复杂度高 + 语音压力大 + 多观看者）
1. 主机**同时**共享高复杂度画面 + 系统声音，画质「高」，并让 2–3 个观看者同时加入。
2. 同时记录上面 video + audio 的 stats，并看主机 CPU / 上行带宽、观看端是否卡顿。
3. 记录 `getStats` 中的**编码端** `outbound-rtp/video` 的 `qualityLimitationReason`（如 `bandwidth`/`cpu`）与 `qualityLimitationDurations`，判断是被带宽限流还是被 CPU 限流。

### 取样脚本
`getStatsSample` 可粘贴到观看端/主机端 F12 控制台：
```js
async function getStatsSample(pc, sec = 5) {
  const out = {};
  const t0 = performance.now();
  const acc = {};
  while (performance.now() - t0 < sec * 1000) {
    const s = await pc.getStats();
    for (const r of s.values()) {
      if (r.type === "inbound-rtp" && r.kind === "video") {
        acc.fps = r.framesPerSecond; acc.w = r.frameWidth; acc.h = r.frameHeight;
        acc.bytes = r.bytesReceived; acc.loss = r.packetsLost; acc.jitter = r.jitter;
      }
      if (r.type === "inbound-rtp" && r.kind === "audio") {
        acc.ajitter = r.jitter; acc.aloss = r.packetsLost; acc.conceal = r.concealmentRatio;
      }
      if (r.type === "remote-inbound-rtp") acc.rtt = r.roundTripTime;
      if (r.type === "outbound-rtp" && r.kind === "video") acc.limit = r.qualityLimitationReason;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return acc;
}
```
（输出 `acc` 即可，重点看 `fps / loss / rtt / jitter / limit`。）

### 建议验收阈值（首版）
- 共享 30fps 内容时，观看端解码帧率 **≥25fps**；`packetsLost` 占比 **<2%**
- 语音 `jitter` **<50ms**、`concealmentRatio` **<0.05**
- 主机无 `qualityLimitationReason == "cpu"`（若出现，说明编码是瓶颈，见优化）
- ECS 出向带宽 < 实例上限（100Mbps）的 80%

## 四、带宽（TURN 侧）

- **优先 P2P**：STUN 打洞成功就不走 TURN，只有失败才中继（当前实现即如此）。
- ECS 为 **100Mbps**，`3-8Mbps/人` 的 1080p 码率下，建议单房间观看者 **≤6-8** 人；更多走 SFU。
- 监控：ECS `docker stats coturn` 看 CPU/网络；或阿里云监控「出方向带宽」。

## 五、未来优化设计

### 1. 自适应码率/帧率（收益最高）
基于 `RTCPeerConnection` 的 **REMB/TWCC** 与 `getStats()` 的 RTT/丢包，动态下调 `sender.setParameters({ maxBitrate })` 与 `track.applyConstraints({ frameRate })`，而非预设固定档。
- 触发：`packetsLost` 上升或 RTT 增大 → 逐级降档；恢复后再升档（防抖）。
- 已在 v0.6 有 smooth/sharp 档，可再加「自动」档。

### 2. 编码器与内容感知
屏幕共享常是静止文本（省 CPU 可用低帧率+detail），或高动态（需高帧率）。
- 用 `RTCRtpSender` 的 `contentHint`（`"detail"`/`"motion"`）提示编码器取向（v0.6 smooth/sharp 已部分利用）。
- 高复杂度画面优先 VP9/AV1（压缩率更高，减少上行带宽），兼容握手用 VP8 兜底。当前为兼容强制 VP8/H264，可做“按观看者网络/数量”切换。

### 3. SFU 转发（架构级，多人/语音刚需）
当前 **mesh**：主机上行随观看者数线性增长（多人时主机是瓶颈）。
- 引入 **mediasoup / Janus**，主机只推一次，SFU 扇出到各观看者；支持 **Simulcast**（多分辨率）让观看端按带宽切换。
- 对“语音压力大 + 多人”最有效：音频流小，SFU 可承载大量上行；视频则解决主机上行瓶颈。
- 需信令扩展（SFU 侧的 offer/answer 以 SFU 为中心）。

### 4. 音频链路
- 语音用 Opus **inband FEC** 与 **DTX**（静音不传码），降低弱网破音与带宽。
- 增加接受端 **jitter buffer** 与 **PLC**（已在浏览器内置，实测 concealment 控制）。

### 5. 可观测性
- 扩展 `/api/health` / 新增 `/api/stats`：每房间观看者数、连接数、TURN 带宽估算、转发消息计数。
- 结构化日志（JSON）便于云端采集；主动告警（如并发超阈值）。

### 6. 浏览器端压力分布
- 编码是 CPU 大户：对静止内容降帧率（省 CPU），对高动态才升帧率。
- 可加“性能模式”开关（画质 vs 流畅），对应降低分辨率/帧率。

## 六、落地优先级建议

1. **自适应码率/帧率**（改最小，收益最大）
2. **SFU**（多人/语音刚需，架构级，改动大）
3. 内容感知编码 + 音频 FEC/DTX
4. 可观测性
