import { isValidRoomCode } from '../store/roomCode.js';
import { genUserId } from '../utils/id.js';
import { createJoinToken, deleteLiveKitRoom, getLiveKitUrl, isLiveKitEnabled } from '../livekit/token.js';
import { createTrtcConfig, isTrtcEnabled } from '../trtc/userSig.js';

export const ERROR_MESSAGES = {
  ROOM_NOT_FOUND: '房间不存在或已销毁',
  ROOM_FULL: '房间已满（最多10人）',
  INVALID_ROOM_CODE: '房间号必须是6位数字',
  ALREADY_IN_ROOM: '你已在房间中',
  NAME_REQUIRED: '请输入昵称',
  NOT_IN_ROOM: '你当前不在房间中',
  INTERNAL: '服务内部错误，请重试',
};

function send(ws, type, payload = {}) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, payload }));
  }
}

function sendError(ws, code, message) {
  send(ws, 'error', { code, message: message || ERROR_MESSAGES[code] || '未知错误' });
}

const NAME_MAX = 20;
const ROOM_NAME_MAX = 30;

function cleanName(value, max, fallback) {
  const s = String(value ?? '').trim();
  return s ? s.slice(0, max) : fallback;
}

/**
 * 信令处理器工厂。
 * ctx = { store, wsServer }
 */
export function createHandlers(ctx) {
  const { store } = ctx;

  return {
    /** 加入房间（凭房间号） */
    async join_room(ws, msg) {
      const { roomCode, userName } = msg.payload || {};
      if (!isValidRoomCode(roomCode)) return sendError(ws, 'INVALID_ROOM_CODE');
      const name = cleanName(userName, NAME_MAX, null);
      if (!name) return sendError(ws, 'NAME_REQUIRED');

      const userId = ws.userId || (ws.userId = genUserId());
      ws.userName = name;

      // 若已在其他房间，先离开
      if (ws.roomCode) {
        await this.leave_room(ws);
      }

      const res = await store.joinRoom({ roomCode, userId, userName: name });
      if (!res.ok) return sendError(ws, res.error);

      const info = await store.getRoomInfo(roomCode);
      const livekitToken = await createJoinToken({ userId, userName: name, roomCode });
      const trtc = createTrtcConfig(userId, roomCode);

      ws.roomCode = roomCode;
      ws.roomName = info?.name || res.room.name;
      ctx.wsServer.subscribeConnection(ws, roomCode);

      send(ws, 'join_room_ok', {
        roomCode,
        roomName: info?.name || res.room.name,
        livekitUrl: getLiveKitUrl(),
        livekitToken,
        livekitConfigured: isLiveKitEnabled(),
        trtcConfigured: isTrtcEnabled(),
        trtc,
        self: { userId, userName: name },
        members: info?.members || [],
      });
    },

    /** 主动离开房间 */
    async leave_room(ws) {
      const userId = ws.userId;
      if (!userId) return send(ws, 'leave_room_ok', {});

      const res = await store.leaveRoom(userId);
      if (res.roomDestroyed && res.roomCode) {
        await deleteLiveKitRoom(res.roomCode);
      }
      ctx.wsServer.unsubscribeConnection(ws);
      ws.roomCode = null;

      send(ws, 'leave_room_ok', {});
    },

    /** 静音状态同步（实际麦克风由客户端本地控制） */
    async mute_toggle(ws, msg) {
      const userId = ws.userId;
      if (!userId || !ws.roomCode) return sendError(ws, 'NOT_IN_ROOM');
      const muted = Boolean(msg.payload?.muted);
      const res = await store.setMuted(userId, muted);
      if (!res.ok) return sendError(ws, res.error);
    },

    /** 开始屏幕共享 */
    async start_screen_share(ws) {
      const userId = ws.userId;
      if (!userId || !ws.roomCode) return sendError(ws, 'NOT_IN_ROOM');
      const res = await store.setScreenSharing(userId, true);
      if (!res.ok) return sendError(ws, res.error);
    },

    /** 停止屏幕共享 */
    async stop_screen_share(ws) {
      const userId = ws.userId;
      if (!userId || !ws.roomCode) return sendError(ws, 'NOT_IN_ROOM');
      const res = await store.setScreenSharing(userId, false);
      if (!res.ok) return sendError(ws, res.error);
    },

    /**
     * P2P WebRTC 信令转发（无 LiveKit 时的媒体降级模式）。
     * payload: { target: userId, data: { kind: offer|answer|ice, sdp?, candidate? } }
     * 仅转发给同一房间内的目标成员。
     */
    webrtc_signal(ws, msg) {
      const { target, data } = msg.payload || {};
      if (!ws.roomCode || !target || !data || !data.kind) return;
      if (target === ws.userId) return;
      const targetWs = ctx.wsServer.getConnection(target);
      if (!targetWs || targetWs.roomCode !== ws.roomCode) return;
      send(targetWs, 'webrtc_signal', { from: ws.userId, data });
    },

    /** 心跳 */
    ping(ws, msg) {
      send(ws, 'pong', { t: msg.payload?.t || Date.now() });
    },
  };
}
