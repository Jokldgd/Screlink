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
};

let appConfig = {
  version: null,
  stunUrls: ["stun:stun.l.google.com:19302"],
  maxViewersPerRoom: 8,
  lanHttpUrls: [],
  lanHttpsUrls: [],
};

const ERR_TEXT = {
  "room-not-found": "房间不存在或共享已结束",
  "room-full": "房间人数已满",
  "already-in-room": "你已在房间中",
  "not-in-room": "尚未加入房间",
  "bad-json": "消息格式错误",
  "unknown-type": "未知消息类型",
};

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
  const pc = new RTCPeerConnection({ iceServers: [{ urls: appConfig.stunUrls }] });
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

/* ---------------- 主机逻辑 ---------------- */

async function startSharing() {
  if (state.role) return;
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast("当前浏览器不支持屏幕捕获，请使用最新版 Chrome / Edge");
    return;
  }
  state.includeAudio = $("audio-checkbox").checked;
  setBusy($("share-btn"), true, "请在弹窗中选择屏幕…");
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 60 } },
      audio: state.includeAudio ? { echoCancellation: false, noiseSuppression: false } : false,
    });
  } catch (err) {
    setBusy($("share-btn"), false);
    toast(err.name === "NotAllowedError" ? "已取消，未开始共享" : `无法获取屏幕：${err.message}`);
    return;
  }
  setBusy($("share-btn"), false);

  state.localStream = stream;
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

  const pc = createPc(`viewer:${peerId}`);
  pc.peerTarget = peerId;
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
      toast("与某位观看者的连接不稳定");
    }
  };
  state.viewerPcs.set(peerId, pc);
  for (const track of state.localStream.getTracks()) {
    pc.addTrack(track, state.localStream);
  }
  pc.createOffer()
    .then((offer) => pc.setLocalDescription(offer))
    .then(() => send({ type: "offer", to: peerId, sdp: pc.localDescription }))
    .catch((err) => console.error("createOffer failed", err));
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
    pc = createPc("host");
    pc.peerTarget = msg.from;
    pc.onconnectionstatechange = () => {
      const map = {
        connecting: "正在连接…",
        connected: "正在播放",
        disconnected: "连接中断，尝试重连…",
        failed: "连接失败",
      };
      if (pc.connectionState === "connected") {
        $("viewer-status").textContent = "正在播放";
      } else if (map[pc.connectionState]) {
        $("viewer-status").textContent = map[pc.connectionState];
      }
    };
    pc.ontrack = (e) => {
      $("remote-video").srcObject = e.streams[0];
      $("viewer-status").textContent = "正在播放";
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
