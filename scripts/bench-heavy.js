/**
 * 高强度压测：逐级加压，找出信令/转发服务器的真实上限（丢包、延迟、内存）。
 * 相对 bench.js 更高并发 + 并发抖动，用于“探顶”。
 * 运行：node scripts/bench-heavy.js
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
  async waitFor(pred, t = 8000) {
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
  console.log("== Screlink 高强度探顶压测 ==");
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

  // 单个房间内：V 个观看者各自打 M 条 ice，主机统计收到数 + 抽一个往返延迟
  async function tier(label, ROOMS, VIEWERS, M) {
    const rooms = [];
    const t0 = Date.now();
    for (let i = 0; i < ROOMS; i++) {
      const { host, room } = await openRoom();
      const viewers = [];
      for (let j = 0; j < VIEWERS; j++) viewers.push(await openViewer(room));
      rooms.push({ host, viewers });
    }
    const total = ROOMS * VIEWERS * M;
    for (const { viewers } of rooms) {
      for (const v of viewers) for (let i = 0; i < M; i++) v.send({ type: "ice", ts: i });
    }
    let received = 0, dt = Date.now() - t0;
    while (received < total && Date.now() - t0 < 20000) {
      received = 0;
      for (const { host } of rooms) received += host.messages.filter((m) => m.type === "ice").length;
      await new Promise((r) => setTimeout(r, 50));
    }
    dt = Date.now() - t0;
    const lossPct = ((total - received) / total * 100).toFixed(2);

    // 延迟探针：在第一个房间的第一个观看者上做 100 次往返
    let lat = [];
    if (rooms[0]) {
      const host = rooms[0].host, v = rooms[0].viewers[0];
      for (let i = 0; i < 100; i++) {
        const ts = Date.now();
        v.send({ type: "ice", candidate: { ts } });
        await host.waitFor((m) => m.type === "ice" && m.candidate?.ts === ts);
        lat.push(Date.now() - ts);
      }
    }
    const spd = (received / (dt / 1000)).toFixed(0);
    const health = await fetch(`${base}/api/health`).then((r) => r.json()).catch(() => null);
    console.log(`[${label}] ${ROOMS}房×${VIEWERS}人×${M}条: 收到 ${received}/${total} (丢包 ${lossPct}%), 吞吐 ~${spd} msg/s, 延迟 p50=${pct(lat,50)}ms p95=${pct(lat,95)}ms p99=${pct(lat,99)}ms, health rooms=${health?.rooms} viewers=${health?.viewers}`);
    for (const { host, viewers } of rooms) { host.close(); for (const v of viewers) v.close(); }
    await new Promise((r) => setTimeout(r, 200));
  }

  // 并发抖动：大量房间同时开/关 + 观看者进出
  async function churn(n) {
    const jobs = [];
    for (let i = 0; i < n; i++) {
      jobs.push((async () => {
        const { host, room } = await openRoom();
        const v = await openViewer(room);
        v.close(); host.close();
      })());
    }
    await Promise.all(jobs);
  }

  await tier("T1", 4, 6, 400);
  await tier("T2", 8, 8, 400);
  console.log("  --- 开始并发抖动 ---");
  await churn(30);
  console.log("  --- 抖动结束，继续加压 ---");
  await tier("T3(高并发+抖动后)", 12, 8, 400);
  await tier("T4(极限)", 20, 8, 300);

  const mem1 = process.memoryUsage().heapUsed;
  console.log(`[内存] heapUsed: ${(mem0 / 1024 / 1024).toFixed(1)}MB -> ${(mem1 / 1024 / 1024).toFixed(1)}MB`);
  app.httpServer.close();
  console.log("\n  高压探顶完成");
  process.exit(0);
};

main().catch((e) => { console.error("BENCH-HEAVY FAILED:", e.message); process.exit(1); });
