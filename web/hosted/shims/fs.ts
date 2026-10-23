import { dirname, resolve } from './path';

/** A small in-memory file system persisted to this browser's IndexedDB
 * (aliased as node:fs/promises in the browser build). History, favorites,
 * projects and settings stay on this PC and this browser profile only. */
type Entry = { data: string | Uint8Array; mtime: number };
const files = new Map<string, Entry>();
const directories = new Set<string>(['/']);
const DB_NAME = 'designer-extension',
  STORE = 'files';
let database: IDBDatabase | undefined;
let writes: Promise<unknown> = Promise.resolve();

function request<T>(value: IDBRequest<T>) {
  return new Promise<T>((done, fail) => {
    value.onsuccess = () => done(value.result);
    value.onerror = () => fail(value.error);
  });
}
/** Loads the stored files once before the in-browser app starts. Without
 * IndexedDB (private mode), work continues in memory for this page only. */
export async function initFileSystem() {
  if (database || typeof indexedDB === 'undefined') return;
  try {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE);
    };
    database = await request(open);
    const store = database.transaction(STORE, 'readonly').objectStore(STORE);
    const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
    keys.forEach((key, i) => {
      const name = String(key),
        value = values[i] as Entry & { directory?: boolean };
      if (value?.directory) addDirectory(name);
      else if (value) {
        files.set(name, { data: value.data, mtime: value.mtime });
        addDirectory(dirname(name));
      }
    });
  } catch {
    database = undefined;
  }
}
export function storageAvailable() {
  return !!database;
}
function persist(name: string, value: (Entry & { directory?: boolean }) | undefined) {
  const db = database;
  if (!db) return;
  writes = writes.then(
    () =>
      new Promise<void>(done => {
        const tx = db.transaction(STORE, 'readwrite');
        if (value) tx.objectStore(STORE).put(value, name);
        else tx.objectStore(STORE).delete(name);
        tx.oncomplete = () => done();
        tx.onerror = () => done();
        tx.onabort = () => done();
      }),
  );
}
export function flushFileSystem() {
  return writes;
}

function failure(code: string, name: string) {
  return Object.assign(new Error(`${code}: ${name}`), { code });
}
const full = (name: string) => resolve(String(name));
function addDirectory(name: string) {
  let current = full(name);
  const created: string[] = [];
  while (!directories.has(current)) {
    directories.add(current);
    created.push(current);
    current = dirname(current);
  }
  return created;
}
const encoder = new TextEncoder(),
  decoder = new TextDecoder();
const asText = (data: string | Uint8Array) => (typeof data === 'string' ? data : decoder.decode(data));
const size = (data: string | Uint8Array) => (typeof data === 'string' ? encoder.encode(data).length : data.length);
function stats(kind: 'file' | 'directory', entry?: Entry) {
  return {
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'directory',
    isSymbolicLink: () => false,
    size: entry ? size(entry.data) : 0,
    mtimeMs: entry?.mtime ?? 0,
    mtime: new Date(entry?.mtime ?? 0),
  };
}
function encodingOf(options: unknown) {
  return typeof options === 'string' ? options : (options as { encoding?: string } | undefined)?.encoding;
}
function toData(data: unknown): string | Uint8Array {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return new Uint8Array(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return String(data);
}

export async function mkdir(name: string, options?: { recursive?: boolean }) {
  const path = full(name);
  if (files.has(path)) throw failure('EEXIST', path);
  if (!options?.recursive && !directories.has(dirname(path))) throw failure('ENOENT', path);
  for (const directory of addDirectory(path)) persist(directory, { data: '', mtime: Date.now(), directory: true });
}
export async function readFile(name: string, options?: unknown) {
  const entry = files.get(full(name));
  if (!entry) throw failure('ENOENT', full(name));
  return encodingOf(options)
    ? asText(entry.data)
    : typeof entry.data === 'string'
      ? encoder.encode(entry.data)
      : new Uint8Array(entry.data);
}
export async function writeFile(name: string, data: unknown, options?: { flag?: string } | string) {
  const path = full(name);
  if (directories.has(path)) throw failure('EISDIR', path);
  if (!directories.has(dirname(path))) throw failure('ENOENT', path);
  if (typeof options === 'object' && options?.flag === 'wx' && files.has(path)) throw failure('EEXIST', path);
  const entry = { data: toData(data), mtime: Date.now() };
  files.set(path, entry);
  persist(path, entry);
}
export async function appendFile(name: string, data: unknown) {
  const path = full(name),
    previous = files.get(path);
  if (!previous && !directories.has(dirname(path))) throw failure('ENOENT', path);
  const entry = { data: (previous ? asText(previous.data) : '') + asText(toData(data)), mtime: Date.now() };
  files.set(path, entry);
  persist(path, entry);
}
export async function readdir(name: string) {
  const path = full(name);
  if (!directories.has(path)) throw failure('ENOENT', path);
  const prefix = path === '/' ? '/' : path + '/',
    names = new Set<string>();
  for (const key of [...files.keys(), ...directories])
    if (key !== path && key.startsWith(prefix)) {
      const rest = key.slice(prefix.length);
      if (rest && !rest.includes('/')) names.add(rest);
    }
  return [...names].sort();
}
export async function lstat(name: string) {
  const path = full(name);
  if (files.has(path)) return stats('file', files.get(path));
  if (directories.has(path)) return stats('directory');
  throw failure('ENOENT', path);
}
export const stat = lstat;
export async function access(name: string) {
  await lstat(name);
}
export async function rename(from: string, to: string) {
  const source = full(from),
    target = full(to),
    entry = files.get(source);
  if (!entry) throw failure('ENOENT', source);
  if (!directories.has(dirname(target))) throw failure('ENOENT', target);
  files.delete(source);
  files.set(target, entry);
  persist(source, undefined);
  persist(target, entry);
}
export async function unlink(name: string) {
  const path = full(name);
  if (!files.delete(path)) throw failure('ENOENT', path);
  persist(path, undefined);
}
export async function rmdir(name: string) {
  const path = full(name);
  if (!directories.has(path)) throw failure('ENOENT', path);
  if ((await readdir(path)).length) throw failure('ENOTEMPTY', path);
  directories.delete(path);
  persist(path, undefined);
}
export async function rm(name: string, options?: { recursive?: boolean; force?: boolean }) {
  const path = full(name);
  if (files.has(path)) return unlink(path);
  if (!directories.has(path)) {
    if (options?.force) return;
    throw failure('ENOENT', path);
  }
  if (!options?.recursive) return rmdir(path);
  for (const key of [...files.keys()])
    if (key.startsWith(path + '/')) {
      files.delete(key);
      persist(key, undefined);
    }
  for (const key of [...directories])
    if (key === path || key.startsWith(path + '/')) {
      directories.delete(key);
      persist(key, undefined);
    }
}
export default { mkdir, readFile, writeFile, appendFile, readdir, lstat, stat, access, rename, unlink, rmdir, rm };
