import { config } from '../config.js';
import { createHandlers } from './handlers.js';
import { deleteLiveKitRoom } from '../livekit/token.js';

/**
 * WebSocket 信令服务器（/ws）
 *
 * 连接生命周期：
 *  - 建立 → 加入全局连接集合（收 room_created / room_destroyed 全局广播）
 *  - join_room 成功 → 订阅房间事件（member_* / screen_share_*）
 *  - 心跳：服务端每 30s ping，3 次未 pong（90s）按断线清理
 *  - close / error → 幂等清理（按 userId 定位所在房间执行离开逻辑）
 */
export function setupWebSocket(fastify, ctx) {
  const { store } = ctx;

  /** 全局连接（所有 WS） */
  const globalConnections = new Set();
  /** roomCode -> Set<ws> */
  const roomConnections = new Map();
  /** roomCode -> listener（store 房间事件回调） */
  const roomBroadcasters = new Map();
  /** userId -> ws（P2P WebRTC 信令点对点转发用） */
  const userConnections = new Map();

  const broadcastRoom = (roomCode, event) => {
    const set = roomConnections.get(roomCode);
    if (!set) return;
    const data = JSON.stringify({ type: event.type, payload: event.payload });
    for (const ws of set) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  };

  const ensureRoomListener = (roomCode) => {
    if (!roomBroadcasters.has(roomCode)) {
      const listener = (event) => broadcastRoom(roomCode, event);
      roomBroadcasters.set(roomCode, listener);
      store.onRoomEvent(roomCode, listener);
    }
  };

  const removeRoomListener = (roomCode) => {
    const listener = roomBroadcasters.get(roomCode);
    if (listener) {
      store.offRoomEvent(roomCode, listener);
      roomBroadcasters.delete(roomCode);
    }
  };

  const wsServer = {
    subscribeConnection(ws, roomCode) {
      globalConnections.add(ws);
      ws._roomCode = roomCode;
      if (!roomConnections.has(roomCode)) roomConnections.set(roomCode, new Set());
      roomConnections.get(roomCode).add(ws);
      ensureRoomListener(roomCode);
      if (ws.userId) userConnections.set(ws.userId, ws);
    },
    unsubscribeConnection(ws) {
      globalConnections.delete(ws);
      const rc = ws._roomCode;
      if (rc && roomConnections.has(rc)) {
        roomConnections.get(rc).delete(ws);
        if (roomConnections.get(rc).size === 0) {
          roomConnections.delete(rc);
          removeRoomListener(rc);
        }
      }
      if (ws.userId) userConnections.delete(ws.userId);
      ws._roomCode = null;
    },
    /** 按 userId 查找连接（P2P 信令转发目标） */
    getConnection(userId) {
      return userConnections.get(userId) || null;
    },
  };

  const handlers = createHandlers({ store, wsServer });

  // ---------- store 全局事件 → 所有连接 ----------
  store.onGlobalEvent((event) => {
    const data = JSON.stringify({ type: event.type, payload: event.payload });
    for (const ws of globalConnections) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  });

  // ---------- 断线清理（幂等） ----------
  const cleanupConnection = async (ws) => {
    const userId = ws.userId;
    if (userId) {
      const res = await store.leaveRoom(userId); // 幂等：不在房间则直接返回
      if (res.roomDestroyed && res.roomCode) {
        await deleteLiveKitRoom(res.roomCode);
      }
    }
    wsServer.unsubscribeConnection(ws);
    ws.roomCode = null;
  };

  // ---------- 心跳 ----------
  const heartbeatTimer = setInterval(() => {
    for (const ws of globalConnections) {
      if (ws.isAlive === false) {
        try { ws.terminate(); } catch { /* ignore */ }
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, config.room.heartbeatIntervalMs);
  heartbeatTimer.unref?.();

  // ---------- 路由 ----------
  fastify.get('/ws', { websocket: true }, (socket) => {
    const ws = socket;
    ws.isAlive = true;
    ws.userId = null;
    ws.roomCode = null;
    ws._roomCode = null;
    globalConnections.add(ws);

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const handler = handlers[msg?.type];
      if (handler) {
        try {
          await handler.call(handlers, ws, msg);
        } catch (err) {
          console.error(`[ws] 处理 ${msg.type} 失败:`, err);
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'error', payload: { code: 'INTERNAL', message: '服务内部错误' } }));
          }
        }
      }
    });

    ws.on('close', () => {
      globalConnections.delete(ws);
      cleanupConnection(ws).catch((err) => console.error('[ws] 断线清理失败:', err));
    });

    ws.on('error', () => {
      try { ws.terminate(); } catch { /* ignore */ }
    });
  });
}
