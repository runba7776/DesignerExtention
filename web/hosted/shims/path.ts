// POSIX path helpers for the browser build (aliased as node:path). The virtual
// file system is rooted at "/" and never touches real files.
const toSlash = (value: string) => value.replace(/\\/g, '/');
function normalizeParts(parts: string[]) {
  const out: string[] = [];
  for (const part of parts) { if (!part || part === '.') continue; if (part === '..') out.pop(); else out.push(part); }
  return out;
}
export function resolve(...segments: string[]) {
  let joined = '';
  for (let i = segments.length - 1; i >= 0 && !joined.startsWith('/'); i--) { const segment = toSlash(segments[i] ?? ''); if (segment) joined = segment + (joined ? '/' + joined : ''); }
  return '/' + normalizeParts(joined.split('/')).join('/');
}
export function join(...segments: string[]) {
  const joined = toSlash(segments.filter(Boolean).join('/'));
  const result = normalizeParts(joined.split('/')).join('/');
  return joined.startsWith('/') ? '/' + result : result || '.';
}
export function dirname(value: string) { const parts = toSlash(value).split('/'); parts.pop(); const result = parts.join('/'); return result || (value.startsWith('/') ? '/' : '.'); }
export function basename(value: string, extension?: string) { const base = toSlash(value).split('/').pop() ?? ''; return extension && base.endsWith(extension) ? base.slice(0, -extension.length) : base; }
export function extname(value: string) { const base = basename(value), index = base.lastIndexOf('.'); return index > 0 ? base.slice(index) : ''; }
export const sep = '/';
export default { resolve, join, dirname, basename, extname, sep };
