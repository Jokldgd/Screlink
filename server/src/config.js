import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

function toBool(v, d = false) {
  if (v === undefined || v === null || v === '') return d;
  return String(v).toLowerCase() === 'true' || v === '1';
}

export const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  /** memory | redis */
  storeMode: String(process.env.STORE_MODE || 'memory').toLowerCase(),
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

  livekit: {
    apiKey: process.env.LIVEKIT_API_KEY || '',
    apiSecret: process.env.LIVEKIT_API_SECRET || '',
    /** 客户端 wss 连接地址，如 wss://lk.example.com */
    url: process.env.LIVEKIT_URL || '',
    /** 服务端管理 http 地址，如 http://lk.example.com，用于 RoomServiceClient 回收房间 */
    host: process.env.LIVEKIT_HOST || '',
    enabled: false,
  },

  /** 腾讯云 TRTC（商业 RTC，全国节点，画质/弱网优于自建） */
  trtc: {
    sdkAppId: Number(process.env.TRTC_SDK_APP_ID || 0),
    secretKey: process.env.TRTC_SECRET_KEY || '',
    enabled: false,
  },

  room: {
    maxMembers: Math.max(2, Number(process.env.ROOM_MAX_MEMBERS || 10)),
    heartbeatIntervalMs: 30000,
    heartbeatTimeoutMs: Number(process.env.HEARTBEAT_TIMEOUT_MS || 90000),
  },
};

config.livekit.enabled = Boolean(config.livekit.apiKey && config.livekit.apiSecret && config.livekit.url);
config.trtc.enabled = Boolean(config.trtc.sdkAppId && config.trtc.secretKey);
