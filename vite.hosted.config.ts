import { defineConfig, type Plugin } from 'vite';
import path from 'node:path';
import { cp } from 'node:fs/promises';

// No-install build: a static site (GitHub Pages etc.) that runs the engine in
// the browser. Node built-ins used by the shared server modules are replaced
// with browser shims; nothing here talks to a local server.
const shim = (name: string) => path.resolve('web/hosted/shims', name);
function pdfCharacterMaps(): Plugin {
  return { name: 'pdfjs-character-maps', apply: 'build', async closeBundle() { await cp(path.resolve('node_modules/pdfjs-dist/cmaps'), path.resolve('dist/hosted/pdfjs/cmaps'), { recursive: true }); } };
}
export default defineConfig({
  root: path.resolve('web'), base: './', publicDir: path.resolve('web/public'),
  define: { __HOSTED__: 'true' },
  resolve: { alias: [
    { find: /^node:fs\/promises$/, replacement: shim('fs.ts') },
    { find: /^node:path$/, replacement: shim('path.ts') },
    { find: /^node:crypto$/, replacement: shim('crypto.ts') },
    { find: /^node:module$/, replacement: shim('module.ts') },
  ] },
  build: { outDir: path.resolve('dist/hosted'), emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 4000, rollupOptions: { input: { main: path.resolve('web/index.html'), taskpane: path.resolve('web/taskpane.html') } } },
  optimizeDeps: { exclude: ['pdfjs-dist'] },
  plugins: [pdfCharacterMaps()],
});
