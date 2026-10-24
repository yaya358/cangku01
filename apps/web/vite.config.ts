import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

/**
 * 后端地址：默认本机 8787，可用 TAVERN_BACKEND_URL 覆盖。
 *
 * 前端只请求相对路径 /api/*，由 Vite 代理转发到后端 —— 这样开发期没有跨域，
 * 生产期同源部署也不需要改一行代码。
 */
const backendUrl = process.env.TAVERN_BACKEND_URL ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [vue()],

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  server: {
    host: '127.0.0.1',
    port: 5173,
    // 端口被占用时直接失败，而不是悄悄换一个端口导致「打开的是旧页面」
    strictPort: true,
    proxy: {
      '/api': {
        target: backendUrl,
        changeOrigin: false,
      },
    },
  },

  build: {
    outDir: 'dist',
    sourcemap: true,
    // 前端产物由后端托管时，路径写成绝对路径更省心
    assetsDir: 'assets',
  },
});
