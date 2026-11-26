import { defineConfig, type Plugin } from 'vite';
import path from 'node:path';
import { cp } from 'node:fs/promises';

// Two builds of the same screen. `vite build` makes the local app's screen (dist/web), which talks to the local
// server. `vite build --mode hosted` makes the no-install build (dist/hosted): a static site (GitHub Pages etc.)
// that runs the engine (core/) in the browser. There, the engine keeps its files in IndexedDB (core/storage.ts), and
// the few Node built-ins it still names (path, crypto, module) are replaced with browser shims; nothing talks to a
// local server.
const root = path.resolve('web');
const publicDir = path.resolve('web/public');
const input = { main: path.resolve('web/index.html'), taskpane: path.resolve('web/taskpane.html') };
const shim = (name: string) => path.resolve('web/hosted/shims', name);
/** Files the page reads or links to that are not part of the app bundle: the PDF character maps and the portfolio. */
function copiedFiles(): Plugin {
  return {
    name: 'copied-files',
    apply: 'build',
    async closeBundle() {
      await cp(path.resolve('node_modules/pdfjs-dist/cmaps'), path.resolve('dist/hosted/pdfjs/cmaps'), {
        recursive: true,
      });
      await cp(path.resolve('portfolio'), path.resolve('dist/hosted/portfolio'), { recursive: true });
    },
  };
}
export default defineConfig(({ mode }) =>
  mode === 'hosted'
    ? {
        root,
        base: './',
        publicDir,
        define: { __HOSTED__: 'true' },
        resolve: {
          alias: [
            { find: /^node:path$/, replacement: shim('path.ts') },
            { find: /^node:crypto$/, replacement: shim('crypto.ts') },
            { find: /^node:module$/, replacement: shim('module.ts') },
          ],
        },
        build: {
          outDir: path.resolve('dist/hosted'),
          emptyOutDir: true,
          target: 'es2022',
          chunkSizeWarningLimit: 4000,
          rollupOptions: { input },
        },
        optimizeDeps: { exclude: ['pdfjs-dist'] },
        plugins: [copiedFiles()],
      }
    : {
        root,
        base: '/',
        publicDir,
        define: { __HOSTED__: 'false' },
        build: { outDir: path.resolve('dist/web'), emptyOutDir: true, rollupOptions: { input } },
        server: { host: '127.0.0.1', port: 5173, proxy: { '/api': 'http://127.0.0.1:4317' } },
      },
);
