import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { MemoryStore } from '../src/store/memoryStore.js';
import { setupWebSocket } from '../src/signal/wsServer.js';
import { registerHttpRoutes } from '../src/routes/http.js';

const PORT = 43100 + Math.floor(Math.random() * 1000);

let app;
let base;

before(async () => {
  const store = new MemoryStore({ maxMembers: 3 });
  app = Fastify({ logger: false });
  await app.register(websocket);
  setupWebSocket(app, { store });
  registerHttpRoutes(app, { store });
  await app.listen({ port: PORT, host: '127.0.0.1' });
  base = `http://127.0.0.1:${PORT}`;
});

after(async () => {
  await app.close();
});

/** 打开 WS 并等待 open */
function openWS() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error('WS 连接失败'));
  });
}

/** 等待指定 type 的消息（可带超时） */
function waitMsg(ws, type, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.onmessage = null;
      reject(new Error(`等待 ${type} 超时`));
    }, timeout);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === type) {
        clearTimeout(timer);
        ws.onmessage = null;
        resolve(msg.payload);
      }
    };
  });
}

function send(ws, type, payload = {}) {
  ws.send(JSON.stringify({ type, payload }));
}

async function createRoom(roomName = '测试房间', userName = '房主') {
  const res = await fetch(`${base}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomName, userName }),
  });
  return res.json();
}

test('创建房间返回 6 位数字房间号', async () => {
  const body = await createRoom('技术讨论', 'Alice');
  assert.equal(body.ok, true);
  assert.match(body.data.roomCode, /^\d{6}$/);
});

test('房间号错误格式返回 INVALID_ROOM_CODE（REST 预览）', async () => {
  const res = await fetch(`${base}/api/rooms/123`);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, 'INVALID_ROOM_CODE');
});

test('完整生命周期：加入 → 成员广播 → 离开 → 自动销毁', async () => {
  const { data } = await createRoom('生命周期', 'Alice');
  const code = data.roomCode;

  // A 加入
  const wsA = await openWS();
  send(wsA, 'join_room', { roomCode: code, userName: 'Alice' });
  const okA = await waitMsg(wsA, 'join_room_ok');
  assert.equal(okA.roomCode, code);
  // 成员快照包含自己
  assert.equal(okA.members.length, 1);
  assert.equal(okA.members[0].userName, 'Alice');

  // B 加入，A 应收到 member_joined
  const wsB = await openWS();
  const joinedP = waitMsg(wsA, 'member_joined');
  send(wsB, 'join_room', { roomCode: code, userName: 'Bob' });
  const joined = await joinedP;
  assert.equal(joined.member.userName, 'Bob');
  const okB = await waitMsg(wsB, 'join_room_ok');
  assert.equal(okB.members.length, 2);

  // B 离开，A 收到 member_left
  const leftP = waitMsg(wsA, 'member_left');
  send(wsB, 'leave_room', {});
  const left = await leftP;
  assert.equal(left.userId, okB.self.userId);

  // A 离开（最后一人）→ 房间销毁 → B 连接已被关闭（B 已离开无需处理），房间不存在
  const destroyedP = waitMsg(wsA, 'room_destroyed');
  send(wsA, 'leave_room', {});
  const destroyed = await destroyedP;
  assert.equal(destroyed.reason, 'empty');
  assert.equal(destroyed.roomCode, code);

  // 再次加入 → ROOM_NOT_FOUND
  const wsC = await openWS();
  send(wsC, 'join_room', { roomCode: code, userName: 'C' });
  const err = await waitMsg(wsC, 'error');
  assert.equal(err.code, 'ROOM_NOT_FOUND');
  wsC.close();
});

test('加入不存在的房间号 → ROOM_NOT_FOUND', async () => {
  const ws = await openWS();
  send(ws, 'join_room', { roomCode: '000001', userName: 'X' });
  const err = await waitMsg(ws, 'error');
  assert.equal(err.code, 'ROOM_NOT_FOUND');
  ws.close();
});

test('房间满员（上限3）→ 第4人 ROOM_FULL', async () => {
  const { data } = await createRoom('满员测试', 'P1');
  const code = data.roomCode;

  const sockets = [];
  for (let i = 1; i <= 3; i++) {
    const ws = await openWS();
    sockets.push(ws);
    send(ws, 'join_room', { roomCode: code, userName: `P${i}` });
    await waitMsg(ws, 'join_room_ok');
  }

  const ws4 = await openWS();
  send(ws4, 'join_room', { roomCode: code, userName: 'P4' });
  const err = await waitMsg(ws4, 'error');
  assert.equal(err.code, 'ROOM_FULL');

  ws4.close();
  for (const ws of sockets) ws.close();
});

test('静音与屏幕共享状态广播', async () => {
  const { data } = await createRoom('状态广播', 'Alice');
  const code = data.roomCode;

  const wsA = await openWS();
  send(wsA, 'join_room', { roomCode: code, userName: 'Alice' });
  const okA = await waitMsg(wsA, 'join_room_ok');

  const wsB = await openWS();
  const joinedP = waitMsg(wsA, 'member_joined');
  send(wsB, 'join_room', { roomCode: code, userName: 'Bob' });
  await joinedP;
  await waitMsg(wsB, 'join_room_ok');

  // A 静音 → B 收到 member_muted
  const mutedP = waitMsg(wsB, 'member_muted');
  send(wsA, 'mute_toggle', { muted: true });
  const muted = await mutedP;
  assert.equal(muted.userId, okA.self.userId);
  assert.equal(muted.muted, true);

  // A 开始共享 → B 收到 screen_share_started
  const shareP = waitMsg(wsB, 'screen_share_started');
  send(wsA, 'start_screen_share', {});
  const share = await shareP;
  assert.equal(share.userId, okA.self.userId);

  // 房间信息反映状态
  const infoRes = await fetch(`${base}/api/rooms/${code}`);
  const info = await infoRes.json();
  const alice = info.data.members.find((m) => m.userName === 'Alice');
  assert.equal(alice.muted, true);
  assert.equal(alice.isScreenSharing, true);

  wsA.close();
  wsB.close();
});

test('P2P WebRTC 信令仅转发给同房间目标成员', async () => {
  const { data } = await createRoom('P2P信令', 'Alice');
  const code = data.roomCode;

  const wsA = await openWS();
  send(wsA, 'join_room', { roomCode: code, userName: 'Alice' });
  const okA = await waitMsg(wsA, 'join_room_ok');

  const wsB = await openWS();
  const joinedP = waitMsg(wsA, 'member_joined');
  send(wsB, 'join_room', { roomCode: code, userName: 'Bob' });
  await joinedP;
  const okB = await waitMsg(wsB, 'join_room_ok');

  // A → B 发送 offer，B 应收到转发
  const sigP = waitMsg(wsB, 'webrtc_signal');
  send(wsA, 'webrtc_signal', {
    target: okB.self.userId,
    data: { kind: 'offer', sdp: 'fake-sdp' },
  });
  const sig = await sigP;
  assert.equal(sig.from, okA.self.userId);
  assert.equal(sig.data.kind, 'offer');
  assert.equal(sig.data.sdp, 'fake-sdp');

  // B → A 回 answer
  const answerP = waitMsg(wsA, 'webrtc_signal');
  send(wsB, 'webrtc_signal', {
    target: okA.self.userId,
    data: { kind: 'answer', sdp: 'fake-answer' },
  });
  const answer = await answerP;
  assert.equal(answer.data.kind, 'answer');

  // 跨房间不转发：C 在另一个房间，A 发 C → C 不应收到（B 也不应收到）
  const { data: data2 } = await createRoom('P2P信令2', 'C');
  const wsC = await openWS();
  send(wsC, 'join_room', { roomCode: data2.roomCode, userName: 'Carol' });
  const okC = await waitMsg(wsC, 'join_room_ok');

  let leaked = false;
  const leakWatch = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'webrtc_signal' && m.payload.from === okA.self.userId) leaked = true;
  };
  wsC.onmessage = leakWatch;
  send(wsA, 'webrtc_signal', {
    target: okC.self.userId,
    data: { kind: 'offer', sdp: 'cross-room' },
  });
  await new Promise((r) => setTimeout(r, 300));
  wsC.onmessage = null;
  assert.equal(leaked, false, '跨房间信令不应被转发');

  wsA.close();
  wsB.close();
  wsC.close();
});

test('活跃房间列表按创建时间排序且返回成员数', async () => {
  const r1 = await createRoom('房间甲', 'A');
  await createRoom('房间乙', 'B');

  const res = await fetch(`${base}/api/rooms`);
  const body = await res.json();
  const found = body.data.rooms.find((r) => r.roomCode === r1.data.roomCode);
  assert.ok(found);
  assert.equal(found.roomName, '房间甲');
  assert.equal(typeof found.memberCount, 'number');
});
