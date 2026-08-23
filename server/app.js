import http from "node:http";
import https from "node:https";
import os from "node:os";
import { WebSocketServer, WebSocket } from "ws";
import { config } from "./config.js";
import { SignalingServer, normalizeRoomCode } from "./signaling.js";
import { createStaticHandler } from "./static.js";
import { loadTlsOptions } from "./https.js";

/** 收集本机局域网 IPv4 地址（不含回环） */
export function lanIPv4s() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === "IPv4" && !net.internal) out.push(net.address);
    }
  }
  return out;
}

/**
 * 把 /livekit 的 HTTP 与 WebSocket 反代到 LiveKit（targetBase，如 ws://host.docker.internal:7880）。
 * 用 http-proxy（经实战验证的 WS 代理）处理 upgrade，浏览器用「同源 wss/ws」连接规避混合内容。
 */
function attachLiveKitProxy(server, targetBase) {
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (clientWs, req) => {
    // 去掉 /livekit 前缀，LiveKit 只认 /rtc...
    const targetPath = (req.url || "").replace(/^\/livekit/, "") || "/";
    const protoHeader = req.headers["sec-websocket-protocol"];
    const protocols = protoHeader ? protoHeader.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const upstream = protocols.length
      ? new WebSocket(targetBase + targetPath, protocols)
      : new WebSocket(targetBase + targetPath);
    const buffer = [];
    let upOpen = false;
    upstream.on("open", () => { upOpen = true; for (const d of buffer) upstream.send(d); buffer.length = 0; });
    upstream.on("message", (d) => clientWs.readyState === WebSocket.OPEN && clientWs.send(d));
    upstream.on("close", () => clientWs.close());
    upstream.on("error", (e) => { console.error("livekit proxy upstream error:", e?.message); clientWs.close(); });
    clientWs.on("message", (d) => { if (upOpen) upstream.send(d); else buffer.push(d); });
    clientWs.on("close", () => upstream.close());
  });
  server.on("upgrade", (req, socket, head) => {
    if (!req.url || !req.url.startsWith("/livekit")) return; // 其它（如 /ws）交给信令 WSS
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  return wss;
}

/**
 * 组装 HTTP(S) + WebSocket 应用。
 * 返回未启动的 server 实例，由调用方 listen（便于测试用 0 端口）。
 */
export function createApp(options = {}) {
  const signaling = new SignalingServer();
  const staticHandler = createStaticHandler();

  const handleRequest = async (req, res) => {
    const url = new URL(req.url, "http://localhost");

    if (url.pathname === "/api/health") {
      const body = { status: "ok", version: config.version, ...signaling.snapshot() };
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
      return;
    }

    if (url.pathname === "/api/config") {
      const httpPort = httpServer.address()?.port ?? config.port;
      const httpsPort = httpsServer?.address()?.port;
      const ips = lanIPv4s();
      // 前端所需的 ICE 配置：STUN + 可选的 TURN 中继
      const iceServers = [
        { urls: config.stunUrls },
        ...(config.turnUrls.length
          ? [
              {
                urls: config.turnUrls,
                ...(config.turnUser
                  ? { username: config.turnUser, credential: config.turnPass }
                  : {}),
              },
            ]
          : []),
      ];
      const body = {
        version: config.version,
        maxViewersPerRoom: config.maxViewersPerRoom,
        roomCodeLength: config.roomCodeLength,
        iceServers,
        stunUrls: config.stunUrls,
        httpsPort: httpsPort ?? null,
        lanHttpUrls: ips.map((ip) => `http://${ip}:${httpPort}`),
        lanHttpsUrls: httpsPort ? ips.map((ip) => `https://${ip}:${httpsPort}`) : [],
        sfu: { enabled: config.sfuEnabled, livekitUrl: config.livekit.url },
      };
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
      return;
    }

    // SFU（LiveKit）token 签发：host 发布 / viewer 订阅
    if (url.pathname === "/api/livekit/token") {
      const room = normalizeRoomCode(url.searchParams.get("room") || "");
      const role = url.searchParams.get("role") === "publisher" ? "publisher" : "subscriber";
      if (!config.sfuEnabled) {
        res.writeHead(501, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "sfu-not-configured", message: "服务器未配置 LiveKit（SCRELINK/LIVEKIT_API_KEY/SECRET）" }));
        return;
      }
      if (!room || room.length < 2 || room.length > 8) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "bad-room" }));
        return;
      }
      try {
        // 动态导入，避免未配置 LiveKit 时影响启动/测试
        const { AccessToken } = await import("livekit-server-sdk");
        const identity = role === "publisher" ? `host-${room}` : `viewer-${room}-${Math.random().toString(36).slice(2, 8)}`;
        const token = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
          identity,
          name: role === "publisher" ? "主机" : "观看者",
        });
        token.addGrant({
          room: `room-${room}`,
          roomJoin: true,
          canPublish: role === "publisher",
          canSubscribe: true,
          canPublishData: role === "publisher",
        });
        const jwt = await token.toJwt();
        // 浏览器通过 Caddy 同源反代连接 LiveKit：主机(wss)/观看者(ws) 均为 /livekit
        // 后面可能被 Caddy 反代终止 TLS，故用 X-Forwarded-Proto 判断外层协议
        const outerProto = String(req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http")).split(",")[0];
        const url = `${outerProto === "https" ? "wss" : "ws"}://${req.headers.host}/livekit`;
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ url, token: jwt, room: `room-${room}`, role }));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "token-error", message: String(err?.message || err) }));
      }
      return;
    }

    // 普通 HTTP 也反代到 LiveKit（如 /rtc/validate 校验 token），非 WebSocket 的请求
    if (url.pathname.startsWith("/livekit")) {
      const rest = url.pathname.replace(/^\/livekit/, "") || "/";
      const base = config.livekit.url.replace(/^ws/, "http"); // ws:// -> http://
      const target = base + rest + url.search;
      try {
        const opts = { method: req.method, headers: { ...req.headers, host: new URL(target).host } };
        if (!["GET", "HEAD"].includes(req.method)) { opts.body = req; opts.duplex = "half"; }
        const resp = await fetch(target, opts);
        const respHeaders = { "content-type": resp.headers.get("content-type") || "application/octet-stream" };
        res.writeHead(resp.status, respHeaders);
        if (resp.body) {
          const reader = resp.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!res.write(value)) await new Promise((r) => res.once("drain", r));
          }
        }
        res.end();
      } catch (err) {
        console.error("livekit http proxy error:", err?.message);
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end("502 proxy error");
      }
      return;
    }

    staticHandler(req, res);
  };

  const httpServer = http.createServer(handleRequest);
  const wss = signaling.attach(httpServer);
  attachLiveKitProxy(httpServer, config.livekit.url);

  // 始终同时创建 HTTPS（自签名）监听：观看者走 HTTP(8787)、主机走 HTTPS(8788) 以满足屏幕捕获的安全上下文要求
  const httpsServer = https.createServer(loadTlsOptions(), handleRequest);
  const wssTls = signaling.attach(httpsServer);
  attachLiveKitProxy(httpsServer, config.livekit.url);

  return { signaling, httpServer, httpsServer, wss, wssTls };
}
