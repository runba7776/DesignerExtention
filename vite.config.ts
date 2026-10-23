import { defineConfig } from 'vite';
import path from 'node:path';
export default defineConfig({
  root: path.resolve('web'),
  base: '/',
  publicDir: path.resolve('web/public'),
  define: { __HOSTED__: 'false' },
  build: {
    outDir: path.resolve('dist/web'),
    emptyOutDir: true,
    rollupOptions: { input: { main: path.resolve('web/index.html'), taskpane: path.resolve('web/taskpane.html') } },
  },
  server: { host: '127.0.0.1', port: 5173, proxy: { '/api': 'http://127.0.0.1:4317' } },
});
