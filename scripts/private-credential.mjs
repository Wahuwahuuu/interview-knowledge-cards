import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const credentialPath = fileURLToPath(new URL('../.private/agent-credential.json', import.meta.url));
export function protect(text, decrypt = false) {
  if (process.platform !== 'win32') throw new Error('本机凭证使用 Windows 用户加密；其他机器请通过进程环境提供凭证。');
  const script = `Add-Type -AssemblyName System.Security; $credentialInput=[Console]::In.ReadToEnd(); ` + (decrypt
    ? `[Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($credentialInput),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))`
    : `[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($credentialInput),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))`);
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    input: text, encoding: 'utf8', windowsHide: true,
  });
  if (result.status !== 0) throw new Error('本机服务凭证加密或读取失败。');
  return result.stdout.trim();
}
export async function saveAgentCredential(value) {
  await mkdir(dirname(credentialPath), { recursive: true });
  await writeFile(credentialPath, JSON.stringify({ schema_version: 1, site_url: value.site_url, encrypted: protect(JSON.stringify(value)) }, null, 2));
}
export async function readAgentCredential() {
  let stored;
  try { stored = JSON.parse(await readFile(credentialPath, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('本机服务凭证文件无法读取。'); }
  return JSON.parse(protect(stored.encrypted, true));
}
