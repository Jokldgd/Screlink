<template>
  <div class="card">
    <div class="card-icon">🔑</div>
    <h2>加入房间</h2>
    <p class="desc">输入朋友分享给你的 6 位房间号加入语音房</p>
    <input
      v-model="roomCode"
      class="input input-code"
      maxlength="6"
      placeholder="房间号，如 483920"
      inputmode="numeric"
      autocomplete="off"
      @input="onInput"
      @keyup.enter="join"
    />
    <input v-model="userName" class="input" maxlength="20" placeholder="你的昵称" @keyup.enter="join" />
    <button class="btn btn-secondary btn-block" :disabled="busy" @click="join">
      {{ busy ? '加入中…' : '加入房间' }}
    </button>
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

const roomCode = ref('');
const userName = ref(getStoredName());
const busy = ref(false);
const error = ref('');

function onInput() {
  // 仅允许数字
  roomCode.value = roomCode.value.replace(/\D/g, '').slice(0, 6);
}

async function join() {
  error.value = '';
  if (!/^\d{6}$/.test(roomCode.value)) {
    error.value = '房间号必须是 6 位数字';
    return;
  }
  if (!userName.value.trim()) {
    error.value = '请输入你的昵称';
    return;
  }
  busy.value = true;
  storeName(userName.value.trim());
  router.push(`/room/${roomCode.value}`);
  // 加入校验在 RoomView 中完成；这里不阻塞
  busy.value = false;
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
.error {
  color: var(--red);
  font-size: 13px;
}
</style>
