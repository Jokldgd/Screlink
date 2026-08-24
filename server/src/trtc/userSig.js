import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { config } from '../config.js';

/**
 * 腾讯云 TRTC UserSig 生成（严格对齐官方 tls-sig-api-v2-node/TLSSigAPIv2.js）
 *
 * 算法要点（三处易错）：
 * 1. HMAC-SHA256 输入为多行文本，字段为 TLS.identifier/sdkappid/time/expire（是 TLS.time，不是 expireTime！）
 * 2. 最终 UserSig = base64( zlib.deflate( JSON(sigDoc) ) )
 * 3. base64 后需做 base64url 转义：+ → *，/ → -，= → _
 */
export function isTrtcEnabled() {
  return config.trtc.enabled;
}

export function getTrtcSdkAppId() {
  return config.trtc.sdkAppId;
}

function base64urlEscape(str) {
  return str.replace(/\+/g, '*').replace(/\//g, '-').replace(/=/g, '_');
}

/**
 * 生成 UserSig
 * @param {string} userId 用户 ID（≤32 字节，字母/数字/下划线/连字符）
 * @param {number} expire 过期秒数，默认 7 天
 * @returns {string}
 */
export function genUserSig(userId, expire = 7 * 24 * 3600) {
  const { sdkAppId, secretKey } = config.trtc;
  const currTime = Math.floor(Date.now() / 1000);

  // ① HMAC 原文（官方 _hmacsha256）：每行以 \n 结尾
  const contentToBeSigned =
    `TLS.identifier:${userId}\n` +
    `TLS.sdkappid:${Number(sdkAppId)}\n` +
    `TLS.time:${currTime}\n` +
    `TLS.expire:${expire}\n`;
  const sig = crypto.createHmac('sha256', secretKey).update(contentToBeSigned).digest('base64');

  // ② sigDoc JSON（官方 genSig，字段顺序固定）
  const sigDoc = {
    'TLS.ver': '2.0',
    'TLS.identifier': `${userId}`,
    'TLS.sdkappid': Number(sdkAppId),
    'TLS.time': Number(currTime),
    'TLS.expire': Number(expire),
    'TLS.sig': sig,
  };

  // ③ deflate 压缩 + base64 + base64url 转义
  const compressed = zlib.deflateSync(Buffer.from(JSON.stringify(sigDoc))).toString('base64');
  return base64urlEscape(compressed);
}

/**
 * 生成前端进房所需配置
 * @param {string} userId 内部用户 ID
 * @param {string} roomCode 6 位房间号（TRTC roomId 为数字）
 * @returns {{ sdkAppId: number, userId: string, userSig: string, roomId: number } | null}
 */
export function createTrtcConfig(userId, roomCode) {
  if (!config.trtc.enabled) return null;
  return {
    sdkAppId: config.trtc.sdkAppId,
    userId,
    userSig: genUserSig(userId),
    roomId: Number(roomCode), // 6 位数字房间号直接映射 TRTC 房间
  };
}
