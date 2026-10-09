/** Sends an API request to the local app, or, in the no-install build, to the
 * engine running in this browser tab. */
export async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  if (__HOSTED__) { const { hostedFetch } = await import('./hosted/backend'); return hostedFetch(path, options); }
  return fetch(`/api${path}`, { credentials: 'same-origin', ...options });
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const response = await apiFetch(path, {...options, headers});
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = typeof payload.error === 'string' ? payload.error : payload.error?.message ?? payload.message;
    throw new Error(error || `処理に失敗しました (${response.status})。もう一度お試しください。`);
  }
  return payload as T;
}
