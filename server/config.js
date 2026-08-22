import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 集中配置：全部可通过环境变量覆盖（前缀 SCRELINK_）。
 */
export const config = {
  /** 版本号：唯一来源是 package.json，见 docs/ARCHITECTURE.md */
  version: pkg.version,

  rootDir: path.resolve(__dirname, ".."),
  publicDir: path.resolve(__dirname, "../public"),
  certDir: path.resolve(__dirname, "../certs"),

  /** 监听地址，0.0.0.0 表示局域网内其他设备也可访问 */
  host: process.env.SCRELINK_HOST || "0.0.0.0",

  /** 默认端口：HTTP 8787，HTTPS 8788 */
  port: Number(process.env.SCRELINK_PORT || 8787),
  httpsPort: Number(process.env.SCRELINK_HTTPS_PORT || 8788),

  /** 每个房间允许的最大观看人数 */
  maxViewersPerRoom: Number(process.env.SCRELINK_MAX_VIEWERS || 8),

  /** 房间号长度（字符），取无歧义字母表 */
  roomCodeLength: 6,

  /** WebSocket 心跳间隔（毫秒），用于清理死连接 */
  heartbeatIntervalMs: 30_000,

  /** STUN 服务器（逗号分隔），用于 NAT 穿透；局域网内互看其实用不到 */
  stunUrls: (process.env.SCRELINK_STUN || "stun:stun.l.google.com:19302")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  /** 自签名证书有效期（天），仅 HTTPS 模式使用 */
  certDays: Number(process.env.SCRELINK_CERT_DAYS || 365),
};
