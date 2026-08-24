<template>
  <div class="grid">
    <div v-for="m in members" :key="m.userId" class="member-card" :class="{ self: m.userId === selfId }">
      <div class="avatar" :style="{ background: colorOf(m.userId) }">
        {{ avatarText(m.userName) }}
      </div>
      <div class="info">
        <div class="name-row">
          <span class="name">{{ m.userName }}<span v-if="m.userId === selfId" class="me">(我)</span></span>
          <span v-if="m.muted" class="badge muted" title="已静音">🔇</span>
          <span v-if="m.isScreenSharing" class="badge share" title="共享屏幕中">🖥</span>
        </div>
        <div class="status" :class="{ speaking: false }">在线</div>
      </div>
    </div>
  </div>
</template>

<script setup>
defineProps({
  members: { type: Array, default: () => [] },
  selfId: { type: String, default: '' },
});

const COLORS = [
  '#5865f2', '#eb459e', '#faa61a', '#3ba55d',
  '#f23f43', '#9b59b6', '#e67e22', '#1abc9c',
];

function colorOf(userId) {
  let h = 0;
  for (const ch of String(userId)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

function avatarText(name) {
  const s = String(name || '?').trim();
  if (!s) return '?';
  // 中文取前 2 字，英文取前 2 字母
  return s.slice(0, 2).toUpperCase();
}
</script>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 12px;
}
.member-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  transition: border-color 0.15s;
}
.member-card.self {
  border-color: var(--accent);
}
.avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-weight: 700;
  font-size: 15px;
  flex-shrink: 0;
}
.info {
  min-width: 0;
}
.name-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.name {
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.me {
  color: var(--text-muted);
  font-weight: 400;
  font-size: 12px;
}
.badge {
  font-size: 12px;
}
.status {
  font-size: 12px;
  color: var(--green);
}
</style>
