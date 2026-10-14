import type { Library } from '../shared/model';

export class ApiError extends Error {
  constructor(message: string, public status: number, public code = '', public details: { path: string; message: string }[] = []) { super(message); }
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');
  const response = await fetch('/api/v1' + path, { ...init, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'manual' });
  if (response.redirected || !response.headers.get('content-type')?.includes('application/json')) throw new ApiError('登录已过期，请重新登录', 401, 'UNAUTHENTICATED');
  const value = await response.json() as { error?: { message?: string; code?: string; details?: { path: string; message: string }[] } };
  if (!response.ok) throw new ApiError(value.error?.message ?? '请求未完成', response.status, value.error?.code, value.error?.details);
  return value as T;
}
export const loadLibrary = () => api<Library>('/library');
export const newId = (prefix: string) => prefix + '-' + crypto.randomUUID();
export function downloadFile(name: string, text: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name;
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
