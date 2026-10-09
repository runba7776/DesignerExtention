// Serves dist/hosted the way a static host (GitHub Pages) would, for checking
// the no-install build locally: https://localhost:4320/ (uses the task pane's
// localhost certificate when present, otherwise plain http://localhost:4320/).
import { createServer as createHttps } from 'node:https';
import { createServer as createHttp } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'dist', 'hosted');
const port = Number(process.env.HOSTED_PORT || 4320);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.xml': 'application/xml', '.bcmap': 'application/octet-stream', '.ico': 'image/x-icon' };

async function handle(request, response) {
  try {
    const url = new URL(request.url, 'https://localhost');
    let file = path.normalize(path.join(site, decodeURIComponent(url.pathname)));
    if (!file.startsWith(site)) { response.writeHead(403).end(); return; }
    if ((await stat(file).catch(() => undefined))?.isDirectory()) file = path.join(file, 'index.html');
    const body = await readFile(file);
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(body);
  } catch { response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); }
}

const tls = path.join(root, 'runtime', 'office-taskpane');
const certificate = await Promise.all([readFile(path.join(tls, 'localhost.pfx')), readFile(path.join(tls, 'passphrase.txt'), 'utf8')]).catch(() => undefined);
const listeners = certificate ? ['127.0.0.1', '::1'].map(host => createHttps({ pfx: certificate[0], passphrase: certificate[1].trim() }, handle).listen(port, host)) : [createHttp(handle).listen(port, '127.0.0.1')];
for (const listener of listeners) listener.on('error', error => { if (error.code !== 'EADDRNOTAVAIL') console.error(error.message); });
console.log(`No-install build: ${certificate ? 'https' : 'http'}://localhost:${port}/  (task pane: /taskpane.html?taskpane=1)`);
