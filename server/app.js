import http from "node:http";
import https from "node:https";
import os from "node:os";
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
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ url: config.livekit.url, token: jwt, room: `room-${room}`, role }));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "token-error", message: String(err?.message || err) }));
      }
      return;
    }

    staticHandler(req, res);
  };

  const httpServer = http.createServer(handleRequest);
  const wss = signaling.attach(httpServer);

  // 始终同时创建 HTTPS（自签名）监听：观看者走 HTTP(8787)、主机走 HTTPS(8788) 以满足屏幕捕获的安全上下文要求
  const httpsServer = https.createServer(loadTlsOptions(), handleRequest);
  const wssTls = signaling.attach(httpsServer);

  return { signaling, httpServer, httpsServer, wss, wssTls };
}
