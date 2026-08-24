import { genRoomCode } from './roomCode.js';

/**
 * 内存降级模式（无 Redis 本地直跑 / 单实例）。
 * 与 RedisStore 保持完全一致的异步接口，业务代码零改动。
 *
 * 事件机制：
 *  - 房间事件（member_joined / member_left / member_muted / screen_share_*）→ onRoomEvent(code, cb)
 *  - 全局事件（room_created / room_destroyed）→ onGlobalEvent(cb)
 */
export class MemoryStore {
  constructor({ maxMembers = 10 } = {}) {
    this.maxMembers = maxMembers;
    /** code -> room 对象 */
    this.activeRooms = new Map();
    /** 已占用房间号集合 */
    this.codes = new Set();
    /** userId -> code */
    this.userRoom = new Map();
    /** code -> Set<cb> */
    this._roomListeners = new Map();
    /** Set<cb> 全局事件监听 */
    this._globalListeners = new Set();
  }

  // ---------- 事件 ----------

  emit(roomCode, event) {
    const listeners = this._roomListeners.get(roomCode);
    if (listeners) {
      for (const cb of listeners) {
        try { cb(event); } catch (err) { console.error('[memory-store] 房间事件回调错误:', err); }
      }
    }
  }

  emitGlobal(event) {
    for (const cb of this._globalListeners) {
      try { cb(event); } catch (err) { console.error('[memory-store] 全局事件回调错误:', err); }
    }
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

  /** 创建房间 → { roomCode }（唯一性占用 + 重试） */
  async createRoom({ roomName, ownerId, ownerName }) {
    let code = null;
    for (let i = 0; i < 5; i++) {
      const c = genRoomCode();
      if (!this.codes.has(c)) {
        this.codes.add(c);
        code = c;
        break;
      }
    }
    if (!code) throw new Error('房间号生成失败（冲突过多）');

    this.activeRooms.set(code, {
      code,
      name: roomName,
      ownerId,
      ownerName,
      createdAt: Date.now(),
      maxMembers: this.maxMembers,
      members: new Map(), // userId -> member
    });
    this.emitGlobal({ type: 'room_created', roomCode: code, payload: { roomCode: code, roomName } });
    return { roomCode: code };
  }

  /** 加入房间 → { ok, error?, room, member } */
  async joinRoom({ roomCode, userId, userName }) {
    const room = this.activeRooms.get(roomCode);
    if (!room) return { ok: false, error: 'ROOM_NOT_FOUND' };
    if (room.members.has(userId)) return { ok: false, error: 'ALREADY_IN_ROOM' };
    if (room.members.size >= room.maxMembers) return { ok: false, error: 'ROOM_FULL' };

    const member = { userId, userName, muted: false, isScreenSharing: false, joinedAt: Date.now() };
    room.members.set(userId, member);
    this.userRoom.set(userId, roomCode);

    this.emit(roomCode, {
      type: 'member_joined',
      roomCode,
      payload: { member: sanitizeMember(member) },
    });
    return { ok: true, room: sanitizeRoom(room), member };
  }

  /** 离开/断线清理（幂等）→ { ok, roomDestroyed, roomCode } */
  async leaveRoom(userId) {
    const roomCode = this.userRoom.get(userId);
    if (!roomCode) return { ok: true, roomDestroyed: false, roomCode: null };

    const room = this.activeRooms.get(roomCode);
    if (!room) {
      this.userRoom.delete(userId);
      return { ok: true, roomDestroyed: false, roomCode: null };
    }

    room.members.delete(userId);
    this.userRoom.delete(userId);

    this.emit(roomCode, {
      type: 'member_left',
      roomCode,
      payload: { userId, reason: 'leave' },
    });

    let roomDestroyed = false;
    if (room.members.size === 0) {
      this.activeRooms.delete(roomCode);
      this.codes.delete(roomCode);
      roomDestroyed = true;
      this.emitGlobal({
        type: 'room_destroyed',
        roomCode,
        payload: { reason: 'empty', roomCode },
      });
    }
    return { ok: true, roomDestroyed, roomCode };
  }

  /** 静音状态同步 */
  async setMuted(userId, muted) {
    const roomCode = this.userRoom.get(userId);
    const room = this.activeRooms.get(roomCode);
    const member = room?.members.get(userId);
    if (!member) return { ok: false, error: 'NOT_IN_ROOM' };
    member.muted = muted;
    this.emit(roomCode, { type: 'member_muted', roomCode, payload: { userId, muted } });
    return { ok: true };
  }

  /** 屏幕共享状态同步 */
  async setScreenSharing(userId, isSharing) {
    const roomCode = this.userRoom.get(userId);
    const room = this.activeRooms.get(roomCode);
    const member = room?.members.get(userId);
    if (!member) return { ok: false, error: 'NOT_IN_ROOM' };
    member.isScreenSharing = isSharing;
    this.emit(roomCode, {
      type: isSharing ? 'screen_share_started' : 'screen_share_stopped',
      roomCode,
      payload: { userId },
    });
    return { ok: true };
  }

  /** 房间信息 + 成员快照；不存在返回 null */
  async getRoomInfo(roomCode) {
    const room = this.activeRooms.get(roomCode);
    if (!room) return null;
    return {
      ...sanitizeRoom(room),
      memberCount: room.members.size,
      members: [...room.members.values()].map(sanitizeMember),
    };
  }

  /** 活跃房间列表（按创建时间排序，仅信息展示） */
  async listActiveRooms() {
    return [...this.activeRooms.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((r) => ({
        roomCode: r.code,
        roomName: r.name,
        memberCount: r.members.size,
        maxMembers: r.maxMembers,
        createdAt: r.createdAt,
      }));
  }

  /** 关闭（释放资源，内存模式无操作） */
  async close() {}
}

export function sanitizeMember(m) {
  return {
    userId: m.userId,
    userName: m.userName,
    muted: Boolean(m.muted),
    isScreenSharing: Boolean(m.isScreenSharing),
    joinedAt: m.joinedAt,
  };
}

export function sanitizeRoom(room) {
  return {
    code: room.code,
    name: room.name,
    ownerId: room.ownerId,
    ownerName: room.ownerName,
    createdAt: room.createdAt,
    maxMembers: room.maxMembers,
  };
}
