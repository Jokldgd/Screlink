/**
 * 生成 LiveKit 自签 TLS 证书（wss 用），SAN 含 localhost + PUBLIC_IP。
 * 运行：PUBLIC_IP=121.199.163.15 npm run gen:livekit-cert
 * 输出：certs/livekit/{key.pem, cert.pem}
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import selfsigned from "selfsigned";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ip = process.env.PUBLIC_IP || "";

const altNames = [
  { type: 2, value: "localhost" },
  { type: 7, ip: "127.0.0.1" },
  { type: 7, ip: "::1" },
];
if (ip) altNames.push({ type: 7, ip });

const pems = selfsigned.generate([{ name: "commonName", value: "LiveKit" }], {
  days: 365,
  keySize: 2048,
  algorithm: "sha256",
  extensions: [{ name: "subjectAltName", altNames }],
});

const dir = path.resolve(__dirname, "../certs/livekit");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "key.pem"), pems.private);
fs.writeFileSync(path.join(dir, "cert.pem"), pems.cert);

console.log("LiveKit 自签证书已生成 -> certs/livekit/");
console.log("  SAN:", altNames.map((a) => a.ip || a.value).join(", "));
