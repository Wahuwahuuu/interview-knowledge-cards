import type { Library } from '../shared/model';
import { editableOffline, replicaApi } from './local-replica';
import { markdownExport } from '../shared/model';

export class ApiError extends Error {
  constructor(message: string, public status: number, public code = '', public details: { path: string; message: string }[] = []) { super(message); }
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (editableOffline()) {
    try { return await replicaApi(path, init) as T; }
    catch (error) { if (error && typeof error === 'object' && 'status' in error && 'code' in error) throw new ApiError(error instanceof Error ? error.message : '本机操作失败', Number(error.status), String(error.code)); throw error; }
  }
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');
  const response = await fetch('/api/v1' + path, { ...init, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'manual' });
  if (response.redirected || response.status === 0 || (response.status >= 300 && response.status < 400)) throw new ApiError('登录已过期，请重新登录', 401, 'UNAUTHENTICATED');
  if (!response.headers.get('content-type')?.includes('application/json')) {
    if (response.status === 401 || response.status === 403) throw new ApiError('登录已过期，请重新登录', response.status, 'UNAUTHENTICATED');
    throw new ApiError('服务暂时不可用，请稍后重试', response.ok ? 502 : response.status, 'SERVICE_UNAVAILABLE');
  }
  const value = await response.json() as { error?: { message?: string; code?: string; details?: { path: string; message: string }[] } };
  if (!response.ok) throw new ApiError(value.error?.message ?? '请求未完成', response.status, value.error?.code, value.error?.details);
  return value as T;
}
export const loadLibrary = () => api<Library>('/library');
export async function exportMarkdownText() {
  if (editableOffline()) return markdownExport(await api<Library>('/export'));
  const response = await fetch('/api/v1/export?format=markdown', { credentials: 'same-origin', redirect: 'error' });
  if (!response.ok || !response.headers.get('content-type')?.includes('text/markdown')) throw new Error('导出失败，请检查登录状态');
  return response.text();
}
export const newId = (prefix: string) => prefix + '-' + crypto.randomUUID();
export function downloadFile(name: string, text: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name;
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
