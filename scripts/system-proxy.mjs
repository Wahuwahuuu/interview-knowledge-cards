import { spawnSync } from 'node:child_process';
import { ProxyAgent, setGlobalDispatcher } from 'undici';

// Use the user's existing Windows proxy without changing system settings.
export function useSystemProxy(site) {
  if (process.platform !== 'win32') return;
  const script = '$site=[Uri]$env:CARDS_PROXY_PROBE_URL; $proxy=[Net.WebRequest]::GetSystemWebProxy().GetProxy($site); if ($proxy.AbsoluteUri -ne $site.AbsoluteUri) { [Console]::Out.Write($proxy.AbsoluteUri) }';
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    env: { ...process.env, CARDS_PROXY_PROBE_URL: String(site) }, encoding: 'utf8', windowsHide: true,
  });
  if (result.status !== 0) throw new Error('无法读取本机网络代理设置。');
  const address = result.stdout.trim();
  if (address) {
    const proxy = new URL(address);
    if (!['http:', 'https:'].includes(proxy.protocol) || proxy.username || proxy.password) throw new Error('当前代理类型需要在运行环境中另外配置。');
    setGlobalDispatcher(new ProxyAgent(proxy));
  }
}
