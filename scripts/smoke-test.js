/**
 * 冒烟测试：验证 HTTP API 与信令协议的核心流程。
 * 运行：npm test
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createRequire } from "node:module";
import WebSocket from "ws";
import { createApp } from "../server/app.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

let passed = 0;
const ok = (name) => {
  passed++;
  console.log(`  ok - ${name}`);
};

/** 测试用信令客户端：收消息入队，可按条件等待 */
class Client {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.messages = [];
    this.waiters = [];
    this.open = once(this.ws, "open");
    this.ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      this.messages.push(msg);
      for (const w of [...this.waiters]) {
        if (w.pred(msg)) {
          w.resolve(msg);
          this.waiters = this.waiters.filter((x) => x !== w);
        }
      }
    });
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  async waitFor(pred, timeoutMs = 3000) {
    const hit = this.messages.find(pred);
    if (hit) return hit;
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error("timeout waiting for signaling message"));
      }, timeoutMs);
    });
  }

  close() {
    this.ws.close();
  }
}

const main = async () => {
  console.log("Screlink smoke test");

  // ---- 启动临时服务（0 端口） ----
  const app = createApp({ https: false });
  app.httpServer.listen(0, "127.0.0.1");
  await once(app.httpServer, "listening");
  const port = app.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;
  ok(`server started on :${port}`);

  // ---- 静态页面 ----
  const page = await fetch(`${base}/`).then((r) => r.text());
  assert.ok(page.includes("Screlink"), "index.html 可访问");
  // 编码形式的目录穿越（%2e%2e%2F = ../）：应被拦截为 403 而非读出文件
  const traversal = await fetch(`${base}/%2e%2e%2F%2e%2e%2Fpackage.json`).then((r) => r.status);
  assert.equal(traversal, 403, "目录穿越被拦截");
  ok("static file & traversal guard");

  // ---- 健康检查 / 配置 ----
  const health = await fetch(`${base}/api/health`).then((r) => r.json());
  assert.equal(health.status, "ok");
  assert.equal(health.version, pkg.version, "版本号与 package.json 一致");
  const cfg = await fetch(`${base}/api/config`).then((r) => r.json());
  assert.equal(cfg.version, pkg.version);
  assert.ok(cfg.stunUrls.length > 0);
  ok("health & config API");

  // ---- 建房间 ----
  const host = new Client(`ws://127.0.0.1:${port}/ws`);
  await host.open;
  host.send({ type: "create" });
  const created = await host.waitFor((m) => m.type === "created");
  assert.match(created.room, /^[A-Z2-9]{3}-[A-Z2-9]{3}$/, "房间号格式 XXX-XXX");
  assert.ok(created.peerId);
  ok(`room created: ${created.room}`);

  // 重复 create 应报错
  host.send({ type: "create" });
  const dup = await host.waitFor((m) => m.type === "error");
  assert.equal(dup.code, "already-in-room");
  ok("duplicate create rejected");

  // ---- 观看者 1 加入 ----
  const v1 = new Client(`ws://127.0.0.1:${port}/ws`);
  await v1.open;
  v1.send({ type: "join", room: created.room });
  const joined1 = await v1.waitFor((m) => m.type === "joined");
  assert.equal(joined1.room, created.room);
  const vj1 = await host.waitFor((m) => m.type === "viewer-joined" && m.peerId === joined1.peerId);
  assert.equal(vj1.viewerCount, 1);
  ok("viewer joined (host notified)");

  // ---- 信令中继：观看者 -> 主机 offer ----
  v1.send({ type: "offer", to: "ignored-by-protocol", sdp: { type: "offer", sdp: "sdp-from-v1" } });
  const offerAtHost = await host.waitFor((m) => m.type === "offer" && m.from === joined1.peerId);
  assert.equal(offerAtHost.sdp.sdp, "sdp-from-v1");
  ok("offer relayed viewer -> host");

  // ---- 信令中继：主机 -> 观看者 answer ----
  host.send({ type: "answer", to: joined1.peerId, sdp: { type: "answer", sdp: "sdp-from-host" } });
  const answerAtV1 = await v1.waitFor((m) => m.type === "answer" && m.from === created.peerId);
  assert.equal(answerAtV1.sdp.sdp, "sdp-from-host");
  ok("answer relayed host -> viewer");

  // ---- ICE 双向 ----
  v1.send({ type: "ice", candidate: { candidate: "c:v1" } });
  const iceAtHost = await host.waitFor((m) => m.type === "ice" && m.from === joined1.peerId);
  assert.deepEqual(iceAtHost.candidate, { candidate: "c:v1" });
  host.send({ type: "ice", to: joined1.peerId, candidate: { candidate: "c:h" } });
  const iceAtV1 = await v1.waitFor((m) => m.type === "ice" && m.from === created.peerId);
  assert.deepEqual(iceAtV1.candidate, { candidate: "c:h" });
  ok("ICE candidates relayed both ways");

  // ---- 观看者 2 加入（多人） ----
  const v2 = new Client(`ws://127.0.0.1:${port}/ws`);
  await v2.open;
  v2.send({ type: "join", room: created.room });
  const joined2 = await v2.waitFor((m) => m.type === "joined");
  const vj2 = await host.waitFor((m) => m.type === "viewer-joined" && m.peerId === joined2.peerId);
  assert.equal(vj2.viewerCount, 2);
  ok("second viewer joined (multi-viewer)");

  // ---- 观看者 1 离开 ----
  v1.close();
  const left = await host.waitFor((m) => m.type === "viewer-left" && m.peerId === joined1.peerId);
  assert.equal(left.viewerCount, 1);
  ok("viewer-left notified to host");

  // ---- 不存在的房间 ----
  const ghost = new Client(`ws://127.0.0.1:${port}/ws`);
  await ghost.open;
  ghost.send({ type: "join", room: "ZZZ-999" });
  const err = await ghost.waitFor((m) => m.type === "error");
  assert.equal(err.code, "room-not-found");
  ok("room-not-found rejected");

  // ---- 主机离开 => 房间关闭 ----
  host.close();
  const closed = await v2.waitFor((m) => m.type === "host-left");
  assert.ok(closed.reason);
  ok("host-left broadcast, room closed");

  // 房间已不存在
  const late = new Client(`ws://127.0.0.1:${port}/ws`);
  await late.open;
  late.send({ type: "join", room: created.room });
  const err2 = await late.waitFor((m) => m.type === "error");
  assert.equal(err2.code, "room-not-found");
  ok("closed room unavailable");

  // ---- 收尾 ----
  ghost.close(); late.close(); v2.close();
  app.httpServer.close();
  console.log(`\n  ${passed} assertions passed - all good`);
  process.exit(0);
};

main().catch((err) => {
  console.error("\n  SMOKE TEST FAILED:", err.message);
  process.exit(1);
});
