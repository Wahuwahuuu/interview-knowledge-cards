import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../src/api';

afterEach(() => vi.unstubAllGlobals());

it('Access 跨域登录重定向按登录失效处理，不误认为断网', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
    // Browsers following the login redirect can fail CORS with a network-like error.
    if (options.redirect !== 'manual') throw new TypeError('Failed to fetch');
    return new Response(null, { status: 302, headers: { location: 'https://example.cloudflareaccess.com/cdn-cgi/access/login' } });
  }));
  await expect(api('/library')).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
});
