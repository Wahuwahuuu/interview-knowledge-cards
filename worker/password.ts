import { scrypt, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
// OWASP scrypt profile: 32 MiB, N=2^15, r=8, p=3. The stored format is versioned.
const derive = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => scrypt(password, Buffer.from(salt, 'hex'), 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
export async function hashPassword(password: string) {
  const salt = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(v => v.toString(16).padStart(2, '0')).join('');
  return `scrypt-v1$${salt}$${(await derive(password, salt)).toString('hex')}`;
}
export async function verifyPassword(password: string, stored: string | null) {
  const parts = (stored ?? '').split('$');
  const valid = parts[0] === 'scrypt-v1' && /^[a-f0-9]{32}$/.test(parts[1] ?? '') && /^[a-f0-9]{64}$/.test(parts[2] ?? '');
  const actual = await derive(password, valid ? parts[1] : '00000000000000000000000000000000');
  return timingSafeEqual(actual, Buffer.from(valid ? parts[2] : '0'.repeat(64), 'hex')) && valid;
}
