import { config } from '../config.js';
import { genUserId } from '../utils/id.js';
import { isValidRoomCode } from '../store/roomCode.js';
import { getLiveKitUrl, isLiveKitEnabled } from '../livekit/token.js';
import { ERROR_MESSAGES } from '../signal/handlers.js';

const ROOM_NAME_MAX = 30;

function ok(reply, data) {
  return reply.send({ ok: true, data });
}

function fail(reply, status, code, message) {
  return reply.status(status).send({ ok: false, code, message: message || ERROR_MESSAGES[code] || '未知错误' });
}

/**
 * REST 路由
 *  - POST /api/rooms        创建房间（返回 6 位房间号）
 *  - GET  /api/rooms        活跃房间列表（仅信息展示，不可点入）
 *  - GET  /api/rooms/:code  房间信息 + 成员快照（加入前预览）
 *  - GET  /api/health       健康检查
 */
export function registerHttpRoutes(fastify, ctx) {
  const { store } = ctx;

  fastify.post('/api/rooms', async (req, reply) => {
    const { roomName, userName } = req.body || {};
    const name = String(roomName ?? '').trim().slice(0, ROOM_NAME_MAX);
    if (!name) return fail(reply, 400, 'NAME_REQUIRED', '请输入房间名');
    const ownerName = String(userName ?? '房主').trim().slice(0, 20) || '房主';
    const ownerId = genUserId();

    try {
      const { roomCode } = await store.createRoom({ roomName: name, ownerId, ownerName });
      return ok(reply, {
        roomCode,
        roomName: name,
        livekitUrl: getLiveKitUrl(),
        livekitConfigured: isLiveKitEnabled(),
      });
    } catch (err) {
      req.log.error(err);
      return fail(reply, 500, 'INTERNAL');
    }
  });

  fastify.get('/api/rooms', async (_req, reply) => {
    const rooms = await store.listActiveRooms();
    return ok(reply, { rooms });
  });

  fastify.get('/api/rooms/:code', async (req, reply) => {
    const { code } = req.params;
    if (!isValidRoomCode(code)) return fail(reply, 400, 'INVALID_ROOM_CODE');
    const info = await store.getRoomInfo(code);
    if (!info) return fail(reply, 404, 'ROOM_NOT_FOUND');
    return ok(reply, info);
  });

  fastify.get('/api/health', async (_req, reply) => {
    return ok(reply, {
      status: 'ok',
      storeMode: config.storeMode,
      livekitConfigured: isLiveKitEnabled(),
      uptime: process.uptime(),
    });
  });
}
