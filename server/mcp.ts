/** Local stdio connector for subscription-chat apps. Never writes auth data to stdout. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatConnector, handleConnector } from './chat-connector.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = process.env.DESIGNER_CONNECTOR_DATA_DIR ?? path.join(root, 'runtime');
const client = new ChatConnector(directory);
let pending = Buffer.alloc(0),
  queue = Promise.resolve();
const send = (value: unknown) => {
  if (value !== undefined) process.stdout.write(JSON.stringify(value) + '\n');
};
process.stdin.on('data', (chunk: Buffer) => {
  pending = Buffer.concat([pending, chunk]);
  if (pending.length > 1_000_000) {
    pending = Buffer.alloc(0);
    send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Message too large' } });
    return;
  }
  while (true) {
    const boundary = pending.indexOf(10);
    if (boundary < 0) break;
    const line = pending.subarray(0, boundary).toString('utf8').trim();
    pending = pending.subarray(boundary + 1);
    if (!line) continue;
    queue = queue
      .then(async () => {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
          return;
        }
        send(await handleConnector(client, message));
      })
      .catch(() => send({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Local operation failed' } }));
  }
});
process.stdin.on(
  'end',
  () =>
    void queue.then(() => {
      process.exitCode = 0;
    }),
);
