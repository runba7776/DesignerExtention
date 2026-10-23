// node:crypto subset for the browser build. Requires a secure context (HTTPS),
// which GitHub Pages and Office task panes provide.
export function randomUUID() {
  return globalThis.crypto.randomUUID();
}
export function randomBytes(length: number) {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}
export function timingSafeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
export default { randomUUID, randomBytes, timingSafeEqual };
