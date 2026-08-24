import Redis from 'ioredis';
import { genRoomCode } from './roomCode.js';
import { sanitizeMember } from './memoryStore.js';

/**
 * Redis 实现（生产 / 多实例）。
 * 房间数据只存 Redis，不落 PostgreSQL：
 *   rooms:active            ZSET  member=room:{code}, score=createdAt
 *   rooms:codes             SET   已占用房间号（唯一性）
 *   room:{code}             HASH  name/ownerId/ownerName/createdAt/maxMembers
 *   room:{code}:members     SET   userId
 *   user:{id}:current_room  STRING roomCode
 *   user:{id}:info          HASH  name/muted/isScreenSharing/joinedAt
 * 广播走 Pub/Sub（channel: room-events）。
 */
export class RedisStore {
  constructor({ redisUrl, maxMembers = 10 } = {}) {
    this.maxMembers = maxMembers;
    this.client = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: 2 });
    this.sub = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: 2 });
    this._roomListeners = new Map();
    this._globalListeners = new Set();
    this._ready = this._init();
  }

  async _init() {
    await this.sub.subscribe('room-events');
    this.sub.on('message', (_channel, message) => {
      try {
        this._dispatch(JSON.parse(message));
      } catch {
        /* 忽略坏消息 */
      }
    });
  }

  _dispatch(event) {
    if (event.type === 'room_created' || event.type === 'room_destroyed') {
      for (const cb of this._globalListeners) {
        try { cb(event); } catch { /* ignore */ }
      }
      return;
    }
    const listeners = this._roomListeners.get(event.roomCode);
    if (listeners) {
      for (const cb of listeners) {
        try { cb(event); } catch { /* ignore */ }
      }
    }
  }

  /** 发布事件到频道（所有实例都会收到） */
  _pub(event) {
    this.client.publish('room-events', JSON.stringify(event)).catch(() => {});
  }

  onRoomEvent(roomCode, cb) {
    if (!this._roomListeners.has(roomCode)) this._roomListeners.set(roomCode, new Set());
    this._roomListeners.get(roomCode).add(cb);
  }

  offRoomEvent(roomCode, cb) {
    this._roomListeners.get(roomCode)?.delete(cb);
  }

  onGlobalEvent(cb) {
    this._globalListeners.add(cb);
  }

  offGlobalEvent(cb) {
    this._globalListeners.delete(cb);
  }

  // ---------- 业务 ----------

  async createRoom({ roomName, ownerId, ownerName }) {
    await this._ready;
    let code = null;
    // SADD 原子占用 + 重试 5 次，保证房间号唯一
    for (let i = 0; i < 5; i++) {
      const c = genRoomCode();
      if (await this.client.sadd('rooms:codes', c)) {
        code = c;
        break;
      }
    }
    if (!code) throw new Error('房间号生成失败（冲突过多）');

    const now = Date.now();
    await this.client.hset(`room:${code}`, {
      name: roomName,
      ownerId,
      ownerName,
      createdAt: String(now),
      maxMembers: String(this.maxMembers),
    });
    await this.client.zadd('rooms:active', now, `room:${code}`);

    this._pub({ type: 'room_created', roomCode: code, payload: { roomCode: code, roomName } });
    return { roomCode: code };
  }

  async joinRoom({ roomCode, userId, userName }) {
    await this._ready;
    const exists = await this.client.exists(`room:${roomCode}`);
    if (!exists) return { ok: false, error: 'ROOM_NOT_FOUND' };

    const size = await this.client.scard(`room:${roomCode}:members`);
    if (size >= this.maxMembers) return { ok: false, error: 'ROOM_FULL' };

    const added = await this.client.sadd(`room:${roomCode}:members`, userId);
    if (!added) return { ok: false, error: 'ALREADY_IN_ROOM' };

    // 并发双保险：占位后再次校验，超员则回滚
    const sizeAfter = await this.client.scard(`room:${roomCode}:members`);
    if (sizeAfter > this.maxMembers) {
      await this.client.srem(`room:${roomCode}:members`, userId);
      return { ok: false, error: 'ROOM_FULL' };
    }

    const joinedAt = Date.now();
    await this.client.set(`user:${userId}:current_room`, roomCode);
    await this.client.hset(`user:${userId}:info`, {
      name: userName,
      muted: '0',
      isScreenSharing: '0',
      joinedAt: String(joinedAt),
    });

    const meta = await this.client.hgetall(`room:${roomCode}`);
    this._pub({
      type: 'member_joined',
      roomCode,
      payload: { member: { userId, userName, muted: false, isScreenSharing: false, joinedAt } },
    });

    return {
      ok: true,
      room: {
        code: roomCode,
        name: meta.name || roomCode,
        ownerId: meta.ownerId || '',
        ownerName: meta.ownerName || '',
        createdAt: Number(meta.createdAt || 0),
        maxMembers: Number(meta.maxMembers || this.maxMembers),
      },
      member: { userId, userName, muted: false, isScreenSharing: false, joinedAt },
    };
  }

  async leaveRoom(userId) {
    await this._ready;
    const roomCode = await this.client.get(`user:${userId}:current_room`);
    if (!roomCode) return { ok: true, roomDestroyed: false, roomCode: null };

    await this.client.srem(`room:${roomCode}:members`, userId);
    await this.client.del(`user:${userId}:current_room`, `user:${userId}:info`);

    this._pub({ type: 'member_left', roomCode, payload: { userId, reason: 'leave' } });

    const size = await this.client.scard(`room:${roomCode}:members`);
    if (size === 0) {
      await this.client.del(`room:${roomCode}`);
      await this.client.zrem('rooms:active', `room:${roomCode}`);
      await this.client.srem('rooms:codes', roomCode);
      this._pub({ type: 'room_destroyed', roomCode, payload: { reason: 'empty', roomCode } });
      return { ok: true, roomDestroyed: true, roomCode };
    }
    return { ok: true, roomDestroyed: false, roomCode };
  }

  async setMuted(userId, muted) {
    await this._ready;
    const roomCode = await this.client.get(`user:${userId}:current_room`);
    if (!roomCode) return { ok: false, error: 'NOT_IN_ROOM' };
    await this.client.hset(`user:${userId}:info`, 'muted', muted ? '1' : '0');
    this._pub({ type: 'member_muted', roomCode, payload: { userId, muted: Boolean(muted) } });
    return { ok: true };
  }

  async setScreenSharing(userId, isSharing) {
    await this._ready;
    const roomCode = await this.client.get(`user:${userId}:current_room`);
    if (!roomCode) return { ok: false, error: 'NOT_IN_ROOM' };
    await this.client.hset(`user:${userId}:info`, 'isScreenSharing', isSharing ? '1' : '0');
    this._pub({
      type: isSharing ? 'screen_share_started' : 'screen_share_stopped',
      roomCode,
      payload: { userId },
    });
    return { ok: true };
  }

  async getRoomInfo(roomCode) {
    await this._ready;
    const meta = await this.client.hgetall(`room:${roomCode}`);
    if (!meta || !meta.name) return null;

    const memberIds = await this.client.smembers(`room:${roomCode}:members`);
    const members = [];
    for (const id of memberIds) {
      const info = await this.client.hgetall(`user:${id}:info`);
      members.push(
        sanitizeMember({
          userId: id,
          userName: info.name || id,
          muted: info.muted === '1',
          isScreenSharing: info.isScreenSharing === '1',
          joinedAt: Number(info.joinedAt || 0),
        }),
      );
    }

    return {
      code: roomCode,
      name: meta.name,
      ownerId: meta.ownerId || '',
      ownerName: meta.ownerName || '',
      createdAt: Number(meta.createdAt || 0),
      maxMembers: Number(meta.maxMembers || this.maxMembers),
      memberCount: members.length,
      members,
    };
  }

  async listActiveRooms() {
    await this._ready;
    const entries = await this.client.zrange('rooms:active', 0, -1, 'WITHSCORES');
    const rooms = [];
    for (let i = 0; i < entries.length; i += 2) {
      const key = entries[i]; // room:{code}
      const code = key.slice('room:'.length);
      const meta = await this.client.hgetall(key);
      if (!meta.name) continue;
      const memberCount = await this.client.scard(`${key}:members`);
      rooms.push({
        roomCode: code,
        roomName: meta.name,
        memberCount,
        maxMembers: Number(meta.maxMembers || this.maxMembers),
        createdAt: Number(entries[i + 1] || 0),
      });
    }
    return rooms;
  }

  async close() {
    this.client.disconnect();
    this.sub.disconnect();
  }
}
