/** REST 封装：统一 { ok, data } / { ok:false, code, message } */

async function request(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`服务器响应异常 (${res.status})`);
  }
  if (!body.ok) {
    const err = new Error(body.message || '请求失败');
    err.code = body.code;
    err.status = res.status;
    throw err;
  }
  return body.data;
}

/** 创建房间 → { roomCode, roomName, livekitUrl, livekitConfigured } */
export function createRoom({ roomName, userName }) {
  return request('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ roomName, userName }),
  });
}

/** 房间信息预览（加入前） */
export function getRoomInfo(roomCode) {
  return request(`/api/rooms/${roomCode}`);
}

/** 活跃房间列表（仅信息展示） */
export function listRooms() {
  return request('/api/rooms');
}

export function health() {
  return request('/api/health');
}
