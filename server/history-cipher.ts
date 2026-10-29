import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { HistoryCipher } from './history.js';
import { dpapi } from './subscription-storage.js';

const MAGIC = Buffer.from('DEH1');
const FAILURE =
  'Windowsで履歴の暗号鍵を扱えませんでした。履歴は平文で保存していません。Setup-DesignerExtension.cmdをもう一度実行してください。';

/** History (the deck, the conversation and the text taken from the documents) is encrypted with AES-256-GCM.
 * The key is kept wrapped by Windows DPAPI in runtime/history.key, so only this Windows user on this PC can
 * read it: a copy of the folder (a backup, a synced or zipped project, another account) cannot. */
export function protectedHistoryCipher(dataDir: string): HistoryCipher {
  const file = path.join(dataDir, 'history.key');
  let key: Promise<Buffer> | undefined;
  const load = () =>
    (key ??= unwrap(file).catch(error => {
      key = undefined;
      throw error;
    }));
  return {
    async seal(plain) {
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', await load(), iv);
      const body = Buffer.concat([cipher.update(plain), cipher.final()]);
      return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
    },
    async open(stored) {
      if (stored.length < 32 || !stored.subarray(0, 4).equals(MAGIC)) throw new Error('not a sealed history file');
      const decipher = createDecipheriv('aes-256-gcm', await load(), stored.subarray(4, 16));
      decipher.setAuthTag(stored.subarray(16, 32));
      return Buffer.concat([decipher.update(stored.subarray(32)), decipher.final()]);
    },
  };
}
async function unwrap(file: string) {
  try {
    return await dpapi('decrypt', await readFile(file), FAILURE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const key = randomBytes(32);
  await writeFile(file, await dpapi('encrypt', key, FAILURE), { mode: 0o600, flag: 'wx' });
  return key;
}
