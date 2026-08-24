import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// dev 模式下将 /api 与 /ws 代理到信令服务器（默认 localhost:3000）
const SIGNAL_TARGET = process.env.SIGNAL_TARGET || 'http://localhost:3000';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: SIGNAL_TARGET, changeOrigin: true },
      '/ws': { target: SIGNAL_TARGET.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: {
    outDir: 'dist',
    assetsInlineLimit: 0,
  },
});
