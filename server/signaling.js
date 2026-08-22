import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { config } from "./config.js";

/**
 * 房间号字母表：去掉了易混淆字符（0/O、1/I），共 32 个字符。
 */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomCode(length) {
  let code = "";
  for (let i = 0; i < length; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

/** 归一化：转大写、去掉分隔符和非法字符 */
export function normalizeRoomCode(raw) {
  return String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** 展示格式：ABC123 -> ABC-123 */
export function formatRoomCode(code) {
  const c = normalizeRoomCode(code);
  return c.length === 6 ? `${c.slice(0, 3)}-${c.slice(3)}` : c;
}

function payloadOf(msg) {
  const out = {};
  if (msg.sdp) out.sdp = msg.sdp;
  if (msg.candidate) out.candidate = msg.candidate;
  return out;
}

/**
 * 信令服务器：负责房间管理与 WebRTC 信令转发。
 * 拓扑：星形（mesh）——主机与每个观看者各建一条 P2P 连接，
 * 服务器只转发 SDP/ICE，不碰媒体流。协议细节见 docs/PROTOCOL.md。
 */
export class SignalingServer {
  constructor() {
    /** roomCode -> { code, host, viewers: Map<peerId, Peer>, createdAt } */
    this.rooms = new Map();
    this.stats = {
      roomsCreated: 0,
      sessionsServed: 0,
      peakConcurrentViewers: 0,
      startedAt: Date.now(),
    };
    this.heartbeat = setInterval(() => this.pingAll(), config.heartbeatIntervalMs);
    this.heartbeat.unref?.();
  }

  /** 把 WebSocket 服务挂到某个 HTTP(S) server 上 */
  attach(httpServer, { path = "/ws" } = {}) {
    const wss = new WebSocketServer({ server: httpServer, path });
    wss.on("connection", (ws) => this.handleConnection(ws));
    return wss;
  }

  handleConnection(ws) {
    const peer = {
      id: randomUUID(),
      ws,
      role: null, // "host" | "viewer"
      room: null,
      isAlive: true,
      createdAt: Date.now(),
    };
    ws.on("pong", () => {
      peer.isAlive = true;
    });
    ws.on("message", (data) => this.handleMessage(peer, data));
    ws.on("close", () => this.removePeer(peer, "disconnected"));
    ws.on("error", () => {
      /* close 事件会兜底清理 */
    });
  }

  pingAll() {
    for (const room of this.rooms.values()) {
      const peers = [room.host, ...room.viewers.values()];
      for (const peer of peers) {
        if (!peer.isAlive) {
          peer.ws.terminate();
          continue;
        }
        peer.isAlive = false;
        try {
          peer.ws.ping();
        } catch {
          /* ignore */
        }
      }
    }
  }

  send(peer, message) {
    if (peer.ws.readyState === WebSocket.OPEN) {
      peer.ws.send(JSON.stringify(message));
    }
  }

  sendError(peer, code, extra = {}) {
    this.send(peer, { type: "error", code, ...extra });
  }

  handleMessage(peer, data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return this.sendError(peer, "bad-json");
    }
    switch (msg.type) {
      case "create":
        return this.handleCreate(peer);
      case "join":
        return this.handleJoin(peer, msg);
      case "offer":
      case "answer":
      case "ice":
        return this.relay(peer, msg);
      case "leave":
        return this.removePeer(peer, "left");
      default:
        return this.sendError(peer, "unknown-type");
    }
  }

  handleCreate(peer) {
    if (peer.role) return this.sendError(peer, "already-in-room");
    let code;
    do {
      code = randomCode(config.roomCodeLength);
    } while (this.rooms.has(code));
    const room = { code, host: peer, viewers: new Map(), createdAt: Date.now() };
    this.rooms.set(code, room);
    peer.role = "host";
    peer.room = room;
    this.stats.roomsCreated++;
    this.send(peer, {
      type: "created",
      room: formatRoomCode(code),
      peerId: peer.id,
      viewerCount: 0,
    });
  }

  handleJoin(peer, msg) {
    if (peer.role) return this.sendError(peer, "already-in-room");
    const code = normalizeRoomCode(msg.room);
    const room = this.rooms.get(code);
    if (!room) return this.sendError(peer, "room-not-found");
    if (room.viewers.size >= config.maxViewersPerRoom) {
      return this.sendError(peer, "room-full");
    }
    room.viewers.set(peer.id, peer);
    peer.role = "viewer";
    peer.room = room;
    this.stats.sessionsServed++;
    this.stats.peakConcurrentViewers = Math.max(
      this.stats.peakConcurrentViewers,
      room.viewers.size
    );
    this.send(peer, {
      type: "joined",
      room: formatRoomCode(code),
      peerId: peer.id,
      viewerCount: room.viewers.size,
    });
    this.send(room.host, {
      type: "viewer-joined",
      peerId: peer.id,
      viewerCount: room.viewers.size,
    });
  }

  /**
   * 转发 offer/answer/ice。
   * 主机 -> 观看者：按 msg.to 精确路由；
   * 观看者 -> 主机：一律路由给本房间主机（观看者无需知道主机 id）。
   */
  relay(peer, msg) {
    if (!peer.room) return this.sendError(peer, "not-in-room");
    let target = null;
    if (peer.role === "host") {
      target = peer.room.viewers.get(msg.to);
    } else if (peer.role === "viewer") {
      target = peer.room.host;
    }
    if (!target) return; // 目标不存在：静默丢弃（连接可能已断开）
    this.send(target, { type: msg.type, from: peer.id, ...payloadOf(msg) });
  }

  removePeer(peer, reason) {
    if (!peer.room) return;
    const room = peer.room;
    peer.room = null;

    if (peer.role === "host") {
      // 主机离开 = 房间关闭，通知所有观看者
      this.rooms.delete(room.code);
      for (const viewer of room.viewers.values()) {
        viewer.room = null;
        viewer.role = null;
        this.send(viewer, { type: "host-left", reason });
      }
    } else if (peer.role === "viewer") {
      room.viewers.delete(peer.id);
      peer.role = null;
      this.send(room.host, {
        type: "viewer-left",
        peerId: peer.id,
        viewerCount: room.viewers.size,
      });
    }
  }

  snapshot() {
    let viewers = 0;
    for (const room of this.rooms.values()) viewers += room.viewers.size;
    return {
      rooms: this.rooms.size,
      viewers,
      ...this.stats,
      uptimeMs: Date.now() - this.stats.startedAt,
    };
  }
}
