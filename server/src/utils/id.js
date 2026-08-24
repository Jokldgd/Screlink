import { nanoid } from 'nanoid';

/** 生成内部用户 ID（LiveKit identity 用，与显示名解耦） */
export function genUserId() {
  return `u_${nanoid(10)}`;
}

/** 生成连接 ID */
export function genConnId() {
  return `c_${nanoid(8)}`;
}
