import { ref } from 'vue';
import TRTC from 'trtc-sdk-v5';

/**
 * 腾讯云 TRTC 媒体层（商业 RTC：全国边缘节点 + 弱网对抗，画质对标 KOOK）
 *
 * 接口与 useLiveKit / useWebRTC 对齐：connect / toggleMute / toggleScreenShare / disconnect
 * 屏幕共享走 TRTC 辅流（STREAM_TYPE_SUB），观看端通过 REMOTE_VIDEO_AVAILABLE 事件接收。
 *
 * 事件回调（由调用方注入）：
 *  - onRemoteShareTrack(userId, viewEl)：远端屏幕共享（viewEl 为容器元素，SDK 内部渲染 video）
 *  - onScreenShareStopped(userId)
 */

/** 分享画质 → TRTC ScreenShareProfile 自定义档位（无 60fps 预设，用对象自定义） */
export const TRTC_PROFILES = {
  '1080p': { width: 1920, height: 1080, frameRate: 60, bitrate: 8000 },
  '720p': { width: 1280, height: 720, frameRate: 30, bitrate: 3000 },
  '480p': { width: 640, height: 480, frameRate: 30, bitrate: 1000 },
};

export function useTRTC() {
  const connected = ref(false);
  const isMuted = ref(false);
  const isSharing = ref(false);
  const error = ref('');

  let trtc = null;
  let onRemoteShareTrack = null;
  let onScreenShareStopped = null;
  let onQualityDegrade = null;
  let currentProfileKey = '720p';
  /** 观看端已播放的远端屏幕共享（userId -> view 元素），用于离开时清理 */
  const remoteScreenViews = new Map();

  function bindCallbacks(opts = {}) {
    onRemoteShareTrack = opts.onRemoteShareTrack || null;
    onScreenShareStopped = opts.onScreenShareStopped || null;
    onQualityDegrade = opts.onQualityDegrade || null;
  }

  /**
   * 进入 TRTC 房间并开麦
   * @param {object} cfg { sdkAppId, userId, userSig, roomId }（信令服务器签发）
   */
  async function connect(cfg = {}) {
    disconnect();
    error.value = '';
    if (!cfg.sdkAppId || !cfg.userSig) {
      throw new Error('TRTC 配置缺失');
    }

    trtc = TRTC.create();

    // 远端视频可用（只处理屏幕共享辅流，摄像头主流忽略——本产品无摄像头场景）
    trtc.on(TRTC.EVENT.REMOTE_VIDEO_AVAILABLE, ({ userId, streamType }) => {
      if (streamType !== TRTC.TYPE.STREAM_TYPE_SUB) return;
      const view = document.createElement('div');
      view.className = 'trtc-screen-view';
      view.style.cssText = 'width:100%;height:100%;';
      trtc.startRemoteVideo({ userId, streamType, view }).catch(() => {});
      remoteScreenViews.set(userId, view);
      onRemoteShareTrack?.(userId, view);
    });

    // 远端视频停止（屏幕共享结束）
    const onVideoUnavailable = ({ userId, streamType }) => {
      if (streamType !== TRTC.TYPE.STREAM_TYPE_SUB) return;
      remoteScreenViews.delete(userId);
      onScreenShareStopped?.(userId);
    };
    if (TRTC.EVENT.REMOTE_VIDEO_UNAVAILABLE) {
      trtc.on(TRTC.EVENT.REMOTE_VIDEO_UNAVAILABLE, onVideoUnavailable);
    }

    // 远端离开房间时清理其屏幕共享画面
    if (TRTC.EVENT.PEER_LEAVE) {
      trtc.on(TRTC.EVENT.PEER_LEAVE, ({ userId }) => {
        remoteScreenViews.delete(userId);
        onScreenShareStopped?.(userId);
      });
    }

    // 远端音频默认自动播放（含屏幕共享系统声音，按 userId 自动混音）
    if (TRTC.EVENT.REMOTE_AUDIO_AVAILABLE) {
      trtc.on(TRTC.EVENT.REMOTE_AUDIO_AVAILABLE, ({ userId }) => {
        // 自动播放策略被拦截时由 SDK 内部处理；此处无需额外操作
        void userId;
      });
    }

    await trtc.enterRoom({
      sdkAppId: cfg.sdkAppId,
      userId: cfg.userId,
      userSig: cfg.userSig,
      roomId: Number(cfg.roomId),
      autoReceiveAudio: true,
    });
    connected.value = true;

    // 默认打开麦克风
    await trtc.startLocalAudio();
    isMuted.value = false;
  }

  /** 静音/取消静音 */
  async function toggleMute() {
    if (!trtc) return isMuted.value;
    if (isMuted.value) {
      await trtc.startLocalAudio();
      isMuted.value = false;
    } else {
      await trtc.stopLocalAudio();
      isMuted.value = true;
    }
    return isMuted.value;
  }

  /**
   * 开始/停止屏幕共享（TRTC 辅流）
   * @param {string} resolutionKey 画质档位（TRTC_PROFILES）
   * @param {boolean} withAudio 是否采集系统声音
   * @param {string} _codec 忽略（TRTC 自动选择最优编码）
   * @param {string} strategy 'auto'|'clarity'|'smooth' → qosPreference（弱网取舍）
   */
  async function toggleScreenShare(resolutionKey = '720p', withAudio = false, _codec = 'h264', strategy = 'auto') {
    if (!trtc) return false;
    if (isSharing.value) {
      await trtc.stopScreenShare();
      isSharing.value = false;
      return false;
    }
    const profile = TRTC_PROFILES[resolutionKey] || TRTC_PROFILES['720p'];
    currentProfileKey = resolutionKey;
    await trtc.startScreenShare({
      option: {
        profile,
        systemAudio: withAudio,
        qosPreference:
          strategy === 'smooth'
            ? TRTC.TYPE.QOS_PREFERENCE_SMOOTH
            : TRTC.TYPE.QOS_PREFERENCE_CLEAR,
      },
    });
    isSharing.value = true;
    return true;
  }

  /** 分享中动态切换画质档位（网络自适应降级用） */
  async function setScreenShareProfile(key) {
    if (!trtc || !isSharing.value) return;
    const profile = TRTC_PROFILES[key];
    if (!profile) return;
    try {
      await trtc.updateScreenShare({ option: { profile } });
      currentProfileKey = key;
      onQualityDegrade?.('', key);
    } catch {
      /* 忽略 */
    }
  }

  /**
   * 观看端切换远端共享清晰度（TRTC 大小流：small=true 拉小流）
   * @param {string} identity 远端 userId
   * @param {number|null} quality 0=LOW(小流) / 1=MEDIUM / 2=HIGH / null=auto
   */
  async function setRemoteVideoQuality(identity, quality) {
    if (!trtc) return;
    if (!remoteScreenViews.has(identity)) return;
    // TRTC 只有大小流两档：质量≤LOW 用大流，否则切小流保流畅
    const small = quality === 0;
    try {
      await trtc.updateRemoteVideo({
        userId: identity,
        streamType: TRTC.TYPE.STREAM_TYPE_SUB,
        option: { small },
      });
    } catch {
      /* 忽略 */
    }
  }

  function disconnect() {
    const t = trtc;
    if (t) {
      try {
        t.exitRoom();
      } catch {
        /* ignore */
      }
      try {
        t.destroy();
      } catch {
        /* ignore */
      }
    }
    trtc = null;
    remoteScreenViews.clear();
    connected.value = false;
    isMuted.value = false;
    isSharing.value = false;
  }

  return {
    connected,
    isMuted,
    isSharing,
    error,
    bindCallbacks,
    connect,
    toggleMute,
    toggleScreenShare,
    setScreenShareProfile,
    setRemoteVideoQuality,
    disconnect,
  };
}
