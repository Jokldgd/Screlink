<template>
  <footer class="bar">
    <button
      class="bar-btn"
      :class="{ active: muted, disabled: !configured }"
      :disabled="!configured"
      :title="configured ? (muted ? '取消静音' : '静音') : '演示模式：语音不可用'"
      @click="$emit('toggle-mute')"
    >
      <span class="icon">{{ muted ? '🔇' : '🎤' }}</span>
      <span class="label">{{ muted ? '已静音' : '麦克风' }}</span>
    </button>

    <button
      class="bar-btn"
      :class="{ active: sharing, disabled: !configured }"
      :disabled="!configured"
      :title="configured ? (sharing ? '停止共享' : '共享屏幕') : '演示模式：共享不可用'"
      @click="$emit('toggle-share')"
    >
      <span class="icon">{{ sharing ? '🖥' : '📺' }}</span>
      <span class="label">{{ sharing ? '停止共享' : '共享屏幕' }}</span>
    </button>

    <!-- 分享画质选择（分享端采集分辨率） -->
    <label
      class="bar-select"
      :class="{ disabled: !configured || sharing }"
      :title="sharing ? '停止共享后可修改分享画质' : '选择共享画面的清晰度'"
    >
      <span class="label">分享画质</span>
      <select
        :value="shareQuality"
        :disabled="!configured || sharing"
        @change="$emit('set-share-quality', $event.target.value)"
      >
        <option value="1080p">1080p 超清 · 60fps</option>
        <option value="720p">720p 高清 · 30fps</option>
        <option value="480p">480p 流畅 · 30fps</option>
      </select>
    </label>

    <!-- 画质策略（带宽受限时的取舍方向） -->
    <label
      class="bar-select"
      :class="{ disabled: !configured || sharing }"
      :title="sharing ? '停止共享后可修改' : '带宽不足时优先保什么：清晰度或流畅度'"
    >
      <span class="label">策略</span>
      <select
        :value="shareStrategy"
        :disabled="!configured || sharing"
        @change="$emit('set-share-strategy', $event.target.value)"
      >
        <option value="auto">智能（推荐）</option>
        <option value="clarity">清晰优先</option>
        <option value="smooth">流畅优先</option>
      </select>
    </label>

    <!-- 编码器选择（仅 LiveKit 模式；TRTC 自动选择最优编码） -->
    <label
      v-if="showCodecSelect"
      class="bar-select"
      :class="{ disabled: !configured || sharing }"
      :title="sharing ? '停止共享后可修改' : 'H264 硬编画质更好、CPU占用低；VP8 兼容性最广'"
    >
      <span class="label">编码器</span>
      <select
        :value="shareCodec"
        :disabled="!configured || sharing"
        @change="$emit('set-share-codec', $event.target.value)"
      >
        <option value="h264">H264（推荐）</option>
        <option value="vp8">VP8（兼容）</option>
      </select>
    </label>

    <!-- 分享系统声音开关（仅 LiveKit 模式；观看端可调节音量） -->
    <label
      class="bar-select audio-toggle"
      :class="{ disabled: !audioShareEnabled || sharing }"
      :title="!audioShareEnabled ? '系统声音仅 LiveKit 模式可用' : (sharing ? '停止共享后可修改' : '共享时同时分享系统声音')"
    >
      <span class="label">{{ shareAudio ? '🔊 系统声音' : '🔇 系统声音' }}</span>
      <input
        type="checkbox"
        :checked="shareAudio"
        :disabled="!audioShareEnabled || sharing"
        @change="$emit('toggle-share-audio', $event.target.checked)"
      />
    </label>

    <div class="bar-code" :title="'点击复制房间号：' + roomCode" @click="$emit('copy-code')">
      <span class="icon">📋</span>
      <span class="label code-text"># {{ roomCode }}</span>
    </div>

    <button class="bar-btn danger" title="离开房间" @click="$emit('leave')">
      <span class="icon">🚪</span>
      <span class="label">离开</span>
    </button>
  </footer>
</template>

<script setup>
defineProps({
  muted: { type: Boolean, default: false },
  sharing: { type: Boolean, default: false },
  configured: { type: Boolean, default: false },
  roomCode: { type: String, default: '' },
  shareQuality: { type: String, default: '720p' },
  shareAudio: { type: Boolean, default: false },
  audioShareEnabled: { type: Boolean, default: false },
  shareCodec: { type: String, default: 'h264' },
  shareStrategy: { type: String, default: 'auto' },
  /** 是否显示编码器下拉（仅 LiveKit 模式） */
  showCodecSelect: { type: Boolean, default: false },
});

defineEmits(['toggle-mute', 'toggle-share', 'leave', 'copy-code', 'set-share-quality', 'toggle-share-audio', 'set-share-codec', 'set-share-strategy']);
</script>

<style scoped>
.bar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 14px 20px;
  background: var(--bg-panel);
  border-top: 1px solid var(--border);
  flex-wrap: wrap;
}
.bar-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  min-width: 72px;
  padding: 8px 14px;
  border-radius: var(--radius);
  background: var(--bg-elevated);
  color: var(--text-secondary);
  transition: background 0.15s;
}
.bar-btn:hover:not(:disabled) {
  background: var(--bg-hover);
}
.bar-btn .icon {
  font-size: 20px;
}
.bar-btn .label {
  font-size: 12px;
}
.bar-btn.active {
  background: var(--accent);
  color: #fff;
}
.bar-btn.disabled {
  opacity: 0.45;
}
.bar-btn.danger {
  background: transparent;
}
.bar-btn.danger:hover:not(:disabled) {
  background: var(--red);
  color: #fff;
}
.bar-code {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-radius: var(--radius);
  cursor: pointer;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  border: 1px dashed var(--border);
}
.bar-code:hover {
  color: var(--accent);
  border-color: var(--accent);
}
.bar-select {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-radius: var(--radius);
  background: var(--bg-elevated);
  color: var(--text-secondary);
  cursor: pointer;
}
.bar-select.disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.bar-select .label {
  font-size: 12px;
}
.bar-select select {
  background: var(--bg-deep);
  color: var(--text-primary);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 3px 6px;
  font-size: 12px;
  outline: none;
  cursor: pointer;
}
.bar-select select:disabled {
  cursor: not-allowed;
}
.audio-toggle input[type='checkbox'] {
  accent-color: var(--accent);
  width: 15px;
  height: 15px;
  cursor: pointer;
}
.audio-toggle.disabled input[type='checkbox'] {
  cursor: not-allowed;
}
</style>
