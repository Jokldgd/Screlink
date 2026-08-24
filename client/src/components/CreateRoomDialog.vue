<template>
  <div class="card">
    <!-- 状态 1：输入房间名 -->
    <template v-if="stage === 'form'">
      <div class="card-icon">🆕</div>
      <h2>创建房间</h2>
      <p class="desc">创建一个临时语音房，生成 6 位房间号分享给朋友加入</p>
      <input v-model="roomName" class="input" maxlength="30" placeholder="房间名，如：周末开黑" @keyup.enter="create" />
      <input v-model="userName" class="input" maxlength="20" placeholder="你的昵称" @keyup.enter="create" />
      <button class="btn btn-primary btn-block" :disabled="busy" @click="create">
        {{ busy ? '创建中…' : '创建房间' }}
      </button>
    </template>

    <!-- 状态 2：展示房间号 -->
    <template v-else-if="stage === 'code'">
      <div class="card-icon">🎉</div>
      <h2>房间创建成功</h2>
      <p class="desc">「{{ createdRoomName }}」—— 把这个房间号发给朋友吧</p>
      <div class="code-box">
        <span class="big-code">{{ roomCode }}</span>
        <button class="btn btn-secondary btn-sm" @click="copyCode">{{ copied ? '已复制 ✓' : '复制号码' }}</button>
      </div>
      <button class="btn btn-primary btn-block" @click="enterRoom">进入房间</button>
    </template>

    <p v-if="error" class="error">{{ error }}</p>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useRoomStore } from '../stores/roomStore.js';
import { getStoredName, storeName } from '../utils/name.js';

const router = useRouter();
const roomStore = useRoomStore();

const stage = ref('form');
const roomName = ref('');
const userName = ref(getStoredName());
const createdRoomName = ref('');
const roomCode = ref('');
const busy = ref(false);
const copied = ref(false);
const error = ref('');

async function create() {
  error.value = '';
  if (!roomName.value.trim()) {
    error.value = '请输入房间名';
    return;
  }
  if (!userName.value.trim()) {
    error.value = '请输入你的昵称';
    return;
  }
  busy.value = true;
  try {
    const data = await roomStore.createRoom({
      roomName: roomName.value.trim(),
      userName: userName.value.trim(),
    });
    storeName(userName.value.trim());
    roomCode.value = data.roomCode;
    createdRoomName.value = data.roomName;
    stage.value = 'code';
  } catch (e) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}

async function copyCode() {
  try {
    await navigator.clipboard.writeText(roomCode.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    error.value = '复制失败，请手动选择号码复制';
  }
}

function enterRoom() {
  router.push(`/room/${roomCode.value}`);
}
</script>

<style scoped>
.card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 28px 24px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
}
.card-icon {
  font-size: 30px;
}
h2 {
  font-size: 18px;
}
.desc {
  color: var(--text-muted);
  font-size: 13px;
}
.btn-block {
  width: 100%;
  margin-top: 4px;
}
.btn-sm {
  padding: 6px 12px;
  font-size: 13px;
}
.code-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  background: var(--bg-deep);
  border-radius: var(--radius);
  border: 1px solid var(--border);
}
.big-code {
  font-size: 30px;
  font-weight: 800;
  letter-spacing: 6px;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}
.error {
  color: var(--red);
  font-size: 13px;
}
</style>
