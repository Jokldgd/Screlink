/**
 * 真实浏览器测 SFU WebSocket：连接 ECS 的 /livekit/rtc，抓握手结果 + 控制台。
 * 运行（需 full access 拉起浏览器）：node scripts/browser-livekit-test.js [baseURL]
 */
import { chromium } from "playwright";

const base = process.argv[2] || "https://121.199.163.15:8788";
const WS_PATH = "/livekit/rtc";

const main = async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  // 抓控制台与请求
  const logs = [];
  page.on("console", (m) => logs.push(`[console:${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
  page.on("requestfailed", (r) => logs.push(`[reqfailed] ${r.method()} ${r.url()} -> ${r.failure()?.errorText}`));
  page.on("response", (r) => { if (r.url().includes("/livekit")) logs.push(`[resp] ${r.status()} ${r.url().slice(0, 100)}`); });

  console.log("== 打开页面 ==", base);
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: 20000 });

  // 该源下取一个发布 token
  const tokenData = await page.evaluate(async () => {
    const r = await fetch("/api/livekit/token?room=ABC-123&role=publisher");
    return await r.json();
  }).catch((e) => ({ error: String(e) }));
  console.log("token:", JSON.stringify(tokenData).slice(0, 120));
  if (!tokenData.token) { console.log("未取到 token，无法测 WS"); await browser.close(); process.exit(1); }

  // 用页面里已加载的 livekit-client@1 复刻真实连接，抓确切错误
  const result = await page.evaluate(async ({ url, token }) => {
    const LK = window.LiveKitClient;
    if (!LK) return "NO LiveKitClient";
    const room = new LK.Room();
    try {
      await room.connect(url, token);
      return "CONNECTED (ok)";
    } catch (e) {
      return "CONNECT FAIL: " + (e?.message || String(e));
    }
  }, { url: tokenData.url, token: tokenData.token });

  console.log("\n== WebSocket /livekit/rtc 结果 ==");
  console.log(result);
  console.log("\n== 浏览器日志 ==");
  for (const l of logs) console.log(l);

  await browser.close();
};

main().catch((e) => { console.error("TEST ERROR:", e.message); process.exit(1); });
