/**
 * 控制面压力基准：量化信令/转发服务器在“高复杂度 + 高并发 + 同时”下的能力。
 * 注意：媒体流（视频/音频编码质量、实际码率）发生在浏览器端与 TURN，本基准测量的是
 *      服务器负责的信令转发面的吞吐与延迟（代理高画面复杂度/高语音流量产生的控制消息压力）。
 * 运行：npm run bench
 */
import { once } from "node:events";
import WebSocket from "ws";
import { createApp } from "../server/app.js";

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

class Client {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.messages = [];
    this.waiters = [];
    this.open = once(this.ws, "open");
    this.closed = false;
    this.ws.on("message", (d) => {
      const msg = JSON.parse(d.toString());
      this.messages.push(msg);
      for (const w of [...this.waiters]) if (w.pred(msg)) { w.resolve(msg); this.waiters = this.waiters.filter((x) => x !== w); }
    });
    this.ws.on("close", () => { this.closed = true; });
  }
  send(m) { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m)); }
  close() { this.ws.close(); }
  async waitFor(pred, t = 6000) {
    const hit = this.messages.find(pred);
    if (hit) return hit;
    return new Promise((res, rej) => {
      const w = { pred, resolve: res };
      this.waiters.push(w);
      setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); rej(new Error("timeout")); }, t);
    });
  }
}

const main = async () => {
  console.log("== Screlink 控制面压力基准 ==");
  const app = createApp();
  app.httpServer.listen(0, "127.0.0.1");
  await once(app.httpServer, "listening");
  const port = app.httpServer.address().port;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;
  const base = `http://127.0.0.1:${port}`;
  const mem0 = process.memoryUsage().heapUsed;

  async function openRoom() {
    const host = new Client(wsUrl); await host.open;
    host.send({ type: "create" });
    const created = await host.waitFor((m) => m.type === "created");
    return { host, room: created.room };
  }
  async function openViewer(room) {
    const v = new Client(wsUrl); await v.open;
    v.send({ type: "join", room });
    await v.waitFor((m) => m.type === "joined");
    return v;
  }

  // ===== 场景 A：单会话高复杂度（大量 ICE/协商消息，代理画面复杂度高的控制面） =====
  {
    const { host, room } = await openRoom();
    const v = await openViewer(room);
    const N = 2000, lat = [];
    const t0 = Date.now();
    for (let i = 0; i < N; i++) {
      const ts = Date.now();
      // 时间戳放进 candidate（服务器 relay 会转发 candidate）
      v.send({ type: "ice", candidate: { ts } });
      await host.waitFor((m) => m.type === "ice" && m.candidate?.ts === ts);
      lat.push(Date.now() - ts);
    }
    const dt = Date.now() - t0;
    console.log(`[A] 单会话高复杂度 (N=${N}): 吞吐 ${(N / (dt / 1000)).toFixed(0)} msg/s, p50=${pct(lat,50)}ms p95=${pct(lat,95)}ms p99=${pct(lat,99)}ms`);
    host.close(); v.close();
  }

  // ===== 场景 B：高并发（多房间 × 多观看者，代理大量并发的音频/媒体会话） =====
  {
    const ROOMS = 3, VIEWERS = 6, M = 300; // 每个观看者并发打 M 条
    const rooms = [];
    for (let i = 0; i < ROOMS; i++) {
      const { host, room } = await openRoom();
      const viewers = [];
      for (let j = 0; j < VIEWERS; j++) viewers.push(await openViewer(room));
      rooms.push({ host, viewers });
    }
    const total = ROOMS * VIEWERS * M;
    let received = 0;
    const expected = new Map();
    // 每个观看者打 M 条带 ts 的 ice
    const t0 = Date.now();
    for (const { viewers } of rooms) {
      for (const v of viewers) {
        for (let i = 0; i < M; i++) v.send({ type: "ice", ts: t0 + i });
      }
    }
    // 统计主机收到的 ice 总数
    while (received < total) {
      received = 0;
      for (const { host } of rooms) {
        received += host.messages.filter((m) => m.type === "ice").length;
      }
      if (Date.now() - t0 > 10000) break; // 兜底
      await new Promise((r) => setTimeout(r, 50));
    }
    const dt = Date.now() - t0;
    console.log(`[B] 高并发 ${ROOMS}房×${VIEWERS}人×${M}条: 收到 ${received}/${total}, 吞吐 ${(received / (dt / 1000)).toFixed(0)} msg/s`);
    for (const { host, viewers } of rooms) { host.close(); for (const v of viewers) v.close(); }
  }

  // ===== 场景 C：同时（高并发 + 加入/离开抖动 + 新建房间） =====
  {
    const ROOMS = 2, VIEWERS = 6, M = 300, CHURN = 12;
    const rooms = [];
    const t0 = Date.now();
    for (let i = 0; i < ROOMS; i++) {
      const { host, room } = await openRoom();
      const viewers = [];
      for (let j = 0; j < VIEWERS; j++) viewers.push(await openViewer(room));
      rooms.push({ host, viewers });
    }
    // 并发抖动：额外观看者反复加入/离开 + 新建一个房间再关闭
    const churnJobs = [];
    for (let i = 0; i < CHURN; i++) {
      churnJobs.push((async () => {
        const { host, room } = await openRoom();
        const v = await openViewer(room);
        v.close(); host.close();
      })());
    }
    const total = ROOMS * VIEWERS * M;
    for (const { viewers } of rooms) {
      for (const v of viewers) for (let i = 0; i < M; i++) v.send({ type: "ice", ts: t0 + i });
    }
    let received = 0;
    while (received < total || churnJobs.some(() => false)) {
      received = 0;
      for (const { host } of rooms) received += host.messages.filter((m) => m.type === "ice").length;
      if (Date.now() - t0 > 10000) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await Promise.all(churnJobs);
    const dt = Date.now() - t0;
    const health = await fetch(`${base}/api/health`).then((r) => r.json());
    console.log(`[C] 同时(高并发+抖动): 收到 ${received}/${total}, 吞吐 ${(received / (dt / 1000)).toFixed(0)} msg/s, health rooms=${health.rooms} viewers=${health.viewers}`);
    for (const { host, viewers } of rooms) { host.close(); for (const v of viewers) v.close(); }
  }

  const mem1 = process.memoryUsage().heapUsed;
  console.log(`[内存] heapUsed: ${(mem0 / 1024 / 1024).toFixed(1)}MB -> ${(mem1 / 1024 / 1024).toFixed(1)}MB`);
  app.httpServer.close();
  console.log("\n  基准完成");
  process.exit(0);
};

main().catch((e) => { console.error("BENCH FAILED:", e.message); process.exit(1); });
