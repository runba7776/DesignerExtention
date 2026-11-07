// Starts the local app unless it is already answering, then prints its address (with the
// start token) on one line. PowerPoint's add-in runs this with Node.js directly, so no
// PowerShell or script-policy change is involved; Start-DesignerExtension.ps1 runs it too.
// The add-in, the ribbon button, setup and a double-click can all start at once: a named
// pipe lets only one of them launch the server, and Windows frees it if that one dies.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(root, 'runtime');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** The recorded server, when its process is alive and it answers as this app. */
async function running() {
  try {
    const state = JSON.parse(readFileSync(path.join(runtime, 'server.json'), 'utf8'));
    process.kill(state.pid, 0);
    const response = await fetch(`http://127.0.0.1:${state.port}/api/health`, { signal: AbortSignal.timeout(2000) });
    if (response.ok && (await response.json()).app === 'Designer Extension') return state;
  } catch {
    return undefined;
  }
}
const listen = (server, address) =>
  new Promise(resolve => {
    server.once('error', () => resolve(false));
    server.listen(address, () => resolve(true));
  });
async function lock() {
  const name = createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 16);
  for (let attempt = 0; attempt < 360; attempt++) {
    const pipe = net.createServer();
    if (await listen(pipe, `\\\\.\\pipe\\DesignerExtensionStart-${name}`)) return pipe;
    await sleep(250);
  }
  throw new Error('Another start of Designer Extension did not finish.');
}
/** 4317 (or DESIGNER_PORT) when free, otherwise a free local port; never the task pane's 4318. */
async function choosePort() {
  const configured = Number(process.env.DESIGNER_PORT);
  const preferred = Number.isInteger(configured) && configured >= 1024 && configured <= 65535 ? configured : 4317;
  for (const candidate of [preferred, 0, 0, 0, 0, 0]) {
    const probe = net.createServer();
    if (!(await listen(probe, { port: candidate, host: '127.0.0.1' }))) continue;
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    if (port !== 4318) return port;
  }
  throw new Error('Could not find an available local port for Designer Extension.');
}

const pipe = await lock();
try {
  let state = await running();
  if (!state) {
    const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    await mkdir(runtime, { recursive: true });
    const port = await choosePort();
    const out = openSync(path.join(runtime, 'server.log'), 'w'),
      err = openSync(path.join(runtime, 'server-error.log'), 'w');
    // Detached, so the server keeps running after this launcher and PowerPoint's call end.
    const server = spawn(process.execPath, [tsx, path.join(root, 'server', 'index.ts')], {
      cwd: root,
      env: { ...process.env, DESIGNER_PORT: String(port) },
      detached: true,
      stdio: ['ignore', out, err],
      windowsHide: true,
    });
    closeSync(out);
    closeSync(err);
    let exited = false;
    server.once('exit', () => (exited = true));
    server.once('error', () => (exited = true));
    server.unref();
    // The first start after an update compiles TypeScript and can take a while.
    for (let attempt = 0; attempt < 240 && !exited && !(state = await running()); attempt++) await sleep(250);
  }
  if (!state) {
    console.error('Could not start Designer Extension. See runtime/server-error.log.');
    process.exitCode = 1;
  } else console.log(state.url);
} finally {
  pipe.close();
}
