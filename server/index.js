import { createApp, lanIPv4s } from "./app.js";
import { config } from "./config.js";

const app = createApp();

const banner = (scheme, port) => {
  const proto = scheme === "https" ? "https" : "http";
  const lines = [`  ${scheme.toUpperCase()}: ${proto}://localhost:${port}`];
  for (const ip of lanIPv4s()) {
    lines.push(`           ${proto}://${ip}:${port}`);
  }
  return lines.join("\n");
};

app.httpServer.listen(config.port, config.host, () => {
  console.log(`Screlink v${config.version}`);
  console.log(banner("http", app.httpServer.address().port));
  console.log("");
});

app.httpsServer.listen(config.httpsPort, config.host, () => {
  console.log("  TLS     : self-signed cert (browsers warn once; accept to continue)");
  console.log(banner("https", app.httpsServer.address().port));
});

const shutdown = () => {
  app.httpServer.close();
  app.httpsServer.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("");
console.log("Usage   : viewers open the HTTP address and enter the room code.");
console.log("          The host (sharing) should open the HTTPS address (secure context required).");
