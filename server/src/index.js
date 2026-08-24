import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { config } from './config.js';
import { createStore } from './store/index.js';
import { setupWebSocket } from './signal/wsServer.js';
import { registerHttpRoutes } from './routes/http.js';

const app = Fastify({
  logger: {
    level: 'info',
    transport: undefined,
  },
  bodyLimit: 1024 * 1024,
});

const store = createStore();
const ctx = { store };

await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

setupWebSocket(app, ctx);
registerHttpRoutes(app, ctx);

try {
  await app.listen({ port: config.port, host: config.host });
  console.log('==========================================');
  console.log(`  RoomVoice 信令服务器已启动`);
  console.log(`  HTTP : http://localhost:${config.port}/api/health`);
  console.log(`  WS   : ws://localhost:${config.port}/ws`);
  console.log(`  存储模式 : ${config.storeMode}`);
  console.log(`  LiveKit  : ${config.livekit.enabled ? '已配置 ' + config.livekit.url : '未配置（演示模式：房间流程可用，语音/共享不可用）'}`);
  console.log('==========================================');
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// 优雅退出
const shutdown = async (signal) => {
  console.log(`\n收到 ${signal}，正在退出...`);
  await store.close();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
