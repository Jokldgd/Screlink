import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { config } from '../config.js';

export function isLiveKitEnabled() {
  return config.livekit.enabled;
}

export function getLiveKitUrl() {
  return config.livekit.url;
}

/**
 * 生成 LiveKit JoinToken。
 * identity 用内部 userId（uuid），显示名可重复；每个业务房间映射唯一 LiveKit Room `room-{code}`。
 * LiveKit Room 由首个成员 connect 时自动创建（懒创建）。
 */
export async function createJoinToken({ userId, userName, roomCode }) {
  if (!config.livekit.enabled) return null;
  const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
    identity: userId,
    name: userName,
    ttl: '2h',
  });
  at.addGrant({
    room: `room-${roomCode}`,
    roomJoin: true,
    canPublish: true, // 语音 + 屏幕共享（track 级发布权限）
    canSubscribe: true,
    canPublishData: true,
  });
  return at.toJwt();
}

/**
 * 主动回收 LiveKit 房间（最后一人离开时调用）。
 * 失败不阻塞信令——livekit.yaml 中 empty_timeout 作为兜底。
 */
export async function deleteLiveKitRoom(roomCode) {
  if (!config.livekit.enabled || !config.livekit.host) return;
  try {
    const rsc = new RoomServiceClient(config.livekit.host, config.livekit.apiKey, config.livekit.apiSecret);
    await rsc.deleteRoom(`room-${roomCode}`);
  } catch (err) {
    console.warn(`[livekit] 回收房间 room-${roomCode} 失败（将由 empty_timeout 兜底）:`, err?.message || err);
  }
}
