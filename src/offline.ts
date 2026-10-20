import { emptyLibrary, kinds, librarySchema, type Library } from '../shared/model';
import { removeCard } from '../shared/card-actions';
import { removeProject } from '../shared/project-actions';

export type Download = { id: string; owner: string; downloaded_at: string; snapshot: Library };
const DB_NAME = 'interview-cards-private-v1';
async function openDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('downloads', { keyPath: 'id' }); request.result.createObjectStore('meta'); };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
async function transaction<T>(store: string, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode), request = action(tx.objectStore(store));
    let result: T;
    request.onsuccess = () => { result = request.result; };
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  });
}
export const saveDownload = (download: Download) => transaction('downloads', 'readwrite', store => store.put(download));
export const removeDownload = (id: string) => transaction('downloads', 'readwrite', store => store.delete(id));
export const readDownloads = () => transaction<Download[]>('downloads', 'readonly', store => store.getAll());
export const saveOwner = (email: string) => transaction('meta', 'readwrite', store => store.put(email, 'owner'));
export const readOwner = () => transaction<string | undefined>('meta', 'readonly', store => store.get('owner'));
export async function removeCardFromDownloads(owner: string, cardId: string): Promise<Download[]> {
  const downloads = await readDownloads();
  for (const download of downloads) if (download.owner === owner && download.snapshot.cards.some(card => card.id === cardId)) {
    await saveDownload({ ...download, snapshot: removeCard(librarySchema.parse(download.snapshot), cardId) });
  }
  return readDownloads();
}
export async function removeProjectFromDownloads(owner: string, projectId: string): Promise<Download[]> {
  for (const download of await readDownloads()) if (download.owner === owner) {
    if (download.id === projectId) await removeDownload(download.id);
    else if (download.snapshot.projects.some(project => project.id === projectId)) {
      await saveDownload({ ...download, snapshot: removeProject(librarySchema.parse(download.snapshot), projectId) });
    }
  }
  return readDownloads();
}
export async function clearPrivateData() {
  const results = await Promise.allSettled([
    transaction('downloads', 'readwrite', store => store.clear()),
    transaction('meta', 'readwrite', store => store.clear()),
    (async () => {
      if ('caches' in window) for (const name of await caches.keys()) if (name.startsWith('interview-cards-')) await caches.delete(name);
    })(),
    (async () => {
      navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_PRIVATE_CACHE' });
      const registrations = await navigator.serviceWorker?.getRegistrations() ?? [];
      for (const registration of registrations) if ([registration.active, registration.waiting, registration.installing].some(worker => worker && new URL(worker.scriptURL).pathname === '/sw.js')) await registration.unregister();
    })(),
  ]);
  if (results.some(result => result.status === 'rejected')) throw new Error('浏览器未能完全清除离线内容，请在浏览器设置中清除此网站的数据。');
}
export async function ensureOfflineShell() {
  if (!('serviceWorker' in navigator)) throw new Error('这个浏览器暂不支持离线复习');
  const registration = await navigator.serviceWorker.register('/sw.js');
  if (registration.active) return registration;
  const worker = registration.installing ?? registration.waiting;
  if (!worker) throw new Error('离线页面尚未准备完成，请稍后重试');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { worker.removeEventListener('statechange', changed); reject(new Error('下载页面资源超时，请联网重试')); }, 15_000);
    function changed() { if (worker!.state === 'activated') { clearTimeout(timer); worker!.removeEventListener('statechange', changed); resolve(); } else if (worker!.state === 'redundant') { clearTimeout(timer); worker!.removeEventListener('statechange', changed); reject(new Error('离线页面准备失败，请刷新登录后重试')); } }
    worker.addEventListener('statechange', changed); changed();
  });
  return registration;
}
export function mergeDownloads(downloads: Download[], owner: string): Library {
  const library = emptyLibrary();
  const selected = downloads.filter(d => d.owner === owner);
  for (const kind of kinds) {
    const records = new Map<string, Record<string, unknown>>();
    for (const download of selected) for (const entity of download.snapshot[kind]) {
      const previous = records.get(entity.id);
      if (!previous || String(previous.updated_at) < entity.updated_at) records.set(entity.id, entity as unknown as Record<string, unknown>);
    }
    (library[kind] as unknown[]) = [...records.values()];
  }
  library.revision = Math.max(0, ...selected.map(v => v.snapshot.revision));
  return librarySchema.parse(library);
}
