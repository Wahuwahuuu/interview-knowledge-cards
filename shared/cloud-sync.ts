import type { Library } from './model';
import type { SyncConflict, SyncOperation } from './sync';

export type CloudAccount = { user_id: string; email: string; display_name: string };
export type CloudSnapshot = { epoch: string; revision: number; library?: Library; unchanged?: boolean };
export type CloudLinkReply = { token: string; deviceId: string; account: CloudAccount };
export type CloudConflict = SyncConflict & { label?: string };
export type CloudSyncStatus = {
  connected: boolean; enabled: boolean; phase: 'unlinked' | 'review' | 'paused' | 'syncing' | 'idle' | 'pending' | 'error' | 'conflict' | 'recovery';
  site?: string; proxy?: string; account?: CloudAccount; lastSync?: string; error?: string; errorCode?: string;
  pending?: boolean; conflicts?: CloudConflict[]; localCards?: number; remoteCards?: number;
};
export type CloudInflight = { operation: SyncOperation; sent: Library; localRevision: number };

export function websiteOrigin(value: string, allowTestLoopback = false) {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('请输入完整的网站 HTTPS 地址'); }
  const test = allowTestLoopback && url.protocol === 'http:' && ['127.0.0.1','localhost'].includes(url.hostname);
  if ((!test && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || !['','/'].includes(url.pathname)) throw new Error('网站地址须为 HTTPS，不包含登录信息、路径或连接码');
  return url.origin;
}
