import { createApp, lanIPv4s } from "./app.js";
import { config } from "./config.js";

const useHttps = process.argv.includes("--https");
const app = createApp({ https: useHttps });

const banner = (scheme, port) => {
  const lines = [`  ${scheme.toUpperCase()}  : http${scheme === "https" ? "s" : ""}://localhost:${port}`];
  for (const ip of lanIPv4s()) {
    lines.push(`             http${scheme === "https" ? "s" : ""}://${ip}:${port}`);
  }
  return lines.join("\n");
};

app.httpServer.listen(config.port, config.host, () => {
  console.log(`Screlink v${config.version}`);
  console.log(banner("http", app.httpServer.address().port));
});

if (app.httpsServer) {
  app.httpsServer.listen(config.httpsPort, config.host, () => {
    console.log("  TLS cert : self-signed (browsers will warn; accept it once)");
    console.log(banner("https", app.httpsServer.address().port));
  });
}

const shutdown = () => {
  app.httpServer.close();
  app.httpsServer?.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("Usage     : open the address in a browser -> Share screen (host) or Join (viewer).");
console.log("Note      : screen capture needs a secure context: localhost is fine;");
console.log("            for LAN/internet sharing run: npm run start:https");
