"use strict";

/* ============================================================
 * Screlink 客户端（v0.7.1 语音版本）
 * 统一房间模型：
 *  - 输入房间号进入（首个进入者自动创建房间）
 *  - 房间内全员双向语音（mesh，每对成员一条 P2P 连接）
 *  - 任意成员可发起画面共享（动态共享者，可随时切换）
 * 信令协议见 docs/PROTOCOL.md
 * ============================================================ */

const $ = (id) => document.getElementById(id);

const state = {
  ws: null,
  peerId: null,
  room: null,
  members: [],            // 其他成员 peerId 列表
  micStream: null,        // 本地麦克风
  micMuted: false,
  micGainNode: null,      // 麦克风发送音量（WebAudio 增益）
  micAudioCtx: null,
  micOutputStream: null,  // 经增益处理后的发送流
  memberVolumes: new Map(),  // 每个成员的麦克风音量（我听他的声音大小）：peerId -> 0~1
  outputVolumes: new Map(),  // 每个成员的听筒音量（按成员独立）：peerId -> 0~1
  baseOutputVolume: 1,       // 自己的听筒基准（总输出乘数，作用于所有成员声音）
  audioPcs: new Map(),    // 语音 mesh：peerId -> RTCPeerConnection（双向音频）
  shareStream: null,      // 本地屏幕共享流（我是共享者时）
  shareOwner: null,       // 当前共享者 peerId（null=无人共享）
  viewerPcs: new Map(),   // 共享者侧：观看者 peerId -> RTCPeerConnection（视频推流）
  videoPc: null,          // 观看者侧：与共享者的一条视频连接
  hostPeerId: null,
  quality: null,          // 当前推流画质参数（发起共享时设置）
  fit: "cover",           // 观看端画面模式：cover=占满 / contain=适应
  reconnectTimer: null,
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

/* 推流画质：分辨率 × 帧率 × 内容类型 组合计算
   - 分辨率决定基础码率
   - 帧率按比例调整码率（15fps=0.6x / 30fps=1.0x / 60fps=1.5x）
   - 动态内容（视频/游戏）：码率 ×1.5、保帧率、motion 编码 */
const RESOLUTION_SPEC = {
  "360": { label: "360p", maxBitrate: 1_200_000 },
  "720": { label: "720p", maxBitrate: 3_000_000 },
  "1080": { label: "1080p", maxBitrate: 6_000_000 },
};
const FPS_SPEC = {
  "15": { label: "15fps", bitrateFactor: 0.6 },
  "30": { label: "30fps", bitrateFactor: 1.0 },
  "60": { label: "60fps", bitrateFactor: 1.5 },
};
const CONTENT_MODE = {
  dynamic: { contentHint: "motion", degradation: "maintain-framerate", bitrateFactor: 1.5 },
  static:  { contentHint: "detail", degradation: "maintain-resolution", bitrateFactor: 1.0 },
};
function buildQuality() {
  const res = $("resolution-select")?.value || "720";
  const fps = $("fps-select")?.value || "30";
  const mode = CONTENT_MODE[$("content-mode-select")?.value] || CONTENT_MODE.dynamic;
  const r = RESOLUTION_SPEC[res] || RESOLUTION_SPEC["720"];
  const f = FPS_SPEC[fps] || FPS_SPEC["30"];
  return {
    label: `${r.label} @ ${f.label}`,
    frameRate: { ideal: Number(fps), max: Number(fps) },
    maxBitrate: Math.round(r.maxBitrate * f.bitrateFactor * mode.bitrateFactor),
    contentHint: mode.contentHint,
    degradation: mode.degradation,
  };
}

const ERR_TEXT = {
  "room-not-found": "房间不存在或已结束",
  "room-full": "房间人数已满",
  "room-taken": "该房间号已被使用",
  "bad-room": "房间号需为 2-8 位字母或数字",
  "already-in-room": "你已在房间中",
  "not-in-room": "尚未进入房间",
  "bad-json": "消息格式错误",
  "unknown-type": "未知消息类型",
};

function dbg(...args) {
  console.debug("[screlink]", ...args);
}

/* ---------------- 工具 ---------------- */

function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  el.classList.remove("show");
  void el.offsetWidth;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3200);
}

function showView(name) {
  for (const id of ["landing", "room-view"]) {
    $(id).hidden = id !== name;
  }
}

async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg || "已复制");
  } catch {
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
      toast("复制失败，请手动复制");
    }
    ta.remove();
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
  if (state.room) {
    toast("与服务器连接断开");
    resetRoom("与服务器连接断开");
  }
}

function handleSignal(msg) {
  dbg("signal in:", msg.type);
  switch (msg.type) {
    case "created": return onCreated(msg);
    case "joined": return onJoined(msg);
    case "error": return onError(msg);
    case "peer-joined": return onPeerJoined(msg);
    case "peer-left": return onPeerLeft(msg);
    case "share-started": return onShareStarted(msg);
    case "share-stopped": return onShareStopped(msg);
    case "audio-offer": return onAudioOffer(msg);
    case "audio-answer": return onAudioAnswer(msg);
    case "audio-ice": return onAudioIce(msg);
    case "audio-reinit": return onAudioReinit(msg);
    case "offer": return onOffer(msg);
    case "answer": return onAnswer(msg);
    case "ice": return onIce(msg);
    case "renegotiate": return onRenegotiate(msg);
    case "set-quality": return onSetQuality(msg);
    default: console.warn("unknown signal", msg);
  }
}

function onError(msg) {
  // 统一房间入口的兜底逻辑：
  //   join 失败（房间不存在）→ 自动创建该房间号
  //   create 失败（房间已被占用）→ 自动加入该房间号
  if (state._pendingRoom) {
    const code = state._pendingRoom;
    if (msg.code === "room-not-found") {
      state._pendingRoom = null;
      send({ type: "create", room: code });
      return;
    }
    if (msg.code === "room-taken") {
      state._pendingRoom = null;
      send({ type: "join", room: code });
      return;
    }
    state._pendingRoom = null;
  }
  toast(ERR_TEXT[msg.code] || `出错了：${msg.code}`);
  if (!state.room && state.ws) {
    state.ws.onclose = null;
    state.ws.close();
    state.ws = null;
  }
}

/* ---------------- 房间流程 ---------------- */

function enterRoom() {
  if (state.room) return;
  const code = $("room-input").value.trim();
  if (code) {
    state._pendingRoom = code; // 记下想进入的房间号，供 room-not-found/room-taken 兜底
    connectSocket(() => send({ type: "join", room: code }));
  } else {
    connectSocket(() => send({ type: "create" }));
  }
}

function onCreated(msg) {
  state._pendingRoom = null;
  enterRoomSuccess(msg.room, msg.peerId, msg.members || []);
}

function onJoined(msg) {
  state._pendingRoom = null;
  enterRoomSuccess(msg.room, msg.peerId, msg.members || []);
}

async function enterRoomSuccess(room, peerId, members) {
  state.room = room;
  state.peerId = peerId;
  state.members = members.filter((id) => id !== peerId);
  $("room-code").textContent = room;
  updateMembers();
  showView("room-view");
  toast(`已进入房间 ${room}，正在开启语音…`);
  await openMic();
  // 与房间内已有成员建立语音（我是发起方，先发 audio-offer）
  for (const id of state.members) establishAudio(id);
  // 更新界面状态
  if (!state.shareOwner) showSharePrompt();
}

function leaveRoom() {
  send({ type: "leave" });
  resetRoom();
}

function resetRoom(reason) {
  // 停麦克风并关闭 WebAudio 增益链
  if (state.micStream) {
    state.micStream.getTracks().forEach((t) => t.stop());
    state.micStream = null;
  }
  if (state.micAudioCtx) {
    try { state.micAudioCtx.close(); } catch { /* ignore */ }
    state.micAudioCtx = null;
  }
  state.micGainNode = null;
  state.micOutputStream = null;
  state.micMuted = false;
  state.memberVolumes.clear();
  state.outputVolumes.clear();
  state.baseOutputVolume = 1;
  // 关闭语音 mesh 连接
  for (const pc of state.audioPcs.values()) closeAudioPc(pc);
  state.audioPcs.clear();
  // 关闭共享相关
  stopShareLocal(false);
  stopWatching();
  if (state.ws) {
    state.ws.onclose = null;
    state.ws.close();
    state.ws = null;
  }
  state.room = null;
  state.peerId = null;
  state.members = [];
  $("member-list").innerHTML = "";
  $("room-input").value = "";
  $("share-prompt").hidden = true;
  showView("landing");
  if (reason) toast(reason);
}

function updateMembers() {
  const list = $("member-list");
  list.innerHTML = "";
  const add = (id, name, isSelf) => {
    const li = document.createElement("li");
    if (isSelf) li.className = "self";
    const row = document.createElement("div");
    row.className = "member-row";
    const dot = document.createElement("span");
    dot.className = "dot";
    const span = document.createElement("span");
    span.textContent = name;
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = isSelf
      ? "自己"
      : state.shareOwner === id
        ? "共享中"
        : "成员";
    // 麦克风 / 听筒图标：各自展开独立的音量滑条
    const micIco = document.createElement("button");
    micIco.type = "button";
    micIco.className = "vol-ico";
    micIco.textContent = "🎤";
    micIco.title = isSelf ? "我的麦克风音量（说出去的音量）" : `${name} 的麦克风音量`;
    const spkIco = document.createElement("button");
    spkIco.type = "button";
    spkIco.className = "vol-ico";
    spkIco.textContent = "🔊";
    spkIco.title = "听筒音量（所有成员声音的总音量，包括你自己调节）";
    row.append(dot, span, tag, micIco, spkIco);

    // 滑条1：麦克风音量（自己=发送增益；他人=该成员声音大小，独立）
    const micSlider = document.createElement("input");
    micSlider.type = "range";
    micSlider.min = "0";
    micSlider.max = "1";
    micSlider.step = "0.01";
    micSlider.className = "member-volume";
    micSlider.title = isSelf ? "我的麦克风音量" : `${name} 的麦克风音量`;
    micSlider.hidden = true;
    micSlider.value = String(
      isSelf ? (state.micGainNode?.gain.value ?? 1) : (state.memberVolumes.get(id) ?? 1)
    );
    micIco.addEventListener("click", () => { micSlider.hidden = !micSlider.hidden; });
    micSlider.addEventListener("input", () => {
      const v = Number(micSlider.value);
      if (isSelf) {
        if (state.micGainNode) state.micGainNode.gain.value = v;
      } else {
        state.memberVolumes.set(id, v);
        const pc = state.audioPcs.get(id);
        if (pc) applyOutputVolume(pc);
      }
    });

    // 滑条2：听筒音量（自己=听筒基准；他人=该成员听筒音量，独立）
    const spkSlider = document.createElement("input");
    spkSlider.type = "range";
    spkSlider.min = "0";
    spkSlider.max = "1";
    spkSlider.step = "0.01";
    spkSlider.className = "member-volume";
    spkSlider.title = isSelf ? "我的听筒音量（总基准）" : `${name} 的听筒音量`;
    spkSlider.hidden = true;
    spkSlider.value = String(
      isSelf ? state.baseOutputVolume : (state.outputVolumes.get(id) ?? 1)
    );
    spkIco.addEventListener("click", () => { spkSlider.hidden = !spkSlider.hidden; });
    spkSlider.addEventListener("input", () => {
      const v = Number(spkSlider.value);
      if (isSelf) {
        state.baseOutputVolume = v;
        for (const pc of state.audioPcs.values()) applyOutputVolume(pc);
      } else {
        state.outputVolumes.set(id, v);
        const pc = state.audioPcs.get(id);
        if (pc) applyOutputVolume(pc);
      }
    });

    li.append(row, micSlider, spkSlider);
    list.appendChild(li);
  };
  add(state.peerId, "我", true);
  for (const id of state.members) {
    add(id, `成员 ${id.slice(0, 4).toUpperCase()}`, false);
  }
  $("member-count").textContent = state.members.length + 1;
}

/* ---------------- 语音（mesh） ---------------- */

/* ---------------- 语音降噪（RNNoise AI 增强） ---------------- */

let _rnnoisePromise = null;
/** 懒加载 RNNoise（wasm 内嵌于 rnnoise-sync.js，同源加载） */
function loadRnnoise() {
  if (!_rnnoisePromise) {
    _rnnoisePromise = (async () => {
      const syncMod = await import("/rnnoise/rnnoise-sync.js");
      const wasmInterface = syncMod.default();
      const procMod = await import("/rnnoise/RnnoiseProcessor.js");
      const RnnoiseProcessor = procMod.default;
      return new RnnoiseProcessor(wasmInterface);
    })().catch((err) => {
      console.error("RNNoise 加载失败", err);
      return null;
    });
  }
  return _rnnoisePromise;
}

/**
 * 构建 AI 降噪处理节点（ScriptProcessorNode + RNNoise，480 帧逐块降噪）。
 * 返回 null 表示加载失败（调用方应回退到直连）。
 */
async function createRnnoiseNode(ctx, source) {
  const denoise = await loadRnnoise();
  if (!denoise) return null;
  const proc = ctx.createScriptProcessor(2048, 1, 1);
  let pending = new Float32Array(0);
  proc.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    const out = e.outputBuffer.getChannelData(0);
    // 累积输入（自动重采样到 ctx 采样率 48000，RNNoise 固定 480 帧/48kHz）
    const nb = new Float32Array(pending.length + input.length);
    nb.set(pending);
    nb.set(input, pending.length);
    // 逐 480 帧降噪（就地处理）
    const frames = Math.floor(nb.length / 480);
    for (let i = 0; i < frames; i++) {
      try {
        denoise.processAudioFrame(nb.subarray(i * 480, (i + 1) * 480), true);
      } catch (err) {
        console.warn("rnnoise frame failed", err);
      }
    }
    const usable = frames * 480;
    if (usable >= out.length) {
      out.set(nb.subarray(0, out.length));
      pending = nb.subarray(out.length);
    } else {
      out.set(nb.subarray(0, usable), 0);
      out.fill(0, usable);
      pending = nb.subarray(usable);
    }
  };
  source.connect(proc);
  return proc;
}

async function openMic() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast("语音不可用：当前页面不是 HTTPS 安全连接（麦克风被浏览器禁用），请用 https:// 地址打开");
    return;
  }
  const nsMode = $("ns-select")?.value || "basic";
  try {
    const raw = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: nsMode === "basic", // 基础档用浏览器内置
      },
    });
    state.micStream = raw;
    // 用 WebAudio 增益控制麦克风发送音量（输入音量可调）
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
      await ctx.resume();
      const src = ctx.createMediaStreamSource(raw);
      const gain = ctx.createGain();
      const dest = ctx.createMediaStreamDestination();
      if (nsMode === "ai") {
        // AI 增强：RNNoise 降噪节点插在增益前
        const nsNode = await createRnnoiseNode(ctx, src);
        if (nsNode) {
          nsNode.connect(gain);
          dbg("mic: AI 降噪（RNNoise）已启用");
        } else {
          src.connect(gain);
          toast("AI 降噪加载失败，已回退到无降噪");
        }
      } else {
        src.connect(gain);
      }
      gain.connect(dest);
      state.micAudioCtx = ctx;
      state.micGainNode = gain;
      state.micOutputStream = dest.stream;
    } catch (err) {
      console.warn("mic gain setup failed", err);
      state.micOutputStream = raw; // 回退：直接使用原始流
    }
    state.micMuted = false;
    $("mic-btn").textContent = "🎤 麦克风开";
    toast("麦克风已开启，可以说话了");
  } catch (err) {
    state.micStream = null;
    if (err.name === "NotAllowedError" || err.name === "SecurityError") {
      toast("麦克风权限被拒绝：请点击浏览器地址栏的摄像头图标，允许麦克风后重新进入房间");
    } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
      toast("未检测到麦克风设备：请检查系统输入设备（外接/内置麦克风）是否可用");
    } else if (err.name === "NotReadableError") {
      toast("麦克风被其他应用占用：请关闭占用麦克风的软件（会议软件、录音等）后重试");
    } else if (err.name === "OverconstrainedError") {
      toast("没有符合要求的麦克风设备");
    } else {
      toast(`麦克风不可用（${err.name}），请检查设备与浏览器权限`);
    }
  }
}

/** 检测音频输入/输出设备，进入房间前给用户明确提示 */
async function checkDevices() {
  try {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === "audioinput");
    const outputs = devices.filter((d) => d.kind === "audiooutput");
    dbg("audio devices:", { inputs: inputs.length, outputs: outputs.length });
    if (inputs.length === 0) {
      toast("未检测到麦克风输入设备，语音将不可用（只能听）");
    }
  } catch {
    /* ignore */
  }
}

function toggleMic() {
  state.micMuted = !state.micMuted;
  if (state.micStream) {
    for (const t of state.micStream.getAudioTracks()) t.enabled = !state.micMuted;
  }
  $("mic-btn").textContent = state.micMuted ? "🎤 麦克风关" : "🎤 麦克风开";
}

/** 降噪档位切换后重建语音链路（关闭旧链 → 通知对方重建 → 重新开麦 → 重新建立语音连接） */
async function reapplyMicSettings() {
  // 先通知所有成员：我要重建语音连接（对方关闭旧连接，等待我的新 offer）
  for (const id of state.members) send({ type: "audio-reinit", to: id });
  for (const pc of state.audioPcs.values()) closeAudioPc(pc);
  state.audioPcs.clear();
  if (state.micStream) {
    state.micStream.getTracks().forEach((t) => t.stop());
    state.micStream = null;
  }
  if (state.micAudioCtx) {
    try { state.micAudioCtx.close(); } catch { /* ignore */ }
    state.micAudioCtx = null;
  }
  state.micGainNode = null;
  state.micOutputStream = null;
  state.micMuted = false;
  toast("正在应用降噪设置…");
  await openMic();
  for (const id of state.members) establishAudio(id);
}

function createPc(label) {
  const pc = new RTCPeerConnection({ iceServers: appConfig.iceServers });
  const pendingIce = [];
  let remoteReady = false;
  pc.label = label;
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

/** 播放远程音频：mesh 下每条连接一个隐藏 audio 元素（听筒总音量 × 该成员麦克风音量） */
function attachAudioOutput(pc) {
  pc.ontrack = (e) => {
    const stream = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
    if (pc._audioEl) pc._audioEl.remove();
    const audioEl = document.createElement("audio");
    audioEl.autoplay = true;
    audioEl.style.display = "none";
    document.body.appendChild(audioEl);
    audioEl.srcObject = stream;
    applyOutputVolume(pc);
    audioEl.play().catch(() => {});
    pc._audioEl = audioEl;
  };
}

/** 应用音量：audioEl.volume = 听筒基准 × 该成员听筒音量 × 该成员麦克风音量（三个独立值相乘） */
function applyOutputVolume(pc) {
  if (!pc?._audioEl) return;
  const member = state.memberVolumes.get(pc._peerId) ?? 1;
  const output = state.outputVolumes.get(pc._peerId) ?? 1;
  pc._audioEl.volume = state.baseOutputVolume * output * member;
}

function closeAudioPc(pc) {
  try {
    if (pc._audioEl) pc._audioEl.remove();
    pc.close();
  } catch { /* ignore */ }
}

/** 与某成员建立语音连接（我发起 offer）；无麦克风也建立（至少能听到对方） */
function establishAudio(peerId) {
  if (state.audioPcs.has(peerId)) return;
  const pc = createPc(`audio:${peerId}`);
  pc.kind = "audio";
  pc._peerId = peerId;
  pc._initiator = true;
  state.audioPcs.set(peerId, pc);
  attachAudioOutput(pc);
  pc.onicecandidate = (e) => {
    if (e.candidate) send({ type: "audio-ice", to: peerId, candidate: e.candidate });
  };
  const sendStream = state.micOutputStream || state.micStream;
  if (sendStream) {
    for (const t of sendStream.getAudioTracks()) pc.addTrack(t, sendStream);
  }
  pc.createOffer()
    .then((o) => pc.setLocalDescription(o))
    .then(() => send({ type: "audio-offer", to: peerId, sdp: pc.localDescription }))
    .catch((err) => console.error("audio offer failed", err));
}

function onAudioOffer(msg) {
  const peerId = msg.from;
  // 已有连接：若连接已失效（closed/failed，如对方重建过语音链）则允许重建，否则忽略重复 offer
  if (state.audioPcs.has(peerId)) {
    const old = state.audioPcs.get(peerId);
    if (old.connectionState === "closed" || old.connectionState === "failed") {
      closeAudioPc(old);
      state.audioPcs.delete(peerId);
    } else {
      return;
    }
  }
  const pc = createPc(`audio:${peerId}`);
  pc.kind = "audio";
  pc._peerId = peerId;
  state.audioPcs.set(peerId, pc);
  attachAudioOutput(pc);
  pc.onicecandidate = (e) => {
    if (e.candidate) send({ type: "audio-ice", to: peerId, candidate: e.candidate });
  };
  const sendStream = state.micOutputStream || state.micStream;
  if (sendStream) {
    for (const t of sendStream.getAudioTracks()) pc.addTrack(t, sendStream);
  }
  pc.setRemoteDescription(msg.sdp)
    .then(() => {
      pc.flushIce(); // 冲刷在 offer 之前到达的 ICE 候选
      return pc.createAnswer();
    })
    .then((a) => pc.setLocalDescription(a))
    .then(() => send({ type: "audio-answer", to: peerId, sdp: pc.localDescription }))
    .catch((err) => console.error("audio answer failed", err));
}

function onAudioAnswer(msg) {
  const pc = state.audioPcs.get(msg.from);
  if (!pc) return;
  pc.setRemoteDescription(msg.sdp)
    .then(() => pc.flushIce())
    .catch((err) => console.error("audio setRemote failed", err));
}

function onAudioIce(msg) {
  const pc = state.audioPcs.get(msg.from);
  if (pc) pc.queueIce(msg.candidate);
}

/** 对方重建了语音链：关闭与该成员的旧连接，等待对方的新 offer */
function onAudioReinit(msg) {
  const peerId = msg.from;
  const pc = state.audioPcs.get(peerId);
  if (pc) {
    closeAudioPc(pc);
    state.audioPcs.delete(peerId);
  }
}

function onPeerJoined(msg) {
  if (msg.peerId === state.peerId) return;
  state.members.push(msg.peerId);
  updateMembers();
  // 我是共享者：新成员加入即推流（语音由新成员主动发起 offer，避免双向重复建连）
  if (state.shareOwner === state.peerId && state.shareStream) {
    setupViewerPc(msg.peerId);
  }
}

function onPeerLeft(msg) {
  const leftId = msg.peerId;
  // 关闭语音连接
  const audioPc = state.audioPcs.get(leftId);
  if (audioPc) {
    closeAudioPc(audioPc);
    state.audioPcs.delete(leftId);
  }
  // 共享者离开：停止观看
  if (state.shareOwner === leftId) stopWatching();
  // 我是共享者且观看者离开：关推流
  if (state.shareOwner === state.peerId) {
    const vpc = state.viewerPcs.get(leftId);
    if (vpc) {
      stopBitrateAdaptation(vpc);
      vpc.close();
      state.viewerPcs.delete(leftId);
    }
  }
  state.members = state.members.filter((id) => id !== leftId);
  updateMembers();
}

/* ---------------- 画面共享（我是共享者） ---------------- */

async function startShare() {
  if (state.shareOwner === state.peerId) return; // 已在共享
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast("当前浏览器不支持屏幕捕获，请使用最新版 Chrome / Edge");
    return;
  }
  const quality = buildQuality();
  state.quality = quality;
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: quality.frameRate },
      audio: false,
    });
  } catch (err) {
    toast(err.name === "NotAllowedError" ? "已取消共享" : `无法获取屏幕：${err.message}`);
    return;
  }
  // 浏览器工具条手动结束共享
  for (const track of stream.getTracks()) {
    track.onended = () => {
      if (state.shareOwner === state.peerId) stopShare();
    };
  }
  state.shareStream = stream;
  state.shareOwner = state.peerId;
  // 预览自己的共享画面
  const video = $("remote-video");
  video.srcObject = stream;
  $("stop-share-btn").hidden = false;
  $("share-prompt").hidden = true;
  $("viewer-status").textContent = "你正在共享画面";
  for (const t of stream.getVideoTracks()) {
    t.applyConstraints({ frameRate: quality.frameRate }).catch(() => {});
    if (quality.contentHint) {
      try { t.contentHint = quality.contentHint; } catch { /* ignore */ }
    }
  }
  // 通知房间并给每个成员推流
  send({ type: "share-start" });
  dbg("share: started by me, quality", quality.label, quality.maxBitrate);
  for (const id of state.members) setupViewerPc(id);
}

function stopShare(reason) {
  if (state.shareOwner !== state.peerId) return;
  send({ type: "share-stop" });
  stopShareLocal(true);
  if (reason) toast(reason);
}

/** 停止本地推流（不重复发 share-stop 广播） */
function stopShareLocal(notifyUi) {
  if (state.shareStream) {
    state.shareStream.getTracks().forEach((t) => t.stop());
    state.shareStream = null;
  }
  for (const pc of state.viewerPcs.values()) {
    stopBitrateAdaptation(pc);
    pc.close();
  }
  state.viewerPcs.clear();
  state.shareOwner = null;
  state.quality = null;
  $("remote-video").srcObject = null;
  $("stop-share-btn").hidden = true;
  if (notifyUi !== false) {
    showSharePrompt();
    $("viewer-status").textContent = "进入房间";
  }
}

function showSharePrompt() {
  $("share-prompt").hidden = false;
}

/** 为某个观看者建立/重建视频连接并发送 offer（用于新加入或重连） */
function setupViewerPc(peerId) {
  const old = state.viewerPcs.get(peerId);
  const prevQuality = old?._viewerQuality;
  if (old) {
    try { stopBitrateAdaptation(old); old.close(); } catch { /* ignore */ }
  }
  const pc = createPc(`viewer:${peerId}`);
  pc.peerTarget = peerId;
  // 关键：发送本端 ICE candidate（缺失则 P2P 无法打洞，画面不通）
  pc.onicecandidate = (e) => {
    if (e.candidate) send({ type: "ice", to: peerId, candidate: e.candidate });
  };
  state.viewerPcs.set(peerId, pc);
  if (!state.shareStream) return;
  for (const track of state.shareStream.getTracks()) {
    pc.addTrack(track, state.shareStream);
  }
  pinVideoCodecs(pc);
  if (prevQuality && prevQuality !== "1080") {
    try { applyViewerQuality(pc, prevQuality); } catch { /* ignore */ }
  }
  pc.createOffer()
    .then((offer) => pc.setLocalDescription(offer))
    .then(() => applyMaxBitrate(pc))
    .then(() => startBitrateAdaptation(pc))
    .then(() => send({ type: "offer", to: peerId, sdp: pc.localDescription }))
    .catch((err) => console.error("createOffer failed", err));
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
      }
    }
  } catch (err) {
    console.warn("setCodecPreferences failed", err);
  }
}

/** 按当前画质档位设置视频发送码率上限与降级策略 */
function applyMaxBitrate(pc) {
  if (!state.quality) return;
  const bps = state.quality.maxBitrate;
  pc._bitrate = bps;
  applyBitrate(pc, bps);
}

function applyBitrate(pc, bps) {
  for (const sender of pc.getSenders()) {
    if (sender.track?.kind !== "video") continue;
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = bps;
      if (!pc._viewerQuality && state.quality?.degradation) {
        params.degradationPreference = state.quality.degradation;
      }
      sender.setParameters(params).catch(() => {});
    } catch (err) {
      console.warn("setParameters failed", err);
    }
  }
}

/* ---------------- 自适应码率 ---------------- */

const BITRATE_STEPS = [
  800_000, 1_000_000, 1_500_000, 2_000_000, 3_000_000,
  4_000_000, 6_000_000, 8_000_000, 10_000_000, 12_000_000,
  14_000_000, 16_000_000,
];
const ADAPT_INTERVAL_MS = 2000;
const LOSS_DOWN = 0.08;
const LOSS_UP = 0.02;
const UP_AFTER = 3;

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
    if (state.shareOwner !== state.peerId || pc.connectionState !== "connected") return;
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
          } else if (loss < LOSS_UP) {
            adapt.stableCount++;
            if (adapt.stableCount >= UP_AFTER) {
              adapt.stableCount = 0;
              target = stepUpBitrate(pc._bitrate ?? initial, initial);
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

/* ---------------- 观看画面（他人共享） ---------------- */

const VIEWER_QUALITY_SPEC = {
  "1080": { scaleH: 1080, maxBitrate: 9_000_000, degradation: "maintain-framerate" },
  "720":  { scaleH: 720,  maxBitrate: 4_500_000, degradation: "maintain-resolution" },
  "360":  { scaleH: 360,  maxBitrate: 1_800_000, degradation: "maintain-resolution" },
};

function onShareStarted(msg) {
  const ownerId = msg.peerId;
  if (ownerId === state.peerId) return; // 自己发起的，本地已处理
  state.shareOwner = ownerId;
  $("share-prompt").hidden = true;
  updateMembers();
  $("viewer-status").textContent = "等待共享画面…";
  // 共享者会主动发 offer 给我，无需额外操作
  dbg("share started by", ownerId);
}

function onShareStopped(msg) {
  const ownerId = msg.peerId;
  // 我是共享者且被新共享者替换：停止本地推流（不再广播）
  if (ownerId === state.peerId && state.shareOwner === state.peerId) {
    stopShareLocal(true);
    toast("画面共享已切换给其他成员");
    return;
  }
  // 我在观看这个共享者：断开
  if (state.shareOwner === ownerId) {
    stopWatching();
  }
}

function stopWatching() {
  if (state.videoPc) {
    stopBitrateAdaptation(state.videoPc);
    state.videoPc.close();
    state.videoPc = null;
  }
  state.hostPeerId = null;
  state.shareOwner = null;
  $("remote-video").srcObject = null;
  $("stop-share-btn").hidden = true;
  $("viewer-status").textContent = "进入房间";
  showSharePrompt();
  updateMembers();
}

/** 观看者收到共享者的 offer（视频） */
function onOffer(msg) {
  if (state.shareOwner !== msg.from) {
    // 新共享者（可能没收到 share-started）：接受
    state.shareOwner = msg.from;
    updateMembers();
  }
  state.hostPeerId = msg.from;
  let pc = state.videoPc;
  if (!pc || pc.signalingState === "closed") {
    clearReconnectState();
    pc = createPc("video");
    pc.peerTarget = msg.from;
    state.videoPc = pc;
    // 关键：发送本端 ICE candidate（缺失则 P2P 无法打洞，画面不通）
    pc.onicecandidate = (e) => {
      if (e.candidate && state.hostPeerId) {
        send({ type: "ice", to: state.hostPeerId, candidate: e.candidate });
      }
    };
    pc.ontrack = (e) => {      const stream = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
      const video = $("remote-video");
      video.srcObject = stream;
      video.onloadeddata = () => {
        dbg("viewer: loadeddata", video.videoWidth + "x" + video.videoHeight);
        $("viewer-status").textContent =
          video.videoWidth > 0 ? `正在播放 ${video.videoWidth}×${video.videoHeight}` : "正在播放";
      };
      video.play().catch((err) => {
        dbg("viewer: autoplay blocked", err.name);
        video.muted = true;
        video.play().catch(() => {});
        $("unmute-btn").hidden = false;
      });
    };
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

function onAnswer(msg) {
  const pc = state.viewerPcs.get(msg.from);
  if (!pc) return;
  pc.setRemoteDescription(msg.sdp)
    .then(() => pc.flushIce())
    .catch((err) => console.error("setRemote failed", err));
}

function onIce(msg) {
  const pc =
    state.viewerPcs.get(msg.from) ||
    (msg.from === state.hostPeerId ? state.videoPc : null);
  if (pc) pc.queueIce(msg.candidate);
}

/** 观看者请求重连：共享者重建该观看者连接 */
function onRenegotiate(msg) {
  if (state.shareOwner !== state.peerId) return;
  const peerId = msg.from;
  if (!state.viewerPcs.has(peerId)) return;
  setupViewerPc(peerId);
}

/** 观看者切换清晰度 */
function applyViewerQuality(pc, quality) {
  const spec = VIEWER_QUALITY_SPEC[quality] || VIEWER_QUALITY_SPEC["1080"];
  const dynamic = state.quality?.degradation === "maintain-framerate";
  const bitrate = Math.round(spec.maxBitrate * (dynamic ? 1.5 : 1.0));
  const sender = pc.getSenders().find((s) => s.track?.kind === "video");
  const track = sender?.track;
  const srcH = track?.getSettings?.().height || 1080;
  const scale = Math.max(1, Math.round((srcH / spec.scaleH) * 2) / 2);
  for (const s of pc.getSenders()) {
    if (s.track?.kind !== "video") continue;
    try {
      const params = s.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      const enc = params.encodings[0];
      enc.scaleResolutionDownBy = scale;
      enc.maxBitrate = bitrate;
      params.degradationPreference = spec.degradation;
      s.setParameters(params).catch(() => {});
    } catch (err) {
      console.warn("setViewerQuality error", err);
    }
  }
  pc._viewerQuality = quality;
  pc._bitrate = bitrate;
  if (pc._adapt) pc._adapt.initial = bitrate;
}

function renegotiateViewer(pc) {
  pc.createOffer()
    .then((offer) => pc.setLocalDescription(offer))
    .then(() => send({ type: "offer", to: pc.peerTarget, sdp: pc.localDescription }))
    .catch((err) => console.error("renegotiate offer failed", err));
}

function onSetQuality(msg) {
  if (state.shareOwner !== state.peerId) return;
  const pc = state.viewerPcs.get(msg.from);
  if (!pc || pc.connectionState !== "connected") return;
  const quality = VIEWER_QUALITY_SPEC[msg.quality] ? msg.quality : "1080";
  if (quality === pc._viewerQuality) return;
  applyViewerQuality(pc, quality);
  renegotiateViewer(pc);
}

/* ---------------- 观看端控制条 ---------------- */

function updateAudioUI() {
  const v = $("remote-video");
  if (!v) return;
  $("mute-btn").textContent = v.muted || v.volume === 0 ? "🔇" : "🔊";
  $("volume-range").value = String(v.volume);
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

function toggleFit() {
  state.fit = state.fit === "cover" ? "contain" : "cover";
  applyFit();
}

function applyFit() {
  const v = $("remote-video");
  v.dataset.fit = state.fit;
  $("fit-btn").textContent = state.fit === "cover" ? "占满" : "适应";
}

/* ---------------- 重连 ---------------- */

function clearReconnectState() {
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  state.reconnectInProgress = false;
}

function requestRenegotiate() {
  if (state.reconnectInProgress) return;
  state.reconnectInProgress = true;
  send({ type: "renegotiate" });
  state.reconnectTimer = setTimeout(() => { state.reconnectInProgress = false; }, 6000);
}

function scheduleRenegotiate() {
  if (state.reconnectTimer) return;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectInProgress = false;
    requestRenegotiate();
  }, 2500);
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

function bindEvents() {
  // 非 HTTPS 安全上下文提示
  if (!window.isSecureContext) {
    const hint = $("secure-hint");
    if (hint) {
      hint.textContent = appConfig.httpsPort
        ? `https://${location.hostname}:${appConfig.httpsPort}/`
        : `https://${location.hostname}/`;
    }
    $("secure-warning").hidden = false;
  }

  // 降噪档位：记住选择；切换后重建语音链（对房间内所有语音生效）
  const NS_KEY = "screlink.nsMode";
  const nsSelect = $("ns-select");
  if (nsSelect) {
    const savedNs = localStorage.getItem(NS_KEY);
    if (savedNs) nsSelect.value = savedNs;
    nsSelect.addEventListener("change", () => {
      localStorage.setItem(NS_KEY, nsSelect.value);
      if (state.room) reapplyMicSettings();
    });
  }

  $("join-btn").addEventListener("click", enterRoom);
  $("room-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") enterRoom();
  });
  $("leave-btn").addEventListener("click", leaveRoom);
  $("mic-btn").addEventListener("click", toggleMic);
  $("share-btn").addEventListener("click", startShare);
  $("stop-share-btn").addEventListener("click", () => stopShare("已停止共享"));

  // 观看端控制条
  $("unmute-btn").addEventListener("click", () => {
    const v = $("remote-video");
    v.muted = false;
    v.play().catch(() => {});
    $("unmute-btn").hidden = true;
    updateAudioUI();
  });
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
  $("quality-select-viewer").addEventListener("change", (e) => {
    if (state.shareOwner && state.shareOwner !== state.peerId) {
      const q = e.target.value;
      send({ type: "set-quality", to: state.shareOwner, quality: q });
      $("viewer-status").textContent = `切换清晰度 ${q}p 中…`;
    }
  });
  $("fs-btn").addEventListener("click", toggleFullscreen);
  document.addEventListener("fullscreenchange", updateFullscreenUI);
  document.addEventListener("webkitfullscreenchange", updateFullscreenUI);
  document.addEventListener("msfullscreenchange", updateFullscreenUI);
  $("fit-btn").addEventListener("click", toggleFit);
  applyFit();

  // 控制条自动隐藏：鼠标 2 秒不动隐藏，移动/触碰显示
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
  for (const id of ["mute-btn", "volume-range", "fit-btn", "fs-btn", "unmute-btn", "quality-select-viewer", "stop-share-btn"]) {
    $(id).addEventListener("mouseenter", keepControlsShown);
    $(id).addEventListener("mouseleave", showControlsTemporarily);
  }

  window.__screlinkDebug = async () => {
    let devices = { inputs: "?", outputs: "?" };
    let micLabel = "?";
    try {
      if (navigator.mediaDevices?.enumerateDevices) {
        const ds = await navigator.mediaDevices.enumerateDevices();
        const ins = ds.filter((d) => d.kind === "audioinput");
        const outs = ds.filter((d) => d.kind === "audiooutput");
        devices = { inputs: ins.length, outputs: outs.length };
        if (ins[0]) micLabel = ins[0].label || "(未授权，看不到名称)";
      }
    } catch { /* ignore */ }
    return {
      secureContext: window.isSecureContext,
      mediaDevicesAvailable: !!navigator.mediaDevices?.getUserMedia,
      devices,
      micLabel,
      room: state.room,
      peerId: state.peerId,
      members: state.members,
      shareOwner: state.shareOwner,
      micEnabled: !state.micMuted && !!state.micStream,
      audioPcs: [...state.audioPcs.keys()],
      viewerPcs: [...state.viewerPcs.keys()],
      wsReadyState: state.ws ? state.ws.readyState : null,
    };
  };
}

(async () => {
  await loadConfig();
  bindEvents();
  checkDevices(); // 进入房间前先检测音频设备，给出提示
})();
