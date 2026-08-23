import http from "node:http";
import https from "node:https";
import os from "node:os";
import { config } from "./config.js";
import { SignalingServer } from "./signaling.js";
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

  const handleRequest = (req, res) => {
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
      };
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
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
