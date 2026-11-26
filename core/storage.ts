/** Where the engine keeps its files (settings, projects, history, favourite designs, logs). The engine never imports
 * a file system itself: the installed app's server uses Node's (the default), and the no-install build gives one
 * kept in the browser's IndexedDB (web/hosted/browser-storage.ts) with useStorage before the engine starts. */
export interface FileInfo {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  size: number;
  mtimeMs: number;
}
export interface Storage {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  /** The bytes (a Buffer; the browser build installs Buffer too). */
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: string | Uint8Array, options?: { mode?: number; flag?: string }): Promise<void>;
  appendFile(path: string, data: string, options?: { mode?: number } | 'utf8'): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<unknown>;
  readdir(path: string): Promise<string[]>;
  lstat(path: string): Promise<FileInfo>;
  access(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
}

let chosen: Storage | undefined;
let node: Promise<Storage> | undefined;
/** Sets the storage for this process or page; call before any store loads. */
export function useStorage(value: Storage) {
  chosen = value;
}
async function current(): Promise<Storage> {
  if (chosen) return chosen;
  // Node's file system, loaded only when no other storage was given (never in the browser build).
  return (node ??= import(/* @vite-ignore */ 'node:fs/promises').then(fs => fs as unknown as Storage));
}

/** The storage in use, with the same calls as node:fs/promises. */
export const storage: Storage = {
  readFile: (async (path: string, encoding?: 'utf8') =>
    encoding ? (await current()).readFile(path, encoding) : (await current()).readFile(path)) as Storage['readFile'],
  writeFile: async (path, data, options) => (await current()).writeFile(path, data, options),
  appendFile: async (path, data, options) => (await current()).appendFile(path, data, options),
  mkdir: async (path, options) => (await current()).mkdir(path, options),
  readdir: async path => (await current()).readdir(path),
  lstat: async path => (await current()).lstat(path),
  access: async path => (await current()).access(path),
  rename: async (from, to) => (await current()).rename(from, to),
  unlink: async path => (await current()).unlink(path),
  rmdir: async path => (await current()).rmdir(path),
};
