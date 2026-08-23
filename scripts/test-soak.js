/**
 * 负载/压力测试：多批次观看者反复加入/离开，验证并发稳定性与资源回收。
 * 运行：npm run test:soak
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";
import { createApp } from "../server/app.js";

let passed = 0;
const ok = (name) => { passed++; console.log(`  ok - ${name}`); };

class Client {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.messages = [];
    this.waiters = [];
    this.open = once(this.ws, "open");
    this.ws.on("message", (d) => {
      const msg = JSON.parse(d.toString());
      this.messages.push(msg);
      for (const w of [...this.waiters]) if (w.pred(msg)) { w.resolve(msg); this.waiters = this.waiters.filter((x) => x !== w); }
    });
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  close() { this.ws.close(); }
  async waitFor(pred, t = 4000) {
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
  console.log("== Screlink 负载/压力测试 ==");
  const app = createApp();
  app.httpServer.listen(0, "127.0.0.1");
  await once(app.httpServer, "listening");
  const port = app.httpServer.address().port;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;
  const base = `http://127.0.0.1:${port}`;

  const host = new Client(wsUrl); await host.open;
  host.send({ type: "create" });
  const created = await host.waitFor((m) => m.type === "created");
  const room = created.room;

  const ROUNDS = 3, EACH = 6; // 每批并发 ≤ 房间上限 8
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  for (let round = 0; round < ROUNDS; round++) {
    const batch = [];
    for (let i = 0; i < EACH; i++) {
      const c = new Client(wsUrl); await c.open;
      c.send({ type: "join", room });
      await c.waitFor((m) => m.type === "joined");
      batch.push(c);
    }
    // 全部离开
    for (const c of batch) c.close();
    await sleep(200);
    const health = await fetch(`${base}/api/health`).then((r) => r.json());
    assert.equal(health.viewers, 0, `第${round + 1}轮后 watching 应收敛到 0`);
  }

  ok(`${ROUNDS} 轮 × ${EACH} 并发加入/离开后，服务仍在且 viewers=0`);

  // 主机仍可用：再加入一个观看者验证还能收到 viewer-joined
  const v = new Client(wsUrl); await v.open;
  v.send({ type: "join", room });
  await v.waitFor((m) => m.type === "joined");
  await host.waitFor((m) => m.type === "viewer-joined");
  ok("负载后主机仍能接收新观看者");

  const health2 = await fetch(`${base}/api/health`).then((r) => r.json());
  assert.ok(health2.rooms >= 1, "房间仍在（主机在线）");

  v.close(); host.close();
  app.httpServer.close();
  console.log(`\n  ${passed} soak assertions passed - all good`);
  process.exit(0);
};

main().catch((err) => { console.error("\n  SOAK FAILED:", err.message); process.exit(1); });
