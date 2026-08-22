import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import selfsigned from "selfsigned";
import { config } from "./config.js";

/** 收集本机局域网 IPv4 地址，写入证书 SAN 以减轻浏览器告警 */
function localAltNames() {
  const names = [
    { type: 2, value: "localhost" },
    { type: 7, ip: "127.0.0.1" },
    { type: 7, ip: "::1" },
  ];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === "IPv4" && !net.internal) {
        names.push({ type: 7, ip: net.address });
      }
    }
  }
  return names;
}

/**
 * 加载或生成自签名 TLS 证书（HTTPS 模式）。
 * 浏览器对自签名证书会提示警告，信任后即可正常使用
 * getDisplayMedia（屏幕共享要求安全上下文）。
 * 证书落在 certs/ 目录，已加入 .gitignore。
 */
export function loadTlsOptions() {
  const keyPath = path.join(config.certDir, "key.pem");
  const certPath = path.join(config.certDir, "cert.pem");
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }
  const pems = selfsigned.generate(
    [{ name: "commonName", value: "Screlink" }],
    {
      days: config.certDays,
      keySize: 2048,
      algorithm: "sha256",
      extensions: [{ name: "subjectAltName", altNames: localAltNames() }],
    }
  );
  fs.mkdirSync(config.certDir, { recursive: true });
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  return { key: pems.private, cert: pems.cert };
}
