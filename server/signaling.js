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
  if (msg.quality) out.quality = msg.quality;
  return out;
}

/**
 * 信令服务器：通用房间模型（v0.7.1 语音版本）。
 * 一个房间 = 一组对等成员（peers），每个成员：
 *  - 通过 mesh 与其他成员建立双向语音连接（audio-offer/audio-answer/audio-ice）
 *  - 任意成员可发起画面共享（share-start/share-stop），成为动态「共享者」
 *  - 观看者与共享者之间复用 offer/answer/ice 视频协商 + set-quality 清晰度切换
 * 服务器只转发 SDP/ICE 信令，不碰媒体流。
 */
export class SignalingServer {
  constructor() {
    /** roomCode -> { code, peers: Map<peerId, Peer>, shareOwner: peerId|null, createdAt } */
    this.rooms = new Map();
    this.stats = {
      roomsCreated: 0,
      sessionsServed: 0,
      peakConcurrentMembers: 0,
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
      for (const peer of room.peers.values()) {
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

  /** 向房间内除 fromPeer 以外的所有成员广播 */
  broadcast(room, message, fromPeer = null) {
    for (const peer of room.peers.values()) {
      if (peer === fromPeer) continue;
      this.send(peer, message);
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
        return this.handleCreate(peer, msg);
      case "join":
        return this.handleJoin(peer, msg);
      case "offer":
      case "answer":
      case "ice":
      case "renegotiate":
      case "set-quality":
      case "audio-offer":
      case "audio-answer":
      case "audio-ice":
      case "audio-reinit":
        return this.relay(peer, msg);
      case "share-start":
        return this.handleShareStart(peer);
      case "share-stop":
        return this.handleShareStop(peer);
      case "leave":
        return this.removePeer(peer, "left");
      default:
        return this.sendError(peer, "unknown-type");
    }
  }

  /** 创建房间：第一个进入者（房主），支持自定义房间号（2-8 位字母/数字） */
  handleCreate(peer, msg) {
    if (peer.room) return this.sendError(peer, "already-in-room");
    let code;
    const custom = normalizeRoomCode(msg.room);
    if (custom) {
      if (custom.length < 2 || custom.length > 8) {
        return this.sendError(peer, "bad-room");
      }
      if (this.rooms.has(custom)) {
        return this.sendError(peer, "room-taken");
      }
      code = custom;
    } else {
      do {
        code = randomCode(config.roomCodeLength);
      } while (this.rooms.has(code));
    }
    const room = { code, peers: new Map(), shareOwner: null, createdAt: Date.now() };
    room.peers.set(peer.id, peer);
    this.rooms.set(code, room);
    peer.room = room;
    this.stats.roomsCreated++;
    this.send(peer, {
      type: "created",
      room: formatRoomCode(code),
      peerId: peer.id,
      members: [],
    });
  }

  /** 加入房间：成为普通成员，房间广播有新成员；若房间已有共享者则通知 */
  handleJoin(peer, msg) {
    if (peer.room) return this.sendError(peer, "already-in-room");
    const code = normalizeRoomCode(msg.room);
    const room = this.rooms.get(code);
    if (!room) return this.sendError(peer, "room-not-found");
    if (room.peers.size >= config.maxViewersPerRoom) {
      return this.sendError(peer, "room-full");
    }
    room.peers.set(peer.id, peer);
    peer.room = room;
    this.stats.sessionsServed++;
    this.stats.peakConcurrentMembers = Math.max(
      this.stats.peakConcurrentMembers,
      room.peers.size
    );
    // 通知新人：已有成员列表（据此建立语音 mesh）
    const otherIds = [...room.peers.keys()].filter((id) => id !== peer.id);
    this.send(peer, {
      type: "joined",
      room: formatRoomCode(code),
      peerId: peer.id,
      members: otherIds,
    });
    // 广播给其他成员：有新成员加入
    this.broadcast(room, { type: "peer-joined", peerId: peer.id }, peer);
    // 若房间正在共享画面，通知新人去观看（与共享者协商视频）
    if (room.shareOwner && room.shareOwner !== peer.id) {
      this.send(peer, { type: "share-started", peerId: room.shareOwner });
    }
  }

  /** 成员发起画面共享：替换旧共享者并广播 */
  handleShareStart(peer) {
    if (!peer.room) return this.sendError(peer, "not-in-room");
    const room = peer.room;
    if (room.shareOwner && room.shareOwner !== peer.id) {
      const old = room.peers.get(room.shareOwner);
      if (old) {
        this.send(old, { type: "share-stopped", peerId: peer.id, reason: "replaced" });
      }
    }
    room.shareOwner = peer.id;
    this.broadcast(room, { type: "share-started", peerId: peer.id }, peer);
  }

  /** 成员停止画面共享 */
  handleShareStop(peer) {
    if (!peer.room) return;
    const room = peer.room;
    if (room.shareOwner !== peer.id) return; // 非当前共享者忽略
    room.shareOwner = null;
    this.broadcast(room, { type: "share-stopped", peerId: peer.id, reason: "stopped" });
  }

  /**
   * 通用点对点信令转发：所有 offer/answer/ice（视频/音频）均按 msg.to 精确路由。
   * 目标不存在时静默丢弃（连接可能已断开）。
   */
  relay(peer, msg) {
    if (!peer.room) return this.sendError(peer, "not-in-room");
    const target = peer.room.peers.get(msg.to);
    if (!target) return;
    this.send(target, { type: msg.type, from: peer.id, ...payloadOf(msg) });
  }

  removePeer(peer, reason) {
    if (!peer.room) return;
    const room = peer.room;
    peer.room = null;
    room.peers.delete(peer.id);

    // 共享者离开/断线：清除共享状态并广播
    if (room.shareOwner === peer.id) {
      room.shareOwner = null;
      this.broadcast(room, { type: "share-stopped", peerId: peer.id, reason: "left" });
    }
    // 广播成员离开
    this.broadcast(room, {
      type: "peer-left",
      peerId: peer.id,
      members: room.peers.size,
    });
    // 房间空了就销毁
    if (room.peers.size === 0) {
      this.rooms.delete(room.code);
    }
  }

  snapshot() {
    let members = 0;
    for (const room of this.rooms.values()) members += room.peers.size;
    return {
      rooms: this.rooms.size,
      members,
      ...this.stats,
      uptimeMs: Date.now() - this.stats.startedAt,
    };
  }
}
