import { ref } from 'vue';

/**
 * P2P Mesh 媒体层（无 LiveKit 时的降级方案，浏览器原生 WebRTC）
 *
 * 原理：每个成员与其他成员各建立一条 RTCPeerConnection（Mesh），
 * 音频/屏幕轨道直接点对点传输；SDP/ICE 交换走信令服务器
 * （webrtc_signal 消息转发，见 server/src/signal/handlers.js）。
 *
 * 接口与 useLiveKit 对齐：connect / toggleMute / toggleScreenShare / disconnect
 *
 * 事件回调（由调用方注入）：
 *  - onRemoteTrack(userId, kind, stream)  kind: 'audio' | 'screen'
 *  - onRemoteEnded(userId)                远端离开/共享结束
 *  - sendSignal(target, data)             发送 SDP/ICE 到目标成员
 */

const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

/** 分辨率预设（与 useLiveKit 保持一致） */
export const P2P_RESOLUTIONS = {
  '1080p': { width: 1920, height: 1080 },
  '720p': { width: 1280, height: 720 },
  '480p': { width: 854, height: 480 },
};

/** 各分辨率码率上限（动态画面防糊） */
export const P2P_RESOLUTION_BITRATES = {
  '1080p': 5_000_000,
  '720p': 3_500_000,
  '480p': 1_800_000,
};

/** 各分辨率默认帧率：1080p 60fps，其余 30fps（与 useLiveKit 一致） */
export const P2P_RESOLUTION_FRAMERATES = {
  '1080p': 60,
  '720p': 30,
  '480p': 30,
};

export function useWebRTC() {
  const connected = ref(false);
  const isMuted = ref(false);
  const isSharing = ref(false);
  const error = ref('');

  /** userId -> { pc, audioSender, screenSender, remoteSet, pendingIce } */
  const peers = new Map();

  let selfId = '';
  let micStream = null;
  let screenStream = null;
  let sendSignal = null;
  let onRemoteTrack = null;
  let onRemoteEnded = null;

  function getOrCreatePeer(userId) {
    let entry = peers.get(userId);
    if (entry) return entry;

    const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
    entry = { pc, audioSender: null, screenSender: null, remoteSet: false, pendingIce: [] };
    peers.set(userId, entry);

    pc.onicecandidate = (e) => {
      if (e.candidate && entry.remoteSet && sendSignal) {
        sendSignal(userId, { kind: 'ice', candidate: e.candidate.toJSON() });
      }
    };

    pc.ontrack = (e) => {
      const kind = e.track.kind === 'audio' ? 'audio' : 'screen';
      onRemoteTrack?.(userId, kind, e.streams[0]);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        // 不做自动清理，等待 member_left 事件
      }
    };

    return entry;
  }

  function addAudioTrack(userId) {
    const entry = peers.get(userId);
    if (!entry || !micStream || entry.audioSender) return;
    const audioTrack = micStream.getAudioTracks()[0];
    if (!audioTrack) return;
    entry.audioSender = entry.pc.addTrack(audioTrack, micStream);
  }

  async function negotiate(userId, entry) {
    const offer = await entry.pc.createOffer();
    await entry.pc.setLocalDescription(offer);
    sendSignal?.(userId, { kind: 'offer', sdp: offer });
  }

  async function flushPendingIce(entry) {
    while (entry.pendingIce.length) {
      const candidate = entry.pendingIce.shift();
      try {
        await entry.pc.addIceCandidate(candidate);
      } catch {
        /* 忽略过期 candidate */
      }
    }
  }

  /**
   * 连接媒体层：采集麦克风并与其他成员建立连接
   * @param {object} opts { selfId, members: [{userId}], sendSignal, onRemoteTrack, onRemoteEnded }
   */
  async function connect(opts = {}) {
    disconnect();
    error.value = '';
    selfId = opts.selfId || '';
    sendSignal = opts.sendSignal || null;
    onRemoteTrack = opts.onRemoteTrack || null;
    onRemoteEnded = opts.onRemoteEnded || null;

    // 采集麦克风（失败不阻断：仍可共享屏幕）
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      isMuted.value = false;
    } catch (e) {
      micStream = null;
      isMuted.value = true;
      error.value = '无法访问麦克风：' + (e.message || e.name || '权限被拒绝');
    }

    connected.value = true;

    // 与现有成员建立点对点连接
    const members = opts.members || [];
    for (const m of members) {
      if (m.userId === selfId) continue;
      const entry = getOrCreatePeer(m.userId);
      addAudioTrack(m.userId);
      try {
        await negotiate(m.userId, entry);
      } catch (e) {
        console.warn('[p2p] 与', m.userId, '协商失败:', e);
      }
    }
  }

  /** 新成员加入房间时调用（由 RoomView 在 member_joined 事件触发） */
  async function onPeerJoined(userId) {
    if (!connected.value || userId === selfId) return;
    const entry = getOrCreatePeer(userId);
    addAudioTrack(userId);
    try {
      await negotiate(userId, entry);
    } catch (e) {
      console.warn('[p2p] 与新成员协商失败:', e);
    }
  }

  /** 成员离开房间时调用 */
  function onPeerLeft(userId) {
    const entry = peers.get(userId);
    if (!entry) return;
    try {
      entry.pc.close();
    } catch {
      /* ignore */
    }
    peers.delete(userId);
    onRemoteEnded?.(userId);
  }

  /** 收到来自信令的 SDP/ICE（offer/answer/ice） */
  async function handleSignal(from, data) {
    if (!data?.kind) return;

    if (data.kind === 'offer') {
      const entry = getOrCreatePeer(from);
      await entry.pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
      entry.remoteSet = true;
      await flushPendingIce(entry);
      addAudioTrack(from);
      const answer = await entry.pc.createAnswer();
      await entry.pc.setLocalDescription(answer);
      sendSignal?.(from, { kind: 'answer', sdp: answer });
    } else if (data.kind === 'answer') {
      const entry = peers.get(from);
      if (!entry) return;
      await entry.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
      entry.remoteSet = true;
      await flushPendingIce(entry);
    } else if (data.kind === 'ice') {
      const entry = getOrCreatePeer(from);
      if (entry.remoteSet) {
        try {
          await entry.pc.addIceCandidate(data.candidate);
        } catch {
          /* ignore */
        }
      } else {
        entry.pendingIce.push(data.candidate);
      }
    }
  }

  /** 静音/取消静音（本地音频轨道 enabled 控制，状态同步走信令广播） */
  async function toggleMute() {
    const next = !isMuted.value;
    isMuted.value = next;
    for (const entry of peers.values()) {
      if (entry.audioSender?.track) {
        entry.audioSender.track.enabled = !next;
      }
    }
    return next;
  }

  /** 开始/停止屏幕共享（P2P 单码流，按所选分辨率采集） */
  async function toggleScreenShare(resolutionKey = '720p') {
    if (!isSharing.value) {
      const res = P2P_RESOLUTIONS[resolutionKey] || P2P_RESOLUTIONS['720p'];
      const frameRate = P2P_RESOLUTION_FRAMERATES[resolutionKey] || 30;
      try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { ideal: res.width },
            height: { ideal: res.height },
            frameRate: { ideal: frameRate },
          },
          audio: false,
        });
      } catch (e) {
        error.value = '无法共享屏幕：' + (e.message || e.name);
        return false;
      }
      // 浏览器自带"停止共享"栏
      screenStream.getVideoTracks()[0].onended = () => {
        stopScreenShareInternal();
      };
      for (const [uid, entry] of peers) {
        const videoTrack = screenStream.getVideoTracks()[0];
        if (entry.pc.getSenders().some((s) => s.track === videoTrack)) continue;
        entry.screenSender = entry.pc.addTrack(videoTrack, screenStream);
        // 设置码率上限（动态画面防糊）
        try {
          const params = entry.screenSender.getParameters();
          if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
          params.encodings[0].maxBitrate =
            P2P_RESOLUTION_BITRATES[resolutionKey] || P2P_RESOLUTION_BITRATES['720p'];
          await entry.screenSender.setParameters(params);
        } catch {
          /* 部分浏览器不支持，忽略 */
        }
        try {
          await negotiate(uid, entry);
        } catch (e) {
          console.warn('[p2p] 共享协商失败:', e);
        }
      }
      isSharing.value = true;
    } else {
      await stopScreenShareInternal();
    }
    return isSharing.value;
  }

  /** 观看端清晰度切换：P2P 为单码流，无操作 */
  function setRemoteVideoQuality() {
    return false;
  }

  async function stopScreenShareInternal() {
    for (const [, entry] of peers) {
      if (entry.screenSender) {
        try {
          entry.pc.removeTrack(entry.screenSender);
        } catch {
          /* ignore */
        }
        entry.screenSender = null;
      }
    }
    // 重新协商（移除轨道后对方才能停止接收）
    for (const [uid, entry] of peers) {
      try {
        await negotiate(uid, entry);
      } catch {
        /* ignore */
      }
    }
    if (screenStream) {
      screenStream.getTracks().forEach((t) => t.stop());
      screenStream = null;
    }
    isSharing.value = false;
  }

  function disconnect() {
    for (const [, entry] of peers) {
      try {
        entry.pc.close();
      } catch {
        /* ignore */
      }
    }
    peers.clear();
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }
    if (screenStream) {
      screenStream.getTracks().forEach((t) => t.stop());
      screenStream = null;
    }
    connected.value = false;
    isMuted.value = false;
    isSharing.value = false;
  }

  return {
    connected,
    isMuted,
    isSharing,
    error,
    connect,
    onPeerJoined,
    onPeerLeft,
    handleSignal,
    toggleMute,
    toggleScreenShare,
    setRemoteVideoQuality,
    disconnect,
  };
}
