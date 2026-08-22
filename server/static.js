import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * 极简静态文件服务：只读、防目录穿越、默认 index.html。
 */
export function createStaticHandler(publicDir = config.publicDir) {
  return (req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    } catch {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("400 Bad Request");
      return;
    }
    if (urlPath === "/") urlPath = "/index.html";

    const filePath = path.normalize(path.join(publicDir, urlPath));
    if (!filePath.startsWith(publicDir + path.sep) && filePath !== publicDir) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("403 Forbidden");
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("404 Not Found");
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      // 全部资源 no-cache：前端零构建、体积小，避免浏览器缓存旧页面/旧 JS 造成排查困扰
      res.writeHead(200, {
        "content-type": MIME[ext] || "application/octet-stream",
        "cache-control": "no-cache",
      });
      res.end(data);
    });
  };
}
