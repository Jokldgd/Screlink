/**
 * 协议集成测试：覆盖房间生命周期、多路转发、重连消息、错误码、并发与隔离。
 * 运行：npm run test:protocol
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createRequire } from "node:module";
import WebSocket from "ws";
import { createApp } from "../server/app.js";
import { config } from "../server/config.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

let passed = 0;
const ok = (name) => {
  passed++;
  console.log(`  ok - ${name}`);
};

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
        if (w.pred(msg)) { w.resolve(msg); this.waiters = this.waiters.filter((x) => x !== w); }
      }
    });
  }
  send(msg) { this.ws.send(JSON.stringify(msg)); }
  close() { this.ws.close(); }
  async waitFor(pred, timeoutMs = 4000) {
    const hit = this.messages.find(pred);
    if (hit) return hit;
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error("timeout waiting: " + JSON.stringify({})));
      }, timeoutMs);
    });
  }
}

const main = async () => {
  console.log("== Screlink 协议集成测试 ==");
  const app = createApp();
  app.httpServer.listen(0, "127.0.0.1");
  await once(app.httpServer, "listening");
  const port = app.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;

  // ---------- HTTP API ----------
  const health = await fetch(`${base}/api/health`).then((r) => r.json());
  assert.equal(health.status, "ok");
  assert.equal(health.version, pkg.version);
  ok("health ok, version matches");

  const cfg = await fetch(`${base}/api/config`).then((r) => r.json());
  assert.ok(Array.isArray(cfg.iceServers) && cfg.iceServers.length > 0);
  assert.equal(cfg.iceServers[0].urls[0], "stun:stun.l.google.com:19302");
  assert.ok(cfg.sfu && typeof cfg.sfu.enabled === "boolean", "config 含 sfu 字段");
  ok("config iceServers has STUN + sfu field");

  // SFU token 接口（默认未配置 LiveKit 时应返回 501）
  const tok = await fetch(`${base}/api/livekit/token?room=ABC-123&role=publisher`).then((r) => r.json());
  assert.equal(tok.error, "sfu-not-configured");
  ok("livekit/token returns sfu-not-configured when not enabled");

  const index = await fetch(`${base}/`).then((r) => r.text());
  assert.ok(index.includes("Screlink"));
  assert.equal(await fetch(`${base}/%2e%2e%2F%2e%2e%2Fpackage.json`).then((r) => r.status), 403);
  assert.equal(await fetch(`${base}/nope`).then((r) => r.status), 404);
  ok("static index / traversal / 404");

  // ---------- 建房间 ----------
  const host = new Client(wsUrl); await host.open;
  host.send({ type: "create" });
  const created = await host.waitFor((m) => m.type === "created");
  const room = created.room;
  assert.match(room, /^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
  ok(`create room ${room}`);

  host.send({ type: "create" });
  assert.equal((await host.waitFor((m) => m.type === "error")).code, "already-in-room");
  ok("duplicate create rejected");

  // ---------- 不存在的房间 ----------
  const ghost = new Client(wsUrl); await ghost.open;
  ghost.send({ type: "join", room: "ZZZ-999" });
  assert.equal((await ghost.waitFor((m) => m.type === "error")).code, "room-not-found");
  ok("room-not-found");
  ghost.close();

  // ---------- 观看者1 加入 ----------
  const v1 = new Client(wsUrl); await v1.open;
  v1.send({ type: "join", room });
  const joined1 = await v1.waitFor((m) => m.type === "joined");
  const vj1 = await host.waitFor((m) => m.type === "viewer-joined" && m.peerId === joined1.peerId);
  assert.equal(vj1.viewerCount, 1);
  ok("viewer1 joined (host notified), viewerCount=1");

  // 重复 join 拒绝（同一连接）
  v1.send({ type: "join", room });
  assert.equal((await v1.waitFor((m) => m.type === "error")).code, "already-in-room");
  ok("duplicate join rejected");

  // ---------- 双向信令转发 ----------
  v1.send({ type: "offer", to: "x", sdp: { type: "offer", sdp: "sdp-v1" } });
  const offerAtHost = await host.waitFor((m) => m.type === "offer" && m.from === joined1.peerId);
  assert.equal(offerAtHost.sdp.sdp, "sdp-v1");
  host.send({ type: "answer", to: joined1.peerId, sdp: { type: "answer", sdp: "sdp-host" } });
  const answerAtV1 = await v1.waitFor((m) => m.type === "answer" && m.from === created.peerId);
  assert.equal(answerAtV1.sdp.sdp, "sdp-host");
  v1.send({ type: "ice", candidate: { candidate: "c:1" } });
  assert.deepEqual((await host.waitFor((m) => m.type === "ice" && m.from === joined1.peerId)).candidate, { candidate: "c:1" });
  host.send({ type: "ice", to: joined1.peerId, candidate: { candidate: "c:h" } });
  assert.deepEqual((await v1.waitFor((m) => m.type === "ice" && m.from === created.peerId)).candidate, { candidate: "c:h" });
  ok("offer/answer/ice relayed both ways");

  // ---------- 重连消息（renegotiate）观看者->主机 ----------
  v1.send({ type: "renegotiate" });
  const renego = await host.waitFor((m) => m.type === "renegotiate" && m.from === joined1.peerId);
  ok("renegotiate relayed viewer->host");

  // ---------- 观看者2 加入（多人 + 隔离） ----------
  const v2 = new Client(wsUrl); await v2.open;
  v2.send({ type: "join", room });
  const joined2 = await v2.waitFor((m) => m.type === "joined");
  const vj2 = await host.waitFor((m) => m.type === "viewer-joined" && m.peerId === joined2.peerId);
  assert.equal(vj2.viewerCount, 2);
  ok("viewer2 joined, viewerCount=2");

  // 隔离：v2 不应收到 v1 的信令（消息只发给主机）
  // v1 再发一个 offer，主机收到，但 v2 不应收到
  const before = v2.messages.length;
  v1.send({ type: "offer", to: "x", sdp: { type: "offer", sdp: "iso" } });
  await host.waitFor((m) => m.type === "offer" && m.sdp.sdp === "iso");
  // 稍等再断言 v2 没有新增消息
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(v2.messages.length, before, "viewer-to-viewer 消息不应互相收到");
  ok("viewer isolation (signaling not leaked to other viewers)");

  // ---------- not-in-room ----------
  const solo = new Client(wsUrl); await solo.open;
  solo.send({ type: "offer", sdp: {} });
  assert.equal((await solo.waitFor((m) => m.type === "error")).code, "not-in-room");
  ok("not-in-room rejected");
  solo.close();

  // ---------- 非法消息 ----------
  const raw = new Client(wsUrl); await raw.open;
  raw.ws.send("not-json");
  assert.equal((await raw.waitFor((m) => m.type === "error")).code, "bad-json");
  raw.messages.length = 0; // 清空队列，避免复用旧的 error
  raw.send({ type: "nope" });
  assert.equal((await raw.waitFor((m) => m.type === "error")).code, "unknown-type");
  ok("bad-json / unknown-type");
  raw.close();

  // ---------- viewer-left ----------
  v1.close();
  const left = await host.waitFor((m) => m.type === "viewer-left" && m.peerId === joined1.peerId);
  assert.equal(left.viewerCount, 1);
  ok("viewer-left notified, viewerCount=1");

  // ---------- 房间满 ----------
  const extra = [];
  for (let i = 0; i < config.maxViewersPerRoom - 1; i++) {
    const c = new Client(wsUrl); await c.open;
    c.send({ type: "join", room });
    await c.waitFor((m) => m.type === "joined");
    extra.push(c);
  }
  const overflow = new Client(wsUrl); await overflow.open;
  overflow.send({ type: "join", room });
  assert.equal((await overflow.waitFor((m) => m.type === "error")).code, "room-full");
  ok("room-full rejected");
  overflow.close();

  // ---------- host-left -> 房间关闭 ----------
  host.close();
  const hostLeft = await v2.waitFor((m) => m.type === "host-left");
  assert.ok(hostLeft.reason);
  const late = new Client(wsUrl); await late.open;
  late.send({ type: "join", room });
  assert.equal((await late.waitFor((m) => m.type === "error")).code, "room-not-found");
  ok("host-left broadcast, closed room unavailable");
  late.close();

  // ---------- 清理额外连接 ----------
  for (const c of extra) c.close();
  v2.close();

  app.httpServer.close();
  console.log(`\n  ${passed} protocol assertions passed - all good`);
  process.exit(0);
};

main().catch((err) => {
  console.error("\n  PROTOCOL TEST FAILED:", err.message);
  process.exit(1);
});
