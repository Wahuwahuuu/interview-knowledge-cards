import 'reflect-metadata';
import * as x509 from '@peculiar/x509';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces, hostname } from 'node:os';
import { join } from 'node:path';

export function lanAddresses() {
  const interfaces = Object.entries(networkInterfaces()).filter(([name]) => !/vEthernet|VMnet|VMware|VirtualBox|vbox|WSL|tun|Meta/i.test(name));
  // Campus/company Wi-Fi can assign a public IPv4 address. Do not assume all LANs use 192.168.*.
  return [...new Set(interfaces.flatMap(([, rows]) => rows ?? []).filter(row => row.family === 'IPv4' && !row.internal && !/^(169\.254\.|198\.(18|19)\.|0\.)/.test(row.address)).map(row => row.address))];
}
const algorithm = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
const pemKey = async (key: CryptoKey) => `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', key)).toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
const parseKey = (pem: string) => crypto.subtle.importKey('pkcs8', Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ''), 'base64'), algorithm, true, ['sign']);
export async function certificates(directory: string) {
  mkdirSync(directory, { recursive: true });
  const caKeyFile = join(directory, 'root-key.pem'), caFile = join(directory, 'root.pem');
  if (!existsSync(caKeyFile) || !existsSync(caFile)) {
    const keys = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
    const root = await x509.X509CertificateGenerator.createSelfSigned({ serialNumber: '01' + randomBytes(15).toString('hex'), name: 'CN=Interview Cards Local ' + randomBytes(4).toString('hex'), notBefore: new Date(Date.now() - 86400000), notAfter: new Date(Date.now() + 10 * 365 * 86400000), signingAlgorithm: algorithm, keys, extensions: [new x509.BasicConstraintsExtension(true, 0, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true), await x509.SubjectKeyIdentifierExtension.create(keys.publicKey)] });
    writeFileSync(caKeyFile, await pemKey(keys.privateKey), { mode: 0o600 }); writeFileSync(caFile, root.toString('pem'));
  }
  const root = new x509.X509Certificate(readFileSync(caFile, 'utf8')), addresses = lanAddresses();
  const names = [hostname().toLowerCase() + '.local', hostname().toLowerCase(), 'localhost'];
  const descriptor = JSON.stringify({ addresses: [...addresses].sort(), names });
  const certFile = join(directory, 'server.pem'), keyFile = join(directory, 'server-key.pem'), stateFile = join(directory, 'server-state.json');
  const valid = existsSync(certFile) && existsSync(keyFile) && existsSync(stateFile) && readFileSync(stateFile, 'utf8') === descriptor && new x509.X509Certificate(readFileSync(certFile, 'utf8')).notAfter.getTime() > Date.now() + 30 * 86400000;
  if (!valid) {
    const keys = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
    const cert = await x509.X509CertificateGenerator.create({ serialNumber: '01' + randomBytes(15).toString('hex'), subject: 'CN=' + names[0], issuer: root.subject, notBefore: new Date(Date.now() - 86400000), notAfter: new Date(Date.now() + 365 * 86400000), signingAlgorithm: algorithm, publicKey: keys.publicKey, signingKey: await parseKey(readFileSync(caKeyFile, 'utf8')), extensions: [new x509.BasicConstraintsExtension(false, undefined, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true), new x509.ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1']), new x509.SubjectAlternativeNameExtension([...names.map(value => ({ type: 'dns' as const, value })), ...['127.0.0.1', ...addresses].map(value => ({ type: 'ip' as const, value }))])] });
    writeFileSync(certFile, cert.toString('pem')); writeFileSync(keyFile, await pemKey(keys.privateKey), { mode: 0o600 }); writeFileSync(stateFile, descriptor);
  }
  const der = Buffer.from(root.rawData), fingerprint = createHash('sha256').update(der).digest('hex').toUpperCase().match(/.{2}/g)!.join(':');
  return { key: readFileSync(keyFile), cert: readFileSync(certFile), root: der, addresses, names, fingerprint, rootName: root.subject.replace(/^CN=/, '') };
}
