"use strict";

/* ============================================================
 * Screlink 客户端
 * 同一页面承担两种角色：
 *  - host   共享屏幕（getDisplayMedia），向每个观看者推流
 *  - viewer 加入房间，接收 WebRTC 流并播放
 * 信令协议见 docs/PROTOCOL.md
 * ============================================================ */

const $ = (id) => document.getElementById(id);

const state = {
  ws: null,
  peerId: null,
  room: null,
  role: null,          // "host" | "viewer"
  localStream: null,   // host 的屏幕流
  viewerPcs: new Map(),// host 侧：viewerPeerId -> RTCPeerConnection
  hostPc: null,        // viewer 侧：与主机的一条连接
  hostPeerId: null,
  includeAudio: false,
  quality: null,       // 当前推流画质档位（startSharing 时设置）
  fit: "cover",        // 观看端画面模式：cover=占满 / contain=适应
  reconnectTimer: null,  // viewer 重连定时器
  reconnectInProgress: false,
};

let appConfig = {
  version: null,
  stunUrls: ["stun:stun.l.google.com:19302"],
  iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
  maxViewersPerRoom: 8,
  lanHttpUrls: [],
  lanHttpsUrls: [],
};

/* 推流画质档位：帧率上限 + 码率上限 + 降级策略
   contentHint:  "motion"=流畅优先 / "detail"=锐利优先
   degradation:  带宽不足时如何取舍
     maintain-framerate  保帧率（可能降分辨率）——适合播放视频/动态内容
     maintain-resolution 保分辨率（可能降帧率）——适合静态屏幕/文字，清晰可读
     balanced            折中 */
const QUALITY = {
  smooth: { label: "流畅", frameRate: { ideal: 60, max: 60 }, maxBitrate: 10_000_000, contentHint: "motion", degradation: "maintain-framerate" },
  auto:   { label: "自动", frameRate: { ideal: 60, max: 60 }, maxBitrate: 6_000_000, contentHint: "detail", degradation: "balanced" },
  high:   { label: "清晰", frameRate: { ideal: 30, max: 30 }, maxBitrate: 6_000_000, contentHint: "detail", degradation: "maintain-resolution" },
  medium: { label: "中", frameRate: { ideal: 30, max: 30 }, maxBitrate: 3_000_000, contentHint: "detail", degradation: "balanced" },
  low:    { label: "低", frameRate: { ideal: 24, max: 24 }, maxBitrate: 2_000_000, contentHint: "detail", degradation: "balanced" },
};

const ERR_TEXT = {
  "room-not-found": "房间不存在或共享已结束",
  "room-full": "房间人数已满",
  "already-in-room": "你已在房间中",
  "not-in-room": "尚未加入房间",
  "bad-json": "消息格式错误",
  "unknown-type": "未知消息类型",
};

/** 调试日志：在控制台输出关键信令与连接状态（F12 可见） */
function dbg(...args) {
  console.debug("[screlink]", ...args);
}

/* ---------------- 初始化 ---------------- */

async function loadConfig() {
  try {
    appConfig = { ...appConfig, ...(await fetch("/api/config").then((r) => r.json())) };
  } catch {
    /* 保持默认值 */
  }
  if (appConfig.version) $("app-version").textContent = `v${appConfig.version}`;
}

function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  el.classList.remove("show");
  void el.offsetWidth; // 重新触发动画
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3200);
}

function setBusy(btn, busy, busyText) {
  if (busy) {
    btn.dataset.label = btn.textContent;
    btn.textContent = busyText || "处理中…";
    btn.disabled = true;
  } else {
    btn.textContent = btn.dataset.label || btn.textContent;
    btn.disabled = false;
  }
}

function showView(name) {
  for (const id of ["landing", "host-view", "viewer-view"]) {
    $(id).hidden = id !== name;
  }
}

/* ---------------- 信令连接 ---------------- */

function connectSocket(onOpen) {
  if (state.ws) return;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => onOpen && onOpen();
  ws.onmessage = (e) => {
    try {
      handleSignal(JSON.parse(e.data));
    } catch (err) {
      console.error("bad message from server", err);
    }
  };
  ws.onclose = () => handleSocketClosed();
  ws.onerror = () => { /* onclose 兜底 */ };
}

function send(msg) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
  }
}

function handleSocketClosed() {
  state.ws = null;
  if (state.role === "host") {
    toast("与服务器连接断开，共享已停止");
    resetHost("与服务器连接断开");
  } else if (state.role === "viewer") {
    toast("与服务器连接断开");
    resetViewer();
  }
}

function handleSignal(msg) {
  dbg("signal in:", msg.type);
  switch (msg.type) {
    case "created": return onCreated(msg);
    case "joined": return onJoined(msg);
    case "error": return onError(msg);
    case "viewer-joined": return onViewerJoined(msg);
    case "viewer-left": return onViewerLeft(msg);
    case "offer": return onOffer(msg);
    case "answer": return onAnswer(msg);
    case "ice": return onIce(msg);
    case "host-left": return onHostLeft(msg);
    case "renegotiate": return onRenegotiate(msg);
    default: console.warn("unknown signal", msg);
  }
}

function onError(msg) {
  toast(ERR_TEXT[msg.code] || `出错了：${msg.code}`);
  if (!state.role) {
    // 加入/创建失败：断开并回到落地页
    if (state.ws) { state.ws.onclose = null; state.ws.close(); state.ws = null; }
  }
}

/* ---------------- WebRTC 辅助 ---------------- */

function createPc(label) {
  const pc = new RTCPeerConnection({ iceServers: appConfig.iceServers });
  const pendingIce = [];
  let remoteReady = false;
  pc.label = label;
  pc.peerTarget = null;
  pc.onicecandidate = (e) => {
    if (e.candidate && pc.peerTarget) {
      send({ type: "ice", to: pc.peerTarget, candidate: e.candidate });
    }
  };
  // 远端 SDP 尚未设置时先缓存 ICE 候选
  pc.queueIce = (candidate) => {
    if (!remoteReady) pendingIce.push(candidate);
    else pc.addIceCandidate(candidate).catch(() => {});
  };
  pc.flushIce = () => {
    remoteReady = true;
    pendingIce.splice(0).forEach((c) => pc.addIceCandidate(c).catch(() => {}));
  };
  return pc;
}

/**
 * 把视频编码器限定为 VP8 / H.264。
 * 修复 Windows 上 Chromium 内核协商到 VP9/AV1 时硬件解码异常导致的黑屏。
 */
function pinVideoCodecs(pc) {
  try {
    const caps = RTCRtpSender.getCapabilities?.("video");
    if (!caps) return;
    const pref = [];
    for (const name of ["VP8", "H264"]) {
      const found = caps.codecs.find(
        (c) => c.mimeType.toLowerCase() === `video/${name.toLowerCase()}`
      );
      if (found) pref.push(found);
    }
    if (!pref.length) return;
    for (const t of pc.getTransceivers()) {
      if (t.sender?.track?.kind === "video") {
        t.setCodecPreferences(pref);
        dbg("codec preference set:", pref.map((c) => c.mimeType).join(", "));
      }
    }
  } catch (err) {
    console.warn("setCodecPreferences failed", err);
  }
}

/* ---------------- 主机逻辑 ---------------- */

async function startSharing() {
  if (state.role) return;
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast("当前浏览器不支持屏幕捕获，请使用最新版 Chrome / Edge");
    return;
  }
  state.includeAudio = $("audio-checkbox").checked;
  const quality = QUALITY[$("quality-select").value] || QUALITY.auto;
  state.quality = quality;
  setBusy($("share-btn"), true, "请在弹窗中选择屏幕…");
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: quality.frameRate },
      audio: state.includeAudio ? { echoCancellation: false, noiseSuppression: false } : false,
    });
  } catch (err) {
    setBusy($("share-btn"), false);
    toast(err.name === "NotAllowedError" ? "已取消，未开始共享" : `无法获取屏幕：${err.message}`);
    return;
  }
  setBusy($("share-btn"), false);

  state.localStream = stream;
  // 应用帧率上限与编码倾向（motion=流畅 / detail=锐利）
  for (const track of stream.getVideoTracks()) {
    track.applyConstraints({ frameRate: quality.frameRate }).catch(() => {});
    if (quality.contentHint) {
      try { track.contentHint = quality.contentHint; } catch { /* ignore */ }
    }
  }
  $("preview-video").srcObject = stream;

  // 用户通过浏览器工具条手动结束共享
  for (const track of stream.getTracks()) {
    track.onended = () => {
      if (state.role === "host") stopSharing("共享已结束");
    };
  }

  connectSocket(() => send({ type: "create" }));
}

function onCreated(msg) {
  state.role = "host";
  state.room = msg.room;
  state.peerId = msg.peerId;
  $("room-code").textContent = msg.room;
  updateViewerCount(0);
  updateShareLinks();
  showView("host-view");
  toast("共享已开始，把房间号发给观看者吧");
}

function onViewerJoined(msg) {
  if (state.role !== "host") return;
  updateViewerCount(msg.viewerCount);
  const peerId = msg.peerId;
  if (state.viewerPcs.has(peerId)) return;
  setupViewerPc(peerId);
}

/** 为某个观看者建立/重建一条连接并发送 offer（用于新加入或重连） */
function setupViewerPc(peerId) {
  const old = state.viewerPcs.get(peerId);
  if (old) {
    try { old.close(); } catch { /* ignore */ }
  }
  const pc = createPc(`viewer:${peerId}`);
  pc.peerTarget = peerId;
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
      dbg("host: viewer pc unstable", peerId, pc.connectionState);
    }
  };
  state.viewerPcs.set(peerId, pc);
  for (const track of state.localStream.getTracks()) {
    pc.addTrack(track, state.localStream);
  }
  pinVideoCodecs(pc);
  dbg("host: send offer to viewer", peerId);
  pc.createOffer()
    .then((offer) => pc.setLocalDescription(offer))
    .then(() => applyMaxBitrate(pc))
    .then(() => send({ type: "offer", to: peerId, sdp: pc.localDescription }))
    .catch((err) => console.error("createOffer failed", err));
}

/** 按当前画质档位设置视频发送码率上限与降级策略 */
function applyMaxBitrate(pc) {
  if (!state.quality) return;
  for (const sender of pc.getSenders()) {
    if (sender.track?.kind !== "video") continue;
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = state.quality.maxBitrate;
      // 按档位设定降级策略：流畅保帧率 / 清晰保分辨率 / 其余折中
      params.degradationPreference = state.quality.degradation || "balanced";
      sender.setParameters(params).catch(() => {});
      dbg("host: set maxBitrate", state.quality.maxBitrate, "degradation:", params.degradationPreference);
    } catch (err) {
      console.warn("setParameters failed", err);
    }
  }
}

/** 观看者请求重连：主机重建该观看者连接并重新协商 */
function onRenegotiate(msg) {
  if (state.role !== "host") return;
  const peerId = msg.from;
  if (!state.viewerPcs.has(peerId)) return;
  dbg("host: renegotiate ->", peerId);
  setupViewerPc(peerId);
}

function onViewerLeft(msg) {
  if (state.role !== "host") return;
  const pc = state.viewerPcs.get(msg.peerId);
  if (pc) {
    pc.close();
    state.viewerPcs.delete(msg.peerId);
  }
  updateViewerCount(msg.viewerCount);
}

function onAnswer(msg) {
  const pc = state.viewerPcs.get(msg.from);
  if (!pc) return;
  pc.setRemoteDescription(msg.sdp)
    .then(() => pc.flushIce())
    .catch((err) => console.error("setRemoteDescription failed", err));
}

function updateViewerCount(n) {
  $("viewer-count").textContent = String(n);
}

function updateShareLinks() {
  const hash = `#room=${state.room}`;
  const currentLink = `${location.origin}${location.pathname}${hash}`;
  $("share-link").value = currentLink;

  // 主机从 localhost 打开页面时，生成的链接对局域网观看者无效，
  // 此时额外列出服务器的局域网地址。
  const box = $("lan-links");
  box.innerHTML = "";
  const isLocalhost = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(location.hostname);
  if (isLocalhost && appConfig.lanHttpUrls.length + appConfig.lanHttpsUrls.length > 0) {
    const label = document.createElement("div");
    label.className = "lan-label";
    label.textContent = "局域网观看链接（推荐在局域网内使用）：";
    box.appendChild(label);
    const urls = [
      ...appConfig.lanHttpsUrls, // 优先 https：观看者也能获得完整功能
      ...appConfig.lanHttpUrls,
    ];
    for (const base of urls) {
      const row = document.createElement("div");
      row.className = "lan-row";
      const input = document.createElement("input");
      input.readOnly = true;
      input.value = `${base}${location.pathname}${hash}`;
      const copy = document.createElement("button");
      copy.className = "secondary";
      copy.textContent = "复制";
      copy.addEventListener("click", () => copyText(input.value, "已复制局域网链接"));
      row.append(input, copy);
      box.appendChild(row);
    }
  }
}

async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg || "已复制");
  } catch {
    // http 环境下 clipboard API 不可用，退回 execCommand
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      toast(okMsg || "已复制");
    } catch {
      toast("复制失败，请手动选择链接复制");
    }
    ta.remove();
  }
}

function stopSharing(reason) {
  if (state.role !== "host") return;
  send({ type: "leave" });
  resetHost(reason);
}

/** 清理主机状态并回到落地页（不重复发送 leave） */
function resetHost(reason) {
  if (state.localStream) {
    state.localStream.getTracks().forEach((t) => t.stop());
    state.localStream = null;
  }
  for (const pc of state.viewerPcs.values()) pc.close();
  state.viewerPcs.clear();
  if (state.ws) {
    state.ws.onclose = null;
    state.ws.close();
    state.ws = null;
  }
  state.role = null;
  state.room = null;
  state.peerId = null;
  $("preview-video").srcObject = null;
  showView("landing");
  if (reason) toast(reason);
}

/* ---------------- 观看者逻辑 ---------------- */

function joinRoom() {
  if (state.role) return;
  const code = $("room-input").value.trim();
  if (!code) return toast("请输入房间号");
  setBusy($("join-btn"), true, "加入中…");
  connectSocket(() => send({ type: "join", room: code }));
  // 若失败，onError 里会复位按钮
  setTimeout(() => setBusy($("join-btn"), false), 4000);
}

function onJoined(msg) {
  setBusy($("join-btn"), false);
  state.role = "viewer";
  state.room = msg.room;
  state.peerId = msg.peerId;
  $("viewer-room").textContent = msg.room;
  $("viewer-status").textContent = "已加入房间，等待画面…";
  showView("viewer-view");
}

function onOffer(msg) {
  if (state.role !== "viewer") return;
  state.hostPeerId = msg.from;

  let pc = state.hostPc;
  if (!pc || pc.signalingState === "closed") {
    clearReconnectState();
    pc = createPc("host");
    pc.peerTarget = msg.from;
    pc.onconnectionstatechange = () => {
      dbg("viewer: pc state ->", pc.connectionState);
      const video = $("remote-video");
      if (pc.connectionState === "connected") {
        clearReconnectState();
        if (!video.srcObject) $("viewer-status").textContent = "已连接，等待画面…";
      } else if (pc.connectionState === "failed") {
        $("viewer-status").textContent = "连接中断，正在重连…";
        requestRenegotiate();
      } else if (pc.connectionState === "disconnected") {
        $("viewer-status").textContent = "连接中断，等待重连…";
        scheduleRenegotiate(pc);
      } else {
        $("viewer-status").textContent = "正在连接…";
      }
    };
    pc.ontrack = (e) => {
      const video = $("remote-video");
      // 兜底：个别浏览器不填充 streams[0]，用 track 自行组装
      const stream =
        e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
      dbg("viewer: track received", e.track.kind, "streams:", e.streams.length);
      video.srcObject = stream;
      video.onloadeddata = () => {
        dbg("viewer: video loadeddata", video.videoWidth + "x" + video.videoHeight);
        $("viewer-status").textContent =
          video.videoWidth > 0
            ? `正在播放 ${video.videoWidth}×${video.videoHeight}`
            : "正在播放";
      };
      // 显式播放；若被自动播放策略拦截（带声音时常见）则静音出画面
      video.play().catch((err) => {
        dbg("viewer: autoplay blocked", err.name);
        video.muted = true;
        video.play().catch(() => {
          $("viewer-status").textContent = "点击画面开始播放";
          video.addEventListener("click", () => video.play().catch(() => {}), { once: true });
        });
        $("unmute-btn").hidden = false;
        updateAudioUI();
      });
      updateAudioUI();
    };
    state.hostPc = pc;
  }

  pc.setRemoteDescription(msg.sdp)
    .then(() => {
      pc.flushIce();
      return pc.createAnswer();
    })
    .then((answer) => pc.setLocalDescription(answer))
    .then(() => send({ type: "answer", to: msg.from, sdp: pc.localDescription }))
    .catch((err) => console.error("answer failed", err));
}

function onIce(msg) {
  const pc =
    state.viewerPcs.get(msg.from) ||
    (msg.from === state.hostPeerId ? state.hostPc : null);
  if (pc) pc.queueIce(msg.candidate);
}

/* 观看者自动重连：连接中断时请求主机重新协商 */
function clearReconnectState() {
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  state.reconnectInProgress = false;
}

function requestRenegotiate() {
  if (state.role !== "viewer" || state.reconnectInProgress) return;
  state.reconnectInProgress = true;
  dbg("viewer: request renegotiate");
  send({ type: "renegotiate" });
  state.reconnectTimer = setTimeout(() => { state.reconnectInProgress = false; }, 6000);
}

function scheduleRenegotiate(pc) {
  // disconnected 可能是瞬时抖动，稍作延迟再真正请求重连
  if (state.reconnectTimer) return;
  state.reconnectTimer = setTimeout(() => {
    if (state.role === "viewer" && pc && pc.connectionState !== "connected") {
      requestRenegotiate();
    }
  }, 2500);
}

function onHostLeft(msg) {
  if (state.role !== "viewer") return;
  toast(msg.reason === "left" ? "主持人已停止共享" : "主持人已断开连接");
  resetViewer();
}

function leaveRoom() {
  send({ type: "leave" });
  resetViewer();
}

function resetViewer() {
  if (state.hostPc) {
    state.hostPc.close();
    state.hostPc = null;
  }
  if (state.ws) {
    state.ws.onclose = null;
    state.ws.close();
    state.ws = null;
  }
  state.role = null;
  state.room = null;
  state.peerId = null;
  state.hostPeerId = null;
  $("remote-video").srcObject = null;
  showView("landing");
}

/* ---------------- 观看端控制条（静音/音量/全屏） ---------------- */

function updateAudioUI() {
  const v = $("remote-video");
  if (!v) return;
  $("mute-btn").textContent = v.muted || v.volume === 0 ? "🔇" : "🔊";
  $("volume-range").value = String(v.volume);
}

/* 画面模式：cover=占满（裁切铺满，无黑边）/ contain=适应（看全内容） */
function applyFit() {
  const v = $("remote-video");
  if (!v) return;
  v.dataset.fit = state.fit;
  $("fit-btn").textContent = state.fit === "cover" ? "占满" : "适应";
}
function toggleFit() {
  state.fit = state.fit === "cover" ? "contain" : "cover";
  applyFit();
}

function toggleFullscreen() {
  const el = $("player");
  const doc = document;
  const fsEl = doc.fullscreenElement || doc.webkitFullscreenElement || doc.msFullscreenElement;
  if (!fsEl) {
    (el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen)?.call(el);
  } else {
    (doc.exitFullscreen || doc.webkitExitFullscreen || doc.msExitFullscreen)?.call(doc);
  }
}

function updateFullscreenUI() {
  const fsEl =
    document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement;
  $("fs-btn").textContent = fsEl ? "☒ 退出全屏" : "⛶ 全屏";
}

/* ---------------- 事件绑定 ---------------- */

function switchTab(mode) {
  const join = mode === "join";
  $("tab-join").classList.toggle("active", join);
  $("tab-host").classList.toggle("active", !join);
  $("tab-join").setAttribute("aria-selected", String(join));
  $("tab-host").setAttribute("aria-selected", String(!join));
  $("join-panel").hidden = !join;
  $("host-panel").hidden = join;
}

function bindEvents() {
  $("tab-join").addEventListener("click", () => switchTab("join"));
  $("tab-host").addEventListener("click", () => switchTab("host"));

  $("share-btn").addEventListener("click", startSharing);
  $("stop-btn").addEventListener("click", () => stopSharing("已停止共享"));

  $("join-btn").addEventListener("click", joinRoom);
  $("room-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") joinRoom();
  });
  $("leave-btn").addEventListener("click", leaveRoom);

  $("copy-link").addEventListener("click", () =>
    copyText($("share-link").value, "已复制分享链接")
  );

  $("unmute-btn").addEventListener("click", () => {
    const v = $("remote-video");
    v.muted = false;
    v.play().catch(() => {});
    $("unmute-btn").hidden = true;
    updateAudioUI();
  });

  // 观看端控制条：静音、音量、全屏
  $("mute-btn").addEventListener("click", () => {
    const v = $("remote-video");
    v.muted = !v.muted;
    updateAudioUI();
  });

  $("volume-range").addEventListener("input", () => {
    const v = $("remote-video");
    v.volume = Number($("volume-range").value);
    if (v.volume > 0 && v.muted) v.muted = false;
    updateAudioUI();
  });

  $("fs-btn").addEventListener("click", toggleFullscreen);
  document.addEventListener("fullscreenchange", updateFullscreenUI);
  document.addEventListener("webkitfullscreenchange", updateFullscreenUI);
  document.addEventListener("msfullscreenchange", updateFullscreenUI);

  $("fit-btn").addEventListener("click", toggleFit);
  applyFit(); // 应用初始画面模式（占满）

  // 诊断工具：在观看页 F12 控制台运行 __screlinkDebug() 查看连接与视频状态
  window.__screlinkDebug = () => {
    const v = $("remote-video");
    const pc = state.hostPc;
    return {
      role: state.role,
      room: state.room,
      wsReadyState: state.ws ? state.ws.readyState : null,
      pc: pc
        ? {
            connectionState: pc.connectionState,
            iceConnectionState: pc.iceConnectionState,
            signalingState: pc.signalingState,
          }
        : null,
      video: v
        ? {
            srcObjectSet: !!v.srcObject,
            paused: v.paused,
            videoWidth: v.videoWidth,
            videoHeight: v.videoHeight,
            readyState: v.readyState,
            muted: v.muted,
            error: v.error && v.error.message,
          }
        : null,
      receivers: pc
        ? pc.getReceivers().map((r) => ({
            kind: r.track.kind,
            trackReadyState: r.track.readyState,
            codecs: r.getParameters().codecs.map((c) => c.mimeType),
          }))
        : [],
    };
  };

  // 通过 #room=ABC-123 链接打开时自动加入
  const m = location.hash.match(/room=([A-Za-z0-9-]+)/);
  if (m) {
    $("room-input").value = m[1].toUpperCase();
    switchTab("join");
    joinRoom();
  }
}

(async () => {
  await loadConfig();
  bindEvents();
})();
