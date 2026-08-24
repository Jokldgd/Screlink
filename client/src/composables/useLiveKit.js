import { ref, shallowRef } from 'vue';
import { Room, Track, RoomEvent } from 'livekit-client';

/** 分辨率预设（分享画质选择用） */
export const RESOLUTIONS = {
  '1080p': { width: 1920, height: 1080 },
  '720p': { width: 1280, height: 720 },
  '480p': { width: 854, height: 480 },
};

/**
 * 各分辨率码率上限。注意：这是"上限"，实际码率由 WebRTC 拥塞控制
 * 根据分享端上行带宽自动调整（带宽不足会自动压低，避免卡顿积压）。
 * 设置合理上限避免编码器过度追求高码率。
 */
export const RESOLUTION_BITRATES = {
  '1080p': 5_000_000,
  '720p': 3_500_000,
  '480p': 1_800_000,
};

/** 各分辨率默认帧率：1080p 60fps（动态场景更顺滑），其余 30fps（带宽友好） */
export const RESOLUTION_FRAMERATES = {
  '1080p': 60,
  '720p': 30,
  '480p': 30,
};

/** 观看清晰度 → LiveKit VideoQuality（LOW=0, MEDIUM=1, HIGH=2） */
export const WATCH_QUALITY = {
  auto: null,
  '480p': 0,
  '720p': 1,
  '1080p': 2,
};

/** 自适应降级顺序（分享端网络差时自动逐档降低） */
const DEGRADE_STEPS = ['1080p', '720p', '480p'];

/**
 * LiveKit 媒体层封装
 *  - connect()：连接 SFU、默认开麦（发布 mic track）
 *  - toggleMute()：本地开关麦克风（实际音频），静音状态同步交给信令层
 *  - toggleScreenShare()：发起/停止屏幕共享（getDisplayMedia + screen track）
 *  - disconnect()：断开媒体连接
 *
 * 事件回调：
 *  - onRemoteShareTrack(participantIdentity, track)：远端共享视频轨道（组件负责挂载）
 *  - onScreenShareStopped(participantIdentity)：共享结束（含浏览器原生停止按钮触发）
 */
export function useLiveKit() {
  const liveRoom = shallowRef(null);
  const connected = ref(false);
  const isMuted = ref(false);
  const isSharing = ref(false);
  const error = ref('');
  /** 当前分享画质档位（网络自适应可能自动降级，UI 用于展示） */
  const shareQualityState = ref('720p');

  let onRemoteShareTrack = null;
  let onScreenShareStopped = null;
  let onScreenAudioTrack = null;
  let onQualityDegrade = null; // (fromStep, toStep) 网络自适应降级/恢复通知

  // ---- 网络自适应（分享端上行带宽差时自动降码率） ----
  let qualityTimer = null;
  let poorStreak = 0;
  let goodStreak = 0;
  let degradeIndex = 1; // DEGRADE_STEPS 当前档位索引（默认 720p）
  let autoDegradeActive = false;

  function currentQuality() {
    return liveRoom.value?.localParticipant?.connectionQuality || 'unknown';
  }

  /** 动态调整共享 track 码率上限（不中断共享，WebRTC 平滑过渡） */
  function applyScreenBitrate(stepKey) {
    const room = liveRoom.value;
    if (!room) return;
    const pub = room.localParticipant?.getTrackPublication(Track.Source.ScreenShare);
    const track = pub?.track;
    if (track && typeof track.setMaxBitrate === 'function') {
      track.setMaxBitrate(RESOLUTION_BITRATES[stepKey] || 3_500_000).catch(() => {});
    }
  }

  function qualityTick() {
    const q = currentQuality();
    if (q === 'poor') {
      poorStreak += 1;
      goodStreak = 0;
      // 连续 2 次（约 8 秒）质量差 → 降一档
      if (poorStreak >= 2 && degradeIndex < DEGRADE_STEPS.length - 1) {
        const from = DEGRADE_STEPS[degradeIndex];
        degradeIndex += 1;
        const to = DEGRADE_STEPS[degradeIndex];
        shareQualityState.value = to;
        applyScreenBitrate(to);
        autoDegradeActive = true;
        poorStreak = 0;
        onQualityDegrade?.(from, to);
      }
    } else if (q === 'good' || q === 'excellent') {
      goodStreak += 1;
      poorStreak = 0;
      // 连续 4 次（约 16 秒）质量良好 → 升回一档（自动降级过才升）
      if (autoDegradeActive && goodStreak >= 4 && degradeIndex > 0) {
        const from = DEGRADE_STEPS[degradeIndex];
        degradeIndex -= 1;
        const to = DEGRADE_STEPS[degradeIndex];
        shareQualityState.value = to;
        applyScreenBitrate(to);
        goodStreak = 0;
        onQualityDegrade?.(from, to);
        if (degradeIndex === 0) autoDegradeActive = false;
      }
    }
  }

  function startQualityMonitor() {
    stopQualityMonitor();
    degradeIndex = Math.max(0, DEGRADE_STEPS.indexOf(shareQualityState.value));
    if (degradeIndex < 0) degradeIndex = 1;
    poorStreak = 0;
    goodStreak = 0;
    qualityTimer = setInterval(qualityTick, 4000);
  }

  function stopQualityMonitor() {
    clearInterval(qualityTimer);
    qualityTimer = null;
  }

  function bindCallbacks(opts = {}) {
    onRemoteShareTrack = opts.onRemoteShareTrack || null;
    onScreenShareStopped = opts.onScreenShareStopped || null;
    onScreenAudioTrack = opts.onScreenAudioTrack || null;
    onQualityDegrade = opts.onQualityDegrade || null;
  }

  async function connect(url, token) {
    disconnect();
    error.value = '';
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      videoCaptureDefaults: { resolution: { width: 1280, height: 720 } },
    });

    room.on('trackSubscribed', (track, pub, participant) => {
      if (track.kind === 'audio') {
        // 屏幕共享音频（系统声音）与语音分开处理，便于观看端调音量
        if (pub.source === Track.Source.ScreenShareAudio || pub.source === Track.Source.ScreenShare) {
          const el = track.attach();
          el.autoplay = true;
          el.playsInline = true;
          el.play().catch(() => {});
          onScreenAudioTrack?.(participant.identity, el);
          return;
        }
        track.attach();
        track.start();
      } else if (track.source === Track.Source.ScreenShare) {
        // 不强制固定质量层：让 adaptiveStream 按观看端带宽自适应选层，
        // 网络好自动高清，网络差自动降层保流畅（避免强行请求高清造成卡顿）
        onRemoteShareTrack?.(participant.identity, track);
      }
    });
    room.on('trackUnsubscribed', (track) => {
      try {
        track.detach();
      } catch {
        /* ignore */
      }
    });

    // 远端停止共享（取消订阅）时通知 UI
    room.on('trackUnpublished', (_pub, participant) => {
      onScreenShareStopped?.(participant.identity);
    });

    await room.connect(url, token);
    liveRoom.value = room;
    connected.value = true;

    // 默认打开麦克风（用户手势内触发）
    await room.localParticipant.setMicrophoneEnabled(true);
    isMuted.value = false;

    // 监听本地屏幕共享结束（浏览器"停止共享"栏）
    room.localParticipant.on('trackUnpublished', (pub) => {
      if (pub.source === Track.Source.ScreenShare) {
        isSharing.value = false;
        onScreenShareStopped?.(room.localParticipant.identity);
      }
    });
  }

  async function toggleMute() {
    const room = liveRoom.value;
    if (!room) return;
    const next = !isMuted.value;
    await room.localParticipant.setMicrophoneEnabled(!next);
    isMuted.value = next;
    return next;
  }

  /**
   * 开始/停止屏幕共享
   * 注意：setScreenShareEnabled(enabled, captureOptions, publishOptions) 三参结构
   *  - captureOptions：resolution / audio / contentHint（video 字段只认 displaySurface！）
   *  - publishOptions：videoCodec / screenShareEncoding / degradationPreference 等编码参数
   * @param {string} [resolutionKey] 分享画质：'1080p' | '720p' | '480p'（默认 720p）
   * @param {boolean} [withAudio] 是否携带系统声音（观看端可调音量）
   * @param {string} [codec] 编码器：'h264'（默认，硬编画质好/CPU低）| 'vp8'（兼容性最广）
   * @param {string} [strategy] 画质策略：'auto' 智能 | 'clarity' 清晰优先 | 'smooth' 流畅优先
   */
  async function toggleScreenShare(resolutionKey = '720p', withAudio = false, codec = 'h264', strategy = 'auto') {
    const room = liveRoom.value;
    if (!room) return;
    if (isSharing.value) {
      await room.localParticipant.setScreenShareEnabled(false);
      isSharing.value = false;
      stopQualityMonitor();
      shareQualityState.value = resolutionKey;
    } else {
      const resolution = RESOLUTIONS[resolutionKey] || RESOLUTIONS['720p'];
      const maxBitrate = RESOLUTION_BITRATES[resolutionKey] || RESOLUTION_BITRATES['720p'];
      const frameRate = RESOLUTION_FRAMERATES[resolutionKey] || 30;
      // 策略 → degradationPreference（带宽受限时如何取舍）+ contentHint（采集内容类型）
      const strategyMap = {
        auto: { degradation: 'balanced', contentHint: 'motion' },
        clarity: { degradation: 'maintain-resolution', contentHint: 'detail' },
        smooth: { degradation: 'maintain-framerate', contentHint: 'motion' },
      };
      const s = strategyMap[strategy] || strategyMap.auto;
      shareQualityState.value = resolutionKey;
      await room.localParticipant.setScreenShareEnabled(
        true,
        {
          resolution,
          contentHint: s.contentHint,
          audio: withAudio
            ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
            : false,
        },
        {
          videoCodec: codec,
          // 码率上限按档位设置，实际码率由拥塞控制按分享端带宽自适应
          screenShareEncoding: { maxBitrate, maxFramerate: frameRate },
          degradationPreference: s.degradation,
          // H264 主编码 + 自动备份：观看端不支持时 LiveKit 自动发 VP8 备用轨
          backupCodec: true,
        },
      );
      isSharing.value = true;
      // 开始网络自适应监控：分享端上行带宽差时自动降码率
      startQualityMonitor();
    }
    return isSharing.value;
  }

  /**
   * 观看端切换远端共享清晰度（Simulcast 码流切换）
   * @param {string} identity 远端参与者
   * @param {number|null} quality VideoQuality（LOW=0/MEDIUM=1/HIGH=2）；null = 自适应
   */
  function setRemoteVideoQuality(identity, quality) {
    const room = liveRoom.value;
    if (!room) return;
    const participant = room.remoteParticipants.get(identity);
    if (!participant) return;
    const pub = participant.getTrackPublication(Track.Source.ScreenShare);
    if (pub && typeof pub.setVideoQuality === 'function') {
      if (quality === null) {
        pub.setVideoQuality(2); // 手动选"自动"时切回最高层，由 adaptiveStream 接管
      } else {
        pub.setVideoQuality(quality);
      }
    }
  }

  function disconnect() {
    stopQualityMonitor();
    const room = liveRoom.value;
    if (room) {
      try {
        room.disconnect();
      } catch {
        /* ignore */
      }
    }
    liveRoom.value = null;
    connected.value = false;
    isMuted.value = false;
    isSharing.value = false;
  }

  return {
    liveRoom,
    connected,
    isMuted,
    isSharing,
    error,
    shareQualityState,
    connect,
    bindCallbacks,
    toggleMute,
    toggleScreenShare,
    setRemoteVideoQuality,
    disconnect,
  };
}
