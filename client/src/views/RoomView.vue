<template>
  <div class="room">
    <!-- 加入中 -->
    <div v-if="joining" class="center-state">
      <span class="spinner"></span>
      <p>正在加入房间 #{{ code }} …</p>
    </div>

    <!-- 加入失败 -->
    <div v-else-if="joinError" class="center-state">
      <p class="err-icon">😕</p>
      <p class="err-text">{{ joinError }}</p>
      <button class="btn btn-primary" @click="router.push('/')">返回首页</button>
    </div>

    <!-- 房间内 -->
    <template v-else>
      <header class="room-header">
        <button class="btn btn-secondary btn-sm" @click="leave">← 离开</button>
        <div class="room-title">
          <span class="name">{{ store.roomName }}</span>
          <span class="code" :title="'点击复制房间号 '" @click="copyCode"># {{ store.roomCode }} 📋</span>
        </div>
        <div class="meta">
          <span class="count">{{ store.members.length }}/10 人</span>
          <span class="ws-dot" :class="{ ok: wsConnected }" :title="wsConnected ? '信令已连接' : '信令断开'"></span>
          <span class="demo-tag" :title="mediaMode === 'LiveKit' ? 'LiveKit SFU 媒体服务器' : 'P2P 直连（未配置 LiveKit）'">{{ mediaMode }}</span>
        </div>
      </header>

      <main class="room-main">
        <ScreenShareView
          :videos="shareVideos"
          :self-sharing="isSelfSharing"
          :demo="false"
          :watch-switchable="!isP2P"
          :watch-quality="watchQuality"
          :self-share-quality-label="shareQualityLabel"
          :screen-audio="screenAudio"
          @set-watch-quality="onWatchQuality"
        />
        <MemberGrid :members="store.members" :self-id="store.self?.userId" />
      </main>

      <ControlBar
        :muted="isMutedState"
        :sharing="isSharingState"
        :configured="true"
        :room-code="store.roomCode"
        :share-quality="shareQuality"
        :share-audio="shareAudio"
        :audio-share-enabled="!isP2P"
        :share-codec="shareCodec"
        :share-strategy="shareStrategy"
        :show-codec-select="store.livekitConfigured && !store.trtcConfigured"
        @toggle-mute="onToggleMute"
        @toggle-share="onToggleShare"
        @set-share-quality="onShareQuality"
        @toggle-share-audio="onShareAudio"
        @set-share-codec="onShareCodec"
        @set-share-strategy="onShareStrategy"
        @leave="leave"
      />
    </template>

    <Transition name="toast">
      <div v-if="toast" class="toast" :class="{ 'toast-error': toastError }">{{ toast }}</div>
    </Transition>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useRoomStore } from '../stores/roomStore.js';
import { signal } from '../api/ws.js';
import { useLiveKit } from '../composables/useLiveKit.js';
import { useWebRTC } from '../composables/useWebRTC.js';
import { useTRTC } from '../composables/useTRTC.js';
import { getStoredName } from '../utils/name.js';
import ScreenShareView from '../components/ScreenShareView.vue';
import MemberGrid from '../components/MemberGrid.vue';
import ControlBar from '../components/ControlBar.vue';

const route = useRoute();
const router = useRouter();
const store = useRoomStore();
const code = String(route.params.code);

const joining = ref(true);
const joinError = ref('');
const wsConnected = ref(signal.connected);
const toast = ref('');
const toastError = ref(false);

const trtcM = useTRTC();
const lk = useLiveKit();
const wr = useWebRTC();
const shareVideos = ref([]);
/** userId -> Audio 元素（P2P 模式远端语音播放） */
const audioEls = new Map();
/** 屏幕共享音频（{ identity, el }，LiveKit 模式分享端开启系统声音时存在） */
const screenAudio = ref(null);

/** 当前媒体模式：TRTC > LiveKit > P2P */
const mediaMode = computed(() => {
  if (store.trtcConfigured) return 'TRTC';
  if (store.livekitConfigured) return 'LiveKit';
  return 'P2P 直连';
});
const isP2P = computed(() => !store.trtcConfigured && !store.livekitConfigured);
/** 画质档位顺序（判断升降级用） */
const DEGRADE_ORDER = ['1080p', '720p', '480p'];
/** 统一媒体状态（三套实现取当前模式的一份） */
const isMutedState = computed(() => {
  if (store.trtcConfigured) return trtcM.isMuted.value;
  if (store.livekitConfigured) return lk.isMuted.value;
  return wr.isMuted.value;
});
const isSharingState = computed(() => {
  if (store.trtcConfigured) return trtcM.isSharing.value;
  if (store.livekitConfigured) return lk.isSharing.value;
  return wr.isSharing.value;
});
const isSelfSharing = computed(() => isSharingState.value);

/** 分享画质（发布端采集分辨率） */
const shareQuality = ref('720p');
const shareQualityLabel = computed(() => {
  const map = {
    '1080p': '1080p 超清 · 60fps',
    '720p': '720p 高清 · 30fps',
    '480p': '480p 流畅 · 30fps',
  };
  return map[shareQuality.value] || '720p 高清 · 30fps';
});
/** 分享时是否携带系统声音（观看端可调音量） */
const shareAudio = ref(false);
/** 分享编码器：h264（默认，硬编画质好） | vp8（兼容） */
const shareCodec = ref('h264');
/** 画质策略：auto 智能 | clarity 清晰优先 | smooth 流畅优先 */
const shareStrategy = ref('auto');
/** 观看清晰度（订阅端码流切换） */
const watchQuality = ref('auto');

function onShareQuality(q) {
  shareQuality.value = q;
  showToast('分享画质已设为 ' + shareQualityLabel.value);
}

function onShareCodec(c) {
  shareCodec.value = c;
  showToast(c === 'h264' ? '编码器：H264（硬编，画质更好）' : '编码器：VP8（兼容性最广）');
}

function onShareStrategy(s) {
  shareStrategy.value = s;
  const map = { auto: '智能（带宽不足时自动平衡）', clarity: '清晰优先（保清晰度，可能降帧）', smooth: '流畅优先（保帧率，可能降清晰度）' };
  showToast('画质策略：' + (map[s] || s));
}

function onShareAudio(on) {
  shareAudio.value = on;
  showToast(on ? '共享时将携带系统声音' : '共享时将不携带系统声音');
}

function onWatchQuality(q) {
  watchQuality.value = q;
  // 找到当前远端共享者，切换到对应码流（TRTC 大小流 / LiveKit Simulcast）
  const sharer = store.members.find((m) => m.isScreenSharing && m.userId !== store.self?.userId);
  if (!sharer || isP2P.value) return;
  const qualityMap = { auto: null, '480p': 0, '720p': 1, '1080p': 2 };
  if (store.trtcConfigured) {
    trtcM.setRemoteVideoQuality(sharer.userId, qualityMap[q] ?? null);
  } else if (store.livekitConfigured) {
    lk.setRemoteVideoQuality(sharer.userId, qualityMap[q] ?? null);
  }
}

let toastTimer = null;
function showToast(msg, isError = false) {
  toast.value = msg;
  toastError.value = isError;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = ''), 2600);
}

async function copyCode() {
  try {
    await navigator.clipboard.writeText(store.roomCode);
    showToast('房间号已复制：' + store.roomCode);
  } catch {
    showToast('复制失败，请手动复制');
  }
}

// ---------- 信令事件 ----------
function onSignal(type, payload) {
  // P2P 信令：SDP/ICE 点对点转发
  if (type === 'webrtc_signal') {
    wr.handleSignal(payload.from, payload.data).catch((e) => console.warn('[p2p] 信令处理失败:', e));
    return;
  }

  store.applyEvent(type, payload);

  if (type === 'member_joined') {
    wr.onPeerJoined(payload.member.userId);
  }
  if (type === 'member_left') {
    wr.onPeerLeft(payload.userId);
  }

  if (type === 'room_destroyed') {
    showToast('房间已解散（最后一人离开）', true);
    trtcM.disconnect();
    lk.disconnect();
    wr.disconnect();
    store.reset();
    setTimeout(() => router.push('/'), 1600);
  }
}

// ---------- 加入房间 ----------
async function doJoin() {
  joining.value = true;
  joinError.value = '';
  try {
    if (!(store.joined && store.roomCode === code)) {
      await store.joinRoom(code, getStoredName() || '游客');
    }
    if (store.trtcConfigured && store.trtc) {
      // 模式 A：腾讯云 TRTC（商业 RTC，优先）
      trtcM.bindCallbacks({
        onRemoteShareTrack: (userId, viewEl) => {
          shareVideos.value = shareVideos.value.filter((v) => v.identity !== userId);
          shareVideos.value.push({ identity: userId, el: viewEl });
        },
        onScreenShareStopped: (userId) => {
          shareVideos.value = shareVideos.value.filter((v) => {
            if (v.identity === userId) {
              try {
                v.el.remove();
              } catch {
                /* ignore */
              }
              return false;
            }
            return true;
          });
        },
      });
      await trtcM.connect({
        sdkAppId: store.trtc.sdkAppId,
        userId: store.trtc.userId,
        userSig: store.trtc.userSig,
        roomId: store.trtc.roomId,
      });
    } else if (store.livekitConfigured && store.livekitToken) {
      // 模式 B：LiveKit SFU（配置了 LIVEKIT_* 时）
      lk.bindCallbacks({
        onRemoteShareTrack: (identity, track) => {
          const el = track.attach();
          el.autoplay = true;
          el.playsInline = true;
          shareVideos.value.push({ identity, el });
        },
        onScreenShareStopped: (identity) => {
          shareVideos.value = shareVideos.value.filter((v) => {
            if (v.identity === identity) {
              try {
                v.el.remove();
              } catch {
                /* ignore */
              }
              return false;
            }
            return true;
          });
          if (screenAudio.value?.identity === identity) screenAudio.value = null;
        },
        onScreenAudioTrack: (identity, el) => {
          screenAudio.value = { identity, el };
        },
        onQualityDegrade: (from, to) => {
          const label = {
            '1080p': '1080p 超清 60fps',
            '720p': '720p 高清 30fps',
            '480p': '480p 流畅 30fps',
          };
          const dir = DEGRADE_ORDER.indexOf(to) > DEGRADE_ORDER.indexOf(from) ? 'down' : 'up';
          if (dir === 'down') {
            showToast(`⚠️ 网络不佳，已自动降低分享画质至 ${label[to]}（流畅优先）`);
          } else {
            showToast(`✅ 网络恢复，已自动提升分享画质至 ${label[to]}`);
          }
        },
      });
      try {
        await lk.connect(store.livekitUrl, store.livekitToken);
      } catch (e) {
        // LiveKit 不可达 → 自动降级 P2P 直连
        console.warn('[media] LiveKit 连接失败，降级 P2P 直连:', e?.message || e);
        lk.disconnect();
        wr.connect({
          selfId: store.self.userId,
          members: store.members,
          sendSignal: (target, data) => signal.send('webrtc_signal', { target, data }),
          onRemoteTrack: handleRemoteTrack,
          onRemoteEnded: handleRemoteEnded,
        });
        showToast('媒体服务器不可达，已切换 P2P 直连', true);
      }
    } else {
      // 模式 C：P2P 直连（无任何媒体服务器时的降级，WebRTC Mesh）
      wr.connect({
        selfId: store.self.userId,
        members: store.members,
        sendSignal: (target, data) => signal.send('webrtc_signal', { target, data }),
        onRemoteTrack: handleRemoteTrack,
        onRemoteEnded: handleRemoteEnded,
      });
    }
    joining.value = false;
  } catch (e) {
    joinError.value = e.message || '加入房间失败';
    joining.value = false;
  }
}

// ---------- P2P 媒体事件 ----------
function handleRemoteTrack(userId, kind, stream) {
  if (kind === 'audio') {
    const el = new Audio();
    el.srcObject = stream;
    el.autoplay = true;
    el.playsInline = true;
    el.play().catch(() => {});
    audioEls.get(userId)?.remove?.();
    audioEls.set(userId, el);
  } else if (kind === 'screen') {
    const el = document.createElement('video');
    el.srcObject = stream;
    el.autoplay = true;
    el.playsInline = true;
    shareVideos.value = shareVideos.value.filter((v) => v.identity !== userId);
    shareVideos.value.push({ identity: userId, el });
  }
}

function handleRemoteEnded(userId) {
  audioEls.get(userId)?.remove?.();
  audioEls.delete(userId);
  shareVideos.value = shareVideos.value.filter((v) => v.identity !== userId);
}

// ---------- 控制栏操作 ----------
async function onToggleMute() {
  let next;
  if (store.trtcConfigured) next = await trtcM.toggleMute();
  else if (store.livekitConfigured) next = await lk.toggleMute();
  else next = await wr.toggleMute();
  store.setSelfMuted(next);
}

async function onToggleShare() {
  try {
    let sharing;
    if (store.trtcConfigured) {
      sharing = await trtcM.toggleScreenShare(shareQuality.value, shareAudio.value, shareCodec.value, shareStrategy.value);
    } else if (store.livekitConfigured) {
      sharing = await lk.toggleScreenShare(shareQuality.value, shareAudio.value, shareCodec.value, shareStrategy.value);
    } else {
      sharing = await wr.toggleScreenShare(shareQuality.value);
    }
    if (sharing) {
      store.startScreenShare();
      const codecTag = store.livekitConfigured ? ` · ${shareCodec.value.toUpperCase()}` : '';
      const strategyTag = !isP2P.value
        ? ` · ${shareStrategy.value === 'auto' ? '智能' : shareStrategy.value === 'clarity' ? '清晰优先' : '流畅优先'}`
        : '';
      showToast(`正在共享屏幕（${shareQualityLabel.value}${codecTag}${strategyTag}${shareAudio.value ? ' · 含系统声音' : ''}）`);
    } else {
      store.stopScreenShare();
    }
  } catch (e) {
    showToast('无法开始共享：' + e.message, true);
  }
}

function leave() {
  trtcM.disconnect();
  lk.disconnect();
  wr.disconnect();
  store.leaveRoom();
  router.push('/');
}

// ---------- 生命周期 ----------
onMounted(() => {
  signal.onMessage(onSignal);
  signal.onStatusChange((ok) => (wsConnected.value = ok));
  signal.connect();
  doJoin();
});

onUnmounted(() => {
  signal.offMessage(onSignal);
  clearTimeout(toastTimer);
  trtcM.disconnect();
  lk.disconnect();
  wr.disconnect();
});
</script>

<style scoped>
.room {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

.center-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-secondary);
}
.spinner {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 3px solid var(--bg-elevated);
  border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.err-icon {
  font-size: 40px;
}
.err-text {
  color: var(--red);
  font-size: 16px;
  font-weight: 500;
}

.room-header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 20px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
}
.room-title {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}
.room-title .name {
  font-size: 16px;
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.room-title .code {
  color: var(--text-muted);
  font-size: 13px;
  cursor: pointer;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.room-title .code:hover {
  color: var(--accent);
}
.meta {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 10px;
}
.count {
  color: var(--text-secondary);
  font-size: 13px;
}
.ws-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--yellow);
}
.ws-dot.ok {
  background: var(--green);
}
.demo-tag {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--bg-elevated);
  color: var(--yellow);
  border: 1px solid var(--border);
}

.room-main {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
</style>
