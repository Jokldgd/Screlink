<template>
  <section class="share-area" :class="{ active: hasContent }">
    <!-- 空状态 -->
    <div v-if="!hasContent" class="share-empty">
      <span class="icon">🖥</span>
      <span>{{ demo ? '（演示模式：未配置 LiveKit，无屏幕共享）' : '暂无屏幕共享' }}</span>
    </div>

    <!-- 本端共享 -->
    <div v-else-if="selfSharing && videos.length === 0" class="share-self">
      <span class="live-tag">● LIVE</span>
      <span>你正在共享屏幕（{{ selfShareQualityLabel }}）</span>
      <p class="hint">其他成员已可看到你的画面，点击底部「停止共享」结束</p>
    </div>

    <!-- 远端共享视频容器 -->
    <div v-else ref="container" class="share-container">
      <!-- 观看端控制条：清晰度 + 音量 + 全屏 -->
      <div v-if="videos.length > 0" class="ctrl-bar">
        <!-- 清晰度（Simulcast 码流切换） -->
        <template v-if="watchSwitchable">
          <span class="q-label">清晰度</span>
          <select :value="watchQuality" @change="$emit('set-watch-quality', $event.target.value)">
            <option value="auto">自动</option>
            <option value="1080p">1080p</option>
            <option value="720p">720p</option>
            <option value="480p">480p</option>
          </select>
        </template>
        <span v-else class="q-locked" title="P2P 直连为单码流，清晰度由分享端决定">清晰度 🔒</span>

        <!-- 音量（分享端开启了系统声音时显示） -->
        <template v-if="screenAudio">
          <button class="icon-btn" :title="audioMuted ? '取消静音' : '静音'" @click="toggleAudioMute">
            {{ audioMuted ? '🔇' : '🔊' }}
          </button>
          <input
            class="vol-slider"
            type="range"
            min="0"
            max="1"
            step="0.05"
            :value="volume"
            :disabled="audioMuted"
            title="分享画面音量"
            @input="onVolume"
          />
        </template>

        <!-- 全屏 -->
        <button class="icon-btn" :title="isFullscreen ? '退出全屏' : '全屏观看'" @click="toggleFullscreen">
          {{ isFullscreen ? '⤢ 退出全屏' : '⛶ 全屏' }}
        </button>
      </div>
    </div>
  </section>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';

const props = defineProps({
  /** [{ identity, el }] el 为 track.attach() 返回的 video 元素 */
  videos: { type: Array, default: () => [] },
  selfSharing: { type: Boolean, default: false },
  demo: { type: Boolean, default: false },
  /** 观看端是否可切换清晰度（LiveKit Simulcast 才有；P2P 单码流为 false） */
  watchSwitchable: { type: Boolean, default: false },
  watchQuality: { type: String, default: 'auto' },
  selfShareQualityLabel: { type: String, default: '720p 高清' },
  /** 屏幕共享音频元素（{ identity, el }），存在时显示音量控制 */
  screenAudio: { type: Object, default: null },
});

defineEmits(['set-watch-quality']);

const container = ref(null);
const appended = new Set();
const volume = ref(1);
const audioMuted = ref(false);
const isFullscreen = ref(false);

const hasContent = computed(
  () => props.videos.length > 0 || props.selfSharing || props.demo,
);

watch(
  () => props.videos,
  (videos) => {
    nextTick(() => {
      if (!container.value) return;
      for (const v of videos) {
        if (!appended.has(v.identity)) {
          container.value.appendChild(v.el);
          appended.add(v.identity);
        }
      }
    });
  },
  { deep: true, immediate: true },
);

// ---------- 音量控制（作用于屏幕共享音频元素） ----------
function applyAudio() {
  const el = props.screenAudio?.el;
  if (!el) return;
  el.volume = audioMuted.value ? 0 : volume.value;
  el.muted = audioMuted.value;
}

watch(
  () => props.screenAudio,
  () => {
    if (!props.screenAudio) {
      volume.value = 1;
      audioMuted.value = false;
      return;
    }
    applyAudio();
  },
);

function onVolume(e) {
  volume.value = Number(e.target.value);
  if (audioMuted.value) audioMuted.value = false;
  applyAudio();
}

function toggleAudioMute() {
  audioMuted.value = !audioMuted.value;
  applyAudio();
}

// ---------- 全屏 ----------
function onFullscreenChange() {
  isFullscreen.value = Boolean(document.fullscreenElement);
}

function toggleFullscreen() {
  if (!container.value) return;
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else {
    container.value.requestFullscreen?.().catch(() => {});
  }
}

onMounted(() => {
  document.addEventListener('fullscreenchange', onFullscreenChange);
});

onUnmounted(() => {
  document.removeEventListener('fullscreenchange', onFullscreenChange);
});
</script>

<style scoped>
.share-area {
  border-radius: var(--radius-lg);
  border: 1px solid var(--border);
  background: var(--bg-panel);
  overflow: hidden;
  min-height: 0;
  position: relative;
}
.share-area.active {
  height: 240px;
}
.share-empty {
  height: 84px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-muted);
  font-size: 13px;
}
.share-empty .icon {
  font-size: 22px;
}
.share-self {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--text-secondary);
  background: repeating-linear-gradient(
    -45deg,
    rgba(88, 101, 242, 0.08),
    rgba(88, 101, 242, 0.08) 12px,
    transparent 12px,
    transparent 24px
  );
}
.live-tag {
  font-size: 12px;
  font-weight: 700;
  color: var(--red);
  letter-spacing: 1px;
}
.hint {
  font-size: 12px;
  color: var(--text-muted);
}
.share-container {
  width: 100%;
  height: 100%;
  background: #000;
  position: relative;
}
.share-container :deep(video) {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
/* 全屏时视频铺满 */
.share-container:fullscreen :deep(video) {
  width: 100vw;
  height: 100vh;
}
.share-container:fullscreen .ctrl-bar {
  position: fixed;
  top: 12px;
  right: 16px;
}

/* 观看端控制条（右上角悬浮） */
.ctrl-bar {
  position: absolute;
  top: 10px;
  right: 12px;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(4px);
  color: #fff;
  font-size: 12px;
}
.ctrl-bar select {
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 6px;
  padding: 2px 6px;
  font-size: 12px;
  outline: none;
  cursor: pointer;
}
.ctrl-bar select option {
  color: #222;
}
.icon-btn {
  background: transparent;
  border: none;
  color: #fff;
  font-size: 13px;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
  white-space: nowrap;
}
.icon-btn:hover {
  background: rgba(255, 255, 255, 0.2);
}
.vol-slider {
  width: 80px;
  accent-color: var(--accent);
  cursor: pointer;
}
.q-locked {
  color: rgba(255, 255, 255, 0.75);
  font-size: 12px;
  white-space: nowrap;
}
</style>
