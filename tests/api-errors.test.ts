import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api';

afterEach(() => vi.unstubAllGlobals());
describe('服务错误与登录状态', () => {
  it('服务器超限的 HTML 错误保留 503，不误报登录过期', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Worker exceeded resource limits</html>', { status: 503, headers: { 'Content-Type': 'text/html' } })));
    await expect(api('/library')).rejects.toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE' });
  });
  it('真实授权失败仍要求重新登录', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Sign in</html>', { status: 401, headers: { 'Content-Type': 'text/html' } })));
    await expect(api('/library')).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
  });
});
