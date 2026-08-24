import { defineStore } from 'pinia';
import { signal } from '../api/ws.js';
import * as api from '../api/http.js';

/**
 * 房间状态（Pinia）
 *  - self / members[]：由信令驱动（join_room_ok 全量快照 + 增量事件）
 *  - livekit 字段：join 成功时下发，供 RoomView 连接媒体层
 */
export const useRoomStore = defineStore('room', {
  state: () => ({
    roomCode: null,
    roomName: '',
    self: null, // { userId, userName }
    members: [], // [{ userId, userName, muted, isScreenSharing, joinedAt }]
    livekitUrl: '',
    livekitToken: null,
    livekitConfigured: false,
    /** 腾讯云 TRTC 配置（{ sdkAppId, userId, userSig, roomId } | null） */
    trtc: null,
    trtcConfigured: false,
    joined: false,
    wsConnected: false,
    lastError: null,
  }),

  actions: {
    /** 创建房间（REST）→ 返回房间号 */
    async createRoom({ roomName, userName }) {
      return api.createRoom({ roomName, userName });
    },

    /** 通过房间号加入（WS） */
    joinRoom(roomCode, userName) {
      return new Promise((resolve, reject) => {
        const onMsg = (type, payload) => {
          if (type === 'join_room_ok') {
            signal.offMessage(onMsg);
            this.applyJoinOk(payload);
            resolve(payload);
          } else if (type === 'error') {
            signal.offMessage(onMsg);
            this.lastError = payload;
            reject(new Error(payload.message));
          }
        };
        signal.onMessage(onMsg);
        const sent = signal.send('join_room', { roomCode, userName });
        if (!sent) {
          signal.offMessage(onMsg);
          reject(new Error('信令连接未就绪，请稍后重试'));
        }
        // 超时保护
        setTimeout(() => {
          signal.offMessage(onMsg);
          reject(new Error('加入房间超时'));
        }, 8000);
      });
    },

    applyJoinOk(payload) {
      this.roomCode = payload.roomCode;
      this.roomName = payload.roomName;
      this.self = payload.self;
      this.members = payload.members || [];
      this.livekitUrl = payload.livekitUrl || '';
      this.livekitToken = payload.livekitToken || null;
      this.livekitConfigured = Boolean(payload.livekitConfigured);
      this.trtc = payload.trtc || null;
      this.trtcConfigured = Boolean(payload.trtcConfigured);
      this.joined = true;
      this.lastError = null;
    },

    /** 离开房间（主动） */
    async leaveRoom() {
      signal.send('leave_room', {});
      this.reset();
    },

    /** 信令事件 → 状态更新 */
    applyEvent(type, payload) {
      switch (type) {
        case 'member_joined': {
          const m = payload.member;
          if (!this.members.some((x) => x.userId === m.userId)) {
            this.members.push(m);
          }
          break;
        }
        case 'member_left':
          this.members = this.members.filter((m) => m.userId !== payload.userId);
          break;
        case 'member_muted': {
          const m = this.members.find((x) => x.userId === payload.userId);
          if (m) m.muted = payload.muted;
          break;
        }
        case 'screen_share_started': {
          const m = this.members.find((x) => x.userId === payload.userId);
          if (m) m.isScreenSharing = true;
          break;
        }
        case 'screen_share_stopped': {
          const m = this.members.find((x) => x.userId === payload.userId);
          if (m) m.isScreenSharing = false;
          break;
        }
        case 'room_destroyed':
          this.roomDestroyed = payload;
          break;
      }
    },

    /** 本端静音状态（本地 + 广播） */
    setSelfMuted(muted) {
      signal.send('mute_toggle', { muted });
    },

    startScreenShare() {
      signal.send('start_screen_share', {});
    },

    stopScreenShare() {
      signal.send('stop_screen_share', {});
    },

    reset() {
      this.roomCode = null;
      this.roomName = '';
      this.self = null;
      this.members = [];
      this.livekitUrl = '';
      this.livekitToken = null;
      this.livekitConfigured = false;
      this.trtc = null;
      this.trtcConfigured = false;
      this.joined = false;
      this.roomDestroyed = null;
    },
  },
});
