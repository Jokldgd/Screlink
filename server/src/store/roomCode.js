/**
 * 6 位数字房间号机制
 * 范围 100000~999999，恒为 6 位，避开前导零的输入歧义。
 */

/** 生成一个 6 位数字房间号 */
export function genRoomCode() {
  return String(Math.floor(Math.random() * 900000) + 100000);
}

/** 校验房间号格式（必须是 6 位数字） */
export function isValidRoomCode(code) {
  return /^\d{6}$/.test(String(code));
}
