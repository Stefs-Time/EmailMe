// Fetch wrapper: JSON, CSRF header, consistent error objects.
let csrfToken = '';
export const setCsrf = (t) => { csrfToken = t || ''; };

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details || [];
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export async function api(method, path, body, { form } = {}) {
  const headers = { Accept: 'application/json' };
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
  let res;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: payload, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your connection.');
  }
  let json = {};
  try { json = await res.json(); } catch { /* empty body */ }
  if (!res.ok || json.success === false) {
    const e = json.error || {};
    if (res.status === 401 && path !== '/auth/login') onUnauthorized();
    throw new ApiError(res.status, e.code || 'ERROR', e.message || `Request failed (${res.status})`, e.details);
  }
  return json;
}

export const get = (p) => api('GET', p).then((r) => r);
export const post = (p, b) => api('POST', p, b);
export const put = (p, b) => api('PUT', p, b);
export const patch = (p, b) => api('PATCH', p, b);
export const del = (p) => api('DELETE', p);

export function qs(params) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') u.set(k, v);
  }
  const s = u.toString();
  return s ? `?${s}` : '';
}

/** Triggers a file download of a GET endpoint (cookies carry the session). */
export function download(path) {
  const a = document.createElement('a');
  a.href = `/api${path}`;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
