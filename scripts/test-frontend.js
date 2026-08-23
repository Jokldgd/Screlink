/**
 * 前端静态校验：检查 public/app.js 中引用的所有元素 id 在 public/index.html 里都存在，
 * 并校验 script/link 资源文件确实存在（能抓拼写/漏元素这类真实 bug）。
 * 运行：npm run test:frontend
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(__dirname, "..");
const htmlPath = path.join(dir, "public", "index.html");
const jsPath = path.join(dir, "public", "app.js");
const cssPath = path.join(dir, "public", "style.css");

let failed = 0;
const check = (cond, msg) => {
  if (cond) console.log("  ok - " + msg);
  else { console.error("  FAIL - " + msg); failed++; }
};

const html = fs.readFileSync(htmlPath, "utf8");
const js = fs.readFileSync(jsPath, "utf8");

// 1) 提取 HTML 中所有 id
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

// 2) 提取 app.js 里所有 $("...") 与 getElementById("...") 引用
const refs = new Set();
for (const m of js.matchAll(/\$\("([^"]+)"\)/g)) refs.add(m[1]);
for (const m of js.matchAll(/getElementById\("([^"]+)"\)/g)) refs.add(m[1]);

// 3) 校验每个引用都存在
let missing = [];
for (const id of refs) if (!htmlIds.has(id)) missing.push(id);
check(missing.length === 0, `app.js 引用 ${refs.size} 个 id 全部存在于 HTML` + (missing.length ? `；缺失: ${missing.join(", ")}` : ""));

// 4) 关键 id 是否齐全（功能性列表，跟随当前 UI）
const essential = ["app-version","tab-join","tab-host","join-panel","host-panel","room-input","join-btn","share-btn","audio-checkbox","resolution-select","fps-select","custom-room","secure-hint","room-code","share-link","copy-link","lan-links","viewer-count","preview-video","stop-btn","remote-video","viewer-status","unmute-btn","player","mute-btn","volume-range","fit-btn","fs-btn","quality-select-viewer","viewer-room","leave-btn","toast"];
const missingEssential = essential.filter((id) => !htmlIds.has(id));
check(missingEssential.length === 0, "关键元素 id 齐全" + (missingEssential.length ? `；缺失: ${missingEssential.join(", ")}` : ""));

// 5) 资源文件存在
check(fs.existsSync(cssPath), "style.css 存在");
check(fs.existsSync(jsPath), "app.js 存在");
check(html.includes('href="style.css"'), "index.html 引用 style.css");
check(html.includes('src="app.js"'), "index.html 引用 app.js");

// 6) 基础 HTML 结构
check(html.includes('<video id="remote-video"'), "观看端有 remote-video");
check(html.includes('<video id="preview-video"'), "主机端有 preview-video");
check(html.includes('type="checkbox" id="audio-checkbox"'), "含系统声音开关");
check(html.includes('id="resolution-select"') && html.includes('id="fps-select"'), "含分辨率×帧率画质选择");
check(html.includes('id="fit-btn"'), "含画面模式切换(占满/适应)");

// 7) 运行时加载校验：用 vm + DOM 桩执行 app.js 顶层代码，
//    抓 TDZ（声明前引用）、语法外的初始化错误等 node --check 发现不了的加载期崩溃
function elStub() {
  return new Proxy(function () {}, {
    get(_t, p) {
      if (p === "classList") return { add() {}, remove() {}, toggle() {}, contains() { return false; } };
      if (p === "dataset") return {};
      if (p === "style") return {};
      return (..._a) => elStub();
    },
    set() { return true; },
    has() { return true; },
  });
}
const sandbox = {
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  document: elStub(),
  window: elStub(),
  navigator: {},
  location: { protocol: "http:", hostname: "localhost", host: "localhost:8787", origin: "http://localhost:8787", pathname: "/", hash: "", href: "http://localhost:8787/", search: "" },
  fetch: () => Promise.reject(new Error("no network")),
  WebSocket: class {}, RTCPeerConnection: class {}, MediaStream: class {},
  RTCRtpSender: { getCapabilities: () => ({ codecs: [] }) },
};
let loadErr = null;
try {
  vm.runInNewContext(js, sandbox, { filename: "app.js" });
  // 等微任务跑完 async IIFE（loadConfig/bindEvents）
  await new Promise((r) => setTimeout(r, 60));
} catch (err) {
  loadErr = err;
}
check(loadErr === null, "app.js 运行时加载无异常" + (loadErr ? `；错误：${loadErr.message}` : ""));

console.log(failed === 0 ? "\n  前端静态校验全部通过" : `\n  ${failed} 项校验失败`);
process.exit(failed === 0 ? 0 : 1);
