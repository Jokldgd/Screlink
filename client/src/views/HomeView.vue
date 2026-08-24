<template>
  <div class="home">
    <header class="home-header">
      <div class="logo">
        <span class="logo-badge">🎙</span>
        <span class="logo-text">RoomVoice <em>临时语音房</em></span>
      </div>
      <div class="conn-status" :class="{ ok: wsConnected }">
        <span class="dot"></span>{{ wsConnected ? '信令已连接' : '信令连接中…' }}
      </div>
    </header>

    <main class="home-main">
      <h1 class="title">创建房间，分享号码，即刻开聊</h1>
      <p class="subtitle">临时语音房 · 最多 10 人 · 人走房销 · 支持语音与屏幕共享</p>

      <div class="cards">
        <!-- 创建房间 -->
        <CreateRoomDialog />
        <!-- 加入房间 -->
        <JoinRoomDialog />
      </div>

      <!-- 活跃房间（仅信息展示） -->
      <section class="active-rooms">
        <div class="section-title">
          <span>🟢 当前活跃房间（仅展示，进入请凭房间号）</span>
          <span class="refresh" @click="refreshRooms">刷新</span>
        </div>
        <div v-if="rooms.length === 0" class="empty">暂无活跃房间，点击上方「创建房间」发起一个吧</div>
        <div v-else class="room-list">
          <div v-for="r in rooms" :key="r.roomCode" class="room-item">
            <span class="room-name">{{ r.roomName }}</span>
            <span class="room-code"># {{ r.roomCode }}</span>
            <span class="room-count">{{ r.memberCount }}/{{ r.maxMembers }} 人</span>
          </div>
        </div>
      </section>
    </main>

    <footer class="home-footer">临时房间 · 数据不持久化 · 最后一人离开后房间自动销毁</footer>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import CreateRoomDialog from '../components/CreateRoomDialog.vue';
import JoinRoomDialog from '../components/JoinRoomDialog.vue';
import { listRooms } from '../api/http.js';
import { signal } from '../api/ws.js';

const rooms = ref([]);
const wsConnected = ref(false);

let timer = null;

async function refreshRooms() {
  try {
    rooms.value = (await listRooms()).rooms;
  } catch {
    /* 忽略 */
  }
}

onMounted(() => {
  signal.onStatusChange((ok) => (wsConnected.value = ok));
  signal.connect();
  refreshRooms();
  timer = setInterval(refreshRooms, 10000);
});

onUnmounted(() => {
  clearInterval(timer);
  signal.onStatusChange(() => {});
});
</script>

<style scoped>
.home {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.home-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 32px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
}
.logo {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 18px;
  font-weight: 700;
}
.logo-badge {
  font-size: 24px;
}
.logo-text em {
  font-style: normal;
  font-size: 12px;
  color: var(--text-muted);
  font-weight: 400;
  margin-left: 6px;
}
.conn-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-muted);
}
.conn-status .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--yellow);
}
.conn-status.ok .dot {
  background: var(--green);
}

.home-main {
  flex: 1;
  max-width: 860px;
  width: 100%;
  margin: 0 auto;
  padding: 48px 24px 24px;
}
.title {
  font-size: 28px;
  font-weight: 700;
  text-align: center;
}
.subtitle {
  text-align: center;
  color: var(--text-muted);
  margin: 8px 0 32px;
}

.cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.active-rooms {
  margin-top: 40px;
}
.section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 10px;
}
.refresh {
  cursor: pointer;
  color: var(--accent);
  font-size: 12px;
}
.refresh:hover {
  text-decoration: underline;
}
.empty {
  padding: 24px;
  text-align: center;
  color: var(--text-muted);
  background: var(--bg-panel);
  border-radius: var(--radius-lg);
  border: 1px dashed var(--border);
}
.room-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.room-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: var(--bg-panel);
  border-radius: var(--radius);
  border: 1px solid var(--border);
}
.room-name {
  font-weight: 500;
}
.room-code {
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  font-size: 13px;
}
.room-count {
  margin-left: auto;
  color: var(--text-secondary);
  font-size: 13px;
}

.home-footer {
  text-align: center;
  padding: 16px;
  color: var(--text-muted);
  font-size: 12px;
  border-top: 1px solid var(--border);
}

@media (max-width: 720px) {
  .cards {
    grid-template-columns: 1fr;
  }
}
</style>
