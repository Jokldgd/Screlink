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
  httpsPort: null,
  lanHttpUrls: [],
  lanHttpsUrls: [],
};

/* 推流画质：分辨率 × 帧率 自由组合
   - 分辨率决定基础码率与编码倾向（contentHint）
   - 帧率按比例调整码率（15fps=0.6x / 30fps=1.0x / 60fps=1.5x）
   - 降级策略：60fps 保帧率（motion 场景），其余保分辨率（用户显式选了清晰度）
   degradation:
     maintain-framerate  保帧率（可能降分辨率）——适合播放视频/动态内容
     maintain-resolution 保分辨率（可能降帧率）——适合静态屏幕/文字，清晰可读 */
const RESOLUTION_SPEC = {
  "360": { label: "360p", maxBitrate: 1_600_000, contentHint: "motion" },
  "720": { label: "720p", maxBitrate: 4_000_000, contentHint: "detail" },
  "1080": { label: "1080p", maxBitrate: 8_000_000, contentHint: "detail" },
};
const FPS_SPEC = {
  "15": { label: "15fps", bitrateFactor: 0.6 },
  "30": { label: "30fps", bitrateFactor: 1.0 },
  "60": { label: "60fps", bitrateFactor: 1.5 },
};
/** 读取画质/帧率下拉，组合出推流参数（与后端/自适应码率共用的唯一入口） */
function buildQuality() {
  const res = $("resolution-select")?.value || "720";
  const fps = $("fps-select")?.value || "30";
  const r = RESOLUTION_SPEC[res] || RESOLUTION_SPEC["720"];
  const f = FPS_SPEC[fps] || FPS_SPEC["30"];
  return {
    label: `${r.label} @ ${f.label}`,
    frameRate: { ideal: Number(fps), max: Number(fps) },
    maxBitrate: Math.round(r.maxBitrate * f.bitrateFactor),
    contentHint: r.contentHint,
    degradation: fps === "60" ? "maintain-framerate" : "maintain-resolution",
  };
}

const ERR_TEXT = {
  "room-not-found": "房间不存在或共享已结束",
  "room-full": "房间人数已满",
  "room-taken": "该房间号已被使用，请换一个",
  "bad-room": "房间号需为 2-8 位字母或数字",
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
    case "set-quality": return onSetQuality(msg);
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
    // 区分根因：非安全上下文（HTTP/IP 访问）与浏览器真的不支持
    if (!window.isSecureContext) {
      toast("无法共享：屏幕捕获需要 HTTPS 安全连接。请使用 https:// 地址打开本页（见下方提示），而非 http://");
    } else {
      toast("当前浏览器不支持屏幕捕获，请使用最新版 Chrome / Edge");
    }
    return;
  }
  state.includeAudio = $("audio-checkbox").checked;
  const quality = buildQuality(); // 按 分辨率 × 帧率 下拉组合推流参数
  state.quality = quality;
  dbg("host: quality", quality.label, "maxBitrate", quality.maxBitrate, "fps", quality.frameRate.max);
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

  connectSocket(() => {
    const custom = $("custom-room")?.value.trim().toUpperCase() || "";
    send(custom ? { type: "create", room: custom } : { type: "create" });
  });
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
  const prevQuality = old?._viewerQuality; // 重连时继承该观看者上次选择的清晰度
  if (old) {
    try { stopBitrateAdaptation(old); old.close(); } catch { /* ignore */ }
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
  // 若该观看者之前选过非默认清晰度，重建后恢复其选择（scale/码率在 offer 前生效）
  if (prevQuality && prevQuality !== "1080") {
    try { applyViewerQuality(pc, prevQuality); } catch { /* ignore */ }
  }
  dbg("host: send offer to viewer", peerId);
  pc.createOffer()
    .then((offer) => pc.setLocalDescription(offer))
    .then(() => applyMaxBitrate(pc))
    .then(() => startBitrateAdaptation(pc))
    .then(() => send({ type: "offer", to: peerId, sdp: pc.localDescription }))
    .catch((err) => console.error("createOffer failed", err));
}

/** 按当前画质档位设置视频发送码率上限与降级策略 */
function applyMaxBitrate(pc) {
  if (!state.quality) return;
  const bps = state.quality.maxBitrate;
  pc._bitrate = bps;
  applyBitrate(pc, bps);
  dbg("host: set maxBitrate", bps, "degradation:", state.quality.degradation);
}

/** 对某条观看者连接设置视频发送码率上限（自适应时反复调用） */
function applyBitrate(pc, bps) {
  for (const sender of pc.getSenders()) {
    if (sender.track?.kind !== "video") continue;
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = bps;
      // 观看者已指定清晰度时用其降级策略，否则用主机档位的策略
      if (!pc._viewerQuality && state.quality?.degradation) {
        params.degradationPreference = state.quality.degradation;
      }
      sender.setParameters(params).catch(() => {});
    } catch (err) {
      console.warn("setParameters failed", err);
    }
  }
}

/* ---------------- 自适应码率 ----------------
 * 公网带宽有限且复杂画面码率需求高时，固定码率上限容易卡顿/模糊。
 * 这里按丢包率动态调整每个观看者连接的码率上限：
 *   丢包率高  -> 立即降档（先稳画面，避免雪崩）
 *   持续平稳  -> 缓慢回升（利用空闲带宽，不超档位原始上限）
 * 每个观看者独立调节，互不影响。 */
const BITRATE_STEPS = [
  1_000_000, 1_500_000, 2_000_000, 3_000_000, 4_000_000,
  6_000_000, 8_000_000, 10_000_000, 12_000_000, 16_000_000,
];
const ADAPT_INTERVAL_MS = 1500; // 每 1.5s 采样一次（更快适应）
const LOSS_DOWN = 0.12;         // 丢包率 > 12%：才降档（更迟降，保住画质）
const LOSS_UP = 0.015;          // 丢包率 < 1.5%：视为平稳
const UP_AFTER = 3;             // 连续 3 次平稳（约 6s）后回升一档

function stepDownBitrate(cur) {
  for (let i = BITRATE_STEPS.length - 1; i >= 0; i--) {
    if (BITRATE_STEPS[i] < cur) return BITRATE_STEPS[i];
  }
  return BITRATE_STEPS[0];
}

function stepUpBitrate(cur, max) {
  for (let i = 0; i < BITRATE_STEPS.length; i++) {
    if (BITRATE_STEPS[i] > cur) return Math.min(BITRATE_STEPS[i], max);
  }
  return max;
}

function startBitrateAdaptation(pc) {
  stopBitrateAdaptation(pc);
  const initial = pc._bitrate || state.quality?.maxBitrate || 6_000_000;
  const adapt = { initial, prev: null, stableCount: 0 };
  pc._adapt = adapt;
  pc._adaptTimer = setInterval(() => {
    if (!state.role || pc.connectionState !== "connected") return;
    pc.getStats()
      .then((stats) => {
        let cur = null;
        stats.forEach((r) => {
          if (r.type === "outbound-rtp" && (r.kind === "video" || r.mediaType === "video")) cur = r;
        });
        if (!cur || cur.packetsSent === undefined || cur.packetsLost === undefined) return;
        const t = cur.timestamp;
        if (adapt.prev && t > adapt.prev.t) {
          const sDelta = cur.packetsSent - adapt.prev.s;
          const lDelta = cur.packetsLost - adapt.prev.l;
          const loss = sDelta + lDelta > 0 ? lDelta / (sDelta + lDelta) : 0;
          let target = null;
          if (loss > LOSS_DOWN) {
            target = stepDownBitrate(pc._bitrate ?? initial);
            adapt.stableCount = 0;
            dbg(`adapt: loss ${(loss * 100).toFixed(1)}% -> down ${target}`);
          } else if (loss < LOSS_UP) {
            adapt.stableCount++;
            if (adapt.stableCount >= UP_AFTER) {
              adapt.stableCount = 0;
              target = stepUpBitrate(pc._bitrate ?? initial, initial);
              if (target !== pc._bitrate) dbg(`adapt: stable -> up ${target}`);
            }
          } else {
            adapt.stableCount = 0;
          }
          if (target !== null && target !== pc._bitrate) {
            pc._bitrate = target;
            applyBitrate(pc, target);
          }
        }
        adapt.prev = { s: cur.packetsSent, l: cur.packetsLost, t };
      })
      .catch(() => {});
  }, ADAPT_INTERVAL_MS);
}

function stopBitrateAdaptation(pc) {
  if (pc._adaptTimer) {
    clearInterval(pc._adaptTimer);
    pc._adaptTimer = null;
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

/* ---------------- 观看者清晰度切换 ----------------
 * 观看端选择清晰度（1080p/720p/360p）后发送 set-quality 信号；
 * 主机针对该观看者的连接调整分辨率缩放与码率上限，再重新协商。
 * 每个观看者独立调节，互不影响（帧率跟随主机推流设置）。 */
const VIEWER_QUALITY_SPEC = {
  "1080": { scaleH: 1080, maxBitrate: 12_000_000, degradation: "maintain-framerate" },
  "720":  { scaleH: 720,  maxBitrate: 6_000_000, degradation: "maintain-resolution" },
  "360":  { scaleH: 360,  maxBitrate: 2_400_000, degradation: "maintain-resolution" },
};

/** 按观看者选择的清晰度设置该连接的编码参数（分辨率缩放 + 码率上限） */
function applyViewerQuality(pc, quality) {
  const spec = VIEWER_QUALITY_SPEC[quality] || VIEWER_QUALITY_SPEC["1080"];
  const sender = pc.getSenders().find((s) => s.track?.kind === "video");
  const track = sender?.track;
  const srcH = track?.getSettings?.().height || 1080;
  const scale = Math.max(1, Math.round((srcH / spec.scaleH) * 2) / 2); // 0.5 步进取整
  for (const s of pc.getSenders()) {
    if (s.track?.kind !== "video") continue;
    try {
      const params = s.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      const enc = params.encodings[0];
      enc.scaleResolutionDownBy = scale;
      enc.maxBitrate = spec.maxBitrate;
      params.degradationPreference = spec.degradation;
      s.setParameters(params).catch((e) => console.warn("setViewerQuality failed", e));
    } catch (err) {
      console.warn("setViewerQuality error", err);
    }
  }
  pc._viewerQuality = quality;
  pc._bitrate = spec.maxBitrate; // 与自适应码率联动：降档可低于此值，回升不超过此值
  if (pc._adapt) pc._adapt.initial = spec.maxBitrate;
  dbg("host: viewer", pc.peerTarget, "quality ->", quality, "scale", scale, "bitrate", spec.maxBitrate);
}

/** 对该观看者连接重新协商（切换清晰度后推送新的编码参数） */
function renegotiateViewer(pc) {
  pc.createOffer()
    .then((offer) => pc.setLocalDescription(offer))
    .then(() => send({ type: "offer", to: pc.peerTarget, sdp: pc.localDescription }))
    .catch((err) => console.error("renegotiate offer failed", err));
}

/** 观看者请求切换清晰度：调整该观看者的编码并重新协商 */
function onSetQuality(msg) {
  if (state.role !== "host") return;
  const pc = state.viewerPcs.get(msg.from);
  if (!pc || pc.connectionState !== "connected") return;
  const quality = VIEWER_QUALITY_SPEC[msg.quality] ? msg.quality : "1080";
  if (quality === pc._viewerQuality) return; // 没变化就不重协商
  applyViewerQuality(pc, quality);
  renegotiateViewer(pc);
}

function onViewerLeft(msg) {
  if (state.role !== "host") return;
  const pc = state.viewerPcs.get(msg.peerId);
  if (pc) {
    stopBitrateAdaptation(pc);
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
  for (const pc of state.viewerPcs.values()) {
    stopBitrateAdaptation(pc);
    pc.close();
  }
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
  const p = $("player");
  const v = $("remote-video");
  p.classList.toggle("is-fullscreen", !!fsEl);
  // 全屏：直接设内联尺寸（比 CSS 更可靠），铺满视口；退出时清空恢复
  if (fsEl) {
    p.style.width = "100vw";
    p.style.height = "100vh";
    v.style.width = "100vw";
    v.style.height = "100vh";
    v.style.maxHeight = "none";
    v.style.maxWidth = "none";
  } else {
    p.style.width = "";
    p.style.height = "";
    v.style.width = "";
    v.style.height = "";
    v.style.maxHeight = "";
    v.style.maxWidth = "";
  }
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
  // 非 HTTPS 安全上下文时提示共享不可用，并给出正确的 HTTPS 入口
  if (!window.isSecureContext) {
    const hint = $("secure-hint");
    if (hint) {
      hint.textContent = appConfig.httpsPort
        ? `https://${location.hostname}:${appConfig.httpsPort}/`
        : `https://${location.hostname}/`;
    }
    $("secure-warning").hidden = false;
  }

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

  // 观看端选择清晰度：通知主机对该观看者重新推流
  $("quality-select-viewer").addEventListener("change", (e) => {
    if (state.role !== "viewer" || !state.ws) return;
    const q = e.target.value;
    send({ type: "set-quality", quality: q });
    $("viewer-status").textContent = `切换清晰度 ${q}p 中…`;
    toast(`切换清晰度：${q}p，请稍候`);
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

  // 控制条自动隐藏：鼠标在画面上 2 秒不动自动隐藏，移动鼠标/触碰重新显示；
  // 鼠标悬停在控制条本身上时保持显示（方便拖动音量条）
  const playerEl = $("player");
  let controlsHideTimer = null;
  const showControlsTemporarily = () => {
    playerEl.classList.add("controls-visible");
    clearTimeout(controlsHideTimer);
    controlsHideTimer = setTimeout(() => {
      playerEl.classList.remove("controls-visible");
    }, 2000);
  };
  const keepControlsShown = () => {
    clearTimeout(controlsHideTimer);
    playerEl.classList.add("controls-visible");
  };
  playerEl.classList.add("controls-visible");
  playerEl.addEventListener("mousemove", showControlsTemporarily);
  playerEl.addEventListener("touchstart", showControlsTemporarily);
  playerEl.addEventListener("mouseleave", () => {
    clearTimeout(controlsHideTimer);
    playerEl.classList.remove("controls-visible");
  });
  for (const id of ["mute-btn", "volume-range", "fit-btn", "fs-btn", "unmute-btn", "quality-select-viewer"]) {
    $(id).addEventListener("mouseenter", keepControlsShown);
    $(id).addEventListener("mouseleave", showControlsTemporarily);
  }

  // 自定义房间号：刷新页面后保留上次填写的值（localStorage 持久化）
  const CUSTOM_ROOM_KEY = "screlink.customRoom";
  const customRoomEl = $("custom-room");
  if (customRoomEl) {
    const saved = localStorage.getItem(CUSTOM_ROOM_KEY);
    if (saved) customRoomEl.value = saved;
    customRoomEl.addEventListener("input", () => {
      // 实时规范化：大写、只保留字母数字、最长 8 位
      const clean = customRoomEl.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
      customRoomEl.value = clean;
      localStorage.setItem(CUSTOM_ROOM_KEY, clean);
    });
  }

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
