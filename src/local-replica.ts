import type { Account } from '../shared/accounts';
import { AppError, canonical, diffLibraries, graphElements, importSchema, kinds, librarySchema, prepareImport, projectSnapshot, schemas, validateLibrary, type Entity, type ImportBatch, type ImportEnvelope, type Kind, type Library } from '../shared/model';
import { removeCard } from '../shared/card-actions';
import { removeProject } from '../shared/project-actions';
import { applyProjectOrder, projectOrderRequestSchema } from '../shared/project-order';
import { cardState, cardStateRequestSchema } from '../shared/card-state';
import { applySyncLogs, changesBetween, mergeOperation, type SyncLog, type SyncOperation, type SyncResult, type SyncSnapshot } from '../shared/sync';

export type QueuedOperation = { operation: SyncOperation; conflicts?: SyncResult['conflicts']; error?: string };
export type Replica = { version: 1; storage_revision?: number; server: string; token: string; deviceId: string; account: Account; snapshot: SyncSnapshot; library: Library; pending: QueuedOperation[]; lastSync: string; connectionError?: string };
let mode: 'cloud' | 'desktop' | 'phone' = 'cloud';
let cached: Replica | undefined, locked = Promise.resolve();
const DB = 'interview-cards-replica-v1';
export const runtimeMode = () => mode;
export const editableOffline = () => mode === 'phone';
export const getReplica = () => cached;
const emit = () => window.dispatchEvent(new Event('replica-status'));
async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('state');
    open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
  });
}
async function storage(value?: Replica | null) {
  const db = await database();
  return new Promise<Replica | undefined>((resolve, reject) => {
    const tx = db.transaction('state', value === undefined ? 'readonly' : 'readwrite'), store = tx.objectStore('state');
    const request = store.get('revision');
    let result: Replica | undefined, failure: Error | undefined;
    request.onsuccess = () => {
      const revision = Number(request.result ?? 0);
      if (value === undefined) {
        if (cached && (cached.storage_revision ?? 0) === revision) result = cached;
        else { const read = store.get('current'); read.onsuccess = () => { result = read.result; }; }
      } else {
        if (revision !== (value?.storage_revision ?? cached?.storage_revision ?? revision)) { failure = new AppError(409, '另一个窗口刚保存了修改，请重试。本次内容未被覆盖。', 'REVISION_CONFLICT'); tx.abort(); return; }
        if (value === null) { store.delete('current'); store.put(revision + 1, 'revision'); }
        else { value.storage_revision = revision + 1; store.put(value, 'current'); store.put(revision + 1, 'revision'); }
      }
    };
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onabort = tx.onerror = () => { db.close(); reject(failure ?? (tx.error?.name === 'QuotaExceededError' ? new Error('手机存储空间不足，本次修改尚未保存。请先导出已有资料并检查空间。') : tx.error) ?? new Error('手机存储未能保存，请导出备份并检查剩余空间')); };
  });
}
function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = async () => { cached = await storage(); return task(); };
  const result = locked.then(async () => navigator.locks ? await navigator.locks.request('interview-cards-replica-write', run) as T : await run()); locked = result.then(() => undefined, () => undefined); return result;
}
export async function initializeRuntime(): Promise<'cloud' | 'desktop' | 'phone'> {
  try { cached = await storage(); } catch { /* An online cloud account can still run without IndexedDB. */ }
  if (cached) { mode = 'phone'; return mode; }
  try {
    const response = await fetch('/api/v1/runtime', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
    if (response.ok && response.headers.get('content-type')?.includes('application/json')) {
      const runtime = await response.json() as { mode?: string }; if (runtime.mode === 'desktop' || runtime.mode === 'phone') mode = runtime.mode;
    }
  } catch { /* Existing cloud offline downloads remain supported. */ }
  return mode;
}
async function network<T>(path: string, body?: unknown, token = cached?.token): Promise<T> {
  const response = await fetch('/api/v1/sync/' + path, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'omit', redirect: 'error', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(path === 'pair' || path === 'snapshot' ? 60000 : 12000) }).catch(() => { throw new Error('电脑暂时不可达，离线修改已保留。连接同一网络并打开电脑软件后，可再次同步。'); });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('电脑暂时不可达，离线修改已保留');
  const value = await response.json() as { error?: { message?: string; code?: string } };
  if (!response.ok) throw new AppError(response.status, value.error?.message ?? '同步没有完成', value.error?.code ?? 'SYNC_FAILED');
  return value as T;
}
export async function pairPhone(code: string, name: string) {
  const value = await network<{ token: string; deviceId: string; account: Account; snapshot: SyncSnapshot }>('pair', { code, name }, '');
  if (cached && (cached.account.user_id !== value.account.user_id || cached.server !== location.origin)) throw new Error('请先在旧账户导出待同步资料，再解除配对。');
  await exclusive(async () => {
    if (cached && (cached.account.user_id !== value.account.user_id || cached.server !== location.origin)) throw new Error('请先处理旧账户的待同步资料，再解除配对。');
    const next: Replica = cached ? { ...cached, token: value.token, deviceId: value.deviceId, account: value.account } : { version: 1, server: location.origin, ...value, library: value.snapshot.library, pending: [], lastSync: new Date().toISOString() };
    await storage(next); cached = next; mode = 'phone'; emit();
  });
  await navigator.storage?.persist?.().catch(() => false);
}
export function pendingReplica() { return Boolean(cached?.pending.length); }
export async function forgetReplica() {
  await exclusive(async () => {
    if (pendingReplica()) throw new Error('还有待同步修改，请先同步或导出保存；不能直接清除。');
    await storage(null); cached = undefined; emit();
  });
}
export function exportReplica(): string { if (!cached) throw new Error('这台手机尚未配对'); return JSON.stringify({ type: 'interview-cards-device-backup', ...cached }, null, 2); }
export async function importReplica(text: string) {
  if (cached) throw new Error('当前设备已有题库，请先同步并解除配对。');
  const value = JSON.parse(text);
  if (value.type !== 'interview-cards-device-backup' || value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.token) || !Array.isArray(value.pending) || typeof value.account?.user_id !== 'string' || typeof value.snapshot?.epoch !== 'string') throw new Error('这不是有效的设备恢复文件');
  librarySchema.parse(value.library); librarySchema.parse(value.snapshot.library);
  const next = { ...value, server: location.origin } as Replica;
  delete next.storage_revision;
  await exclusive(async () => { if (cached) throw new Error('当前设备已有题库，请先同步并解除配对。'); await storage(next); cached = next; mode = 'phone'; emit(); });
}

/** All UI edits use the same adapter, so editors/imports/flags remain available offline. */
export async function replicaApi(path: string, init: RequestInit): Promise<unknown> {
  return exclusive(async () => {
    if (!cached) throw new AppError(401, '请先与电脑配对', 'PAIRING_REQUIRED');
    const current = cached, method = init.method ?? 'GET', input = init.body ? JSON.parse(String(init.body)) : {};
    const base = current.library, now = new Date().toISOString();
    const daily = () => ({ ...base, revisions: [] });
    if (method === 'GET') {
      if (path === '/me') return current.account;
      if (path === '/library') return daily();
      if (path === '/export') return { ...base, mode: 'restore', exported_at: now };
      if (path === '/imports') return replicaImports(current);
      if (path === '/auth/status') return { registration_open: false, admin_ready: true };
      const record = path.match(/^\/imports\/([^/]+)$/); if (record) { const batch = replicaImports(current).find(batch => batch.id === decodeURIComponent(record[1])); if (!batch) throw new AppError(404, '导入记录不存在'); return batch; }
      const snapshot = path.match(/^\/projects\/([^/]+)\/snapshot$/); if (snapshot) return { owner: current.account.email, downloaded_at: now, snapshot: projectSnapshot(base, snapshot[1]) };
      const history = path.match(/^\/cards\/([^/]+)\/history$/); if (history) return base.revisions.filter(entry => entry.card_id === history[1]);
      if (path.startsWith('/graph')) return { elements: graphElements(base, new URL(path, location.origin).searchParams.get('project_id') ?? undefined) };
      const kind = path.slice(1) as Kind; if (kinds.includes(kind)) return base[kind];
      throw new AppError(503, '账户管理请在电脑客户端中操作', 'DESKTOP_REQUIRED');
    }
    if (input.expected_revision !== undefined && input.expected_revision !== base.revision) throw new AppError(409, '本机题库已更新，请刷新后再保存', 'REVISION_CONFLICT');
    let target = base, result: unknown, record: ImportBatch | undefined;
    const state = path.match(/^\/cards\/([^/]+)\/state$/), entity = path.match(/^\/(projects|cards|topics|sources|occurrences|relations)\/([^/]+)$/);
    if (state && method === 'PATCH') {
      const value = cardStateRequestSchema.parse(input), card = base.cards.find(card => card.id === state[1]);
      if (!card) throw new AppError(404, '知识卡不存在');
      if (value.card_revision !== card.revision) throw new AppError(409, '知识卡已更新，请重试', 'REVISION_CONFLICT');
      const next = { ...card, ...value.patch, updated_at: now };
      target = { ...base, cards: base.cards.map(card => card.id === next.id ? next : card) }; result = { card: cardState(next) };
    } else if (path === '/projects/order' && method === 'PUT') {
      target = { ...base, projects: applyProjectOrder(base.projects, projectOrderRequestSchema.parse(input).project_ids, now) }; result = { projects: target.projects };
    } else if (path === '/changes' && method === 'POST') target = localImport(base, importSchema.parse(input.changes), now);
    else if (entity && method === 'PUT') {
      const kind = entity[1] as Kind, value = schemas[kind].parse(input.value) as Entity;
      if (value.id !== entity[2]) throw new AppError(422, '记录 ID 不一致');
      const old = (base[kind] as Entity[]).find(item => item.id === value.id);
      if (old && old.revision !== value.revision) throw new AppError(409, '记录已更新，请刷新后再编辑', 'REVISION_CONFLICT');
      target = localImport(base, importSchema.parse({ schema_version: 1, [kind]: [value] }), now);
    } else if (entity && method === 'DELETE') {
      const kind = entity[1] as Kind, id = entity[2];
      if (kind === 'cards') target = removeCard(base, id);
      else if (kind === 'projects') target = removeProject(base, id);
      else if (kind === 'sources' || kind === 'occurrences') throw new AppError(422, '原始问答与来源保留供追溯');
      else target = { ...base, [kind]: (base[kind] as Entity[]).filter(item => item.id !== id) };
    } else if (path === '/imports/submit' && method === 'POST') {
      const envelope = importSchema.parse(input); if (envelope.mode !== 'merge') throw new AppError(403, '完整恢复请在电脑客户端预览并确认');
      const id = envelope.batch_id ?? crypto.randomUUID(), previous = replicaImports(current).find(batch => batch.id === id);
      if (previous) return { batch: previous, library: daily(), already_applied: true };
      target = localImport(base, envelope, now);
      record = { id, mode: 'merge', status: 'applied', base_revision: base.revision, created_at: now, applied_at: now, preview: diffLibraries(base, target), question_count: envelope.cards.length };
    } else if (path === '/auth/logout') throw new AppError(503, '请在同步设置中解除配对');
    else throw new AppError(503, '这项管理操作请在电脑客户端完成', 'DESKTOP_REQUIRED');
    validateLibrary(target); librarySchema.parse(target);
    target = { ...target, revision: base.revision + 1 };
    const operation: SyncOperation = { id: crypto.randomUUID(), epoch: current.snapshot.epoch, changes: changesBetween(base, target), ...(record ? { record, input } : {}) };
    const next: Replica = { ...current, library: target, pending: [...current.pending, { operation }] };
    // An IndexedDB commit, rather than an optimistic render, defines local save success.
    await storage(next); cached = next; emit(); window.dispatchEvent(new Event('replica-edit'));
    return record ? { batch: record, library: { ...target, revisions: [] }, already_applied: false } : result ? { ...result, revision: target.revision } : { ...target, revisions: [] };
  });
}

let synchronizing = false;
function localImport(base: Library, envelope: ImportEnvelope, now: string) {
  if (envelope.mode !== 'merge') throw new AppError(403, '完整备份恢复请在电脑客户端预览并确认');
  const target = prepareImport({ ...base, revisions: [] }, envelope, now);
  target.revisions = [...base.revisions, ...target.revisions]; return target;
}
function replicaImports(replica: Replica): ImportBatch[] {
  const records = new Map(replica.snapshot.imports.map(record => [record.id, record]));
  for (const pending of replica.pending) if (pending.operation.record) { const record = pending.operation.record as ImportBatch; records.set(record.id, record); }
  return [...records.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
}
export const isSynchronizing = () => synchronizing;
function replay(snapshot: SyncSnapshot, pending: QueuedOperation[]): Library {
  let library = structuredClone(snapshot.library);
  for (const item of pending) {
    const merged = mergeOperation(library, item.operation);
    if (!merged.conflicts.length) library = merged.target;
    else {
      // Keep local unsent text visible even if it now conflicts; both copies remain in storage.
      for (const change of item.operation.changes) {
        const list = library[change.kind] as Entity[], index = list.findIndex(value => value.id === change.id);
        if (!change.after) { if (index >= 0) list.splice(index, 1); }
        else {
          const before = change.before ?? {}, value = index >= 0 ? { ...list[index] } as Record<string, unknown> : { ...change.after };
          for (const [field, after] of Object.entries(change.after)) if (!['revision', 'updated_at'].includes(field) && canonical(before[field]) !== canonical(after)) value[field] = after;
          if (index >= 0) list[index] = value as Entity; else list.push(value as Entity);
        }
      }
    }
    library.revision++;
  }
  return library;
}
export async function synchronizePhone() {
  if (!cached || synchronizing) return;
  synchronizing = true; emit();
  try {
    const initial = cached, accepted = new Set<string>(); let failed: { id: string; conflicts: SyncResult['conflicts'] } | undefined;
    for (const item of initial.pending) {
      if (item.conflicts || item.error) break;
      const result = await network<SyncResult>('push', item.operation);
      if (result.status === 'conflict') { failed = { id: item.operation.id, conflicts: result.conflicts }; break; }
      accepted.add(item.operation.id);
    }
    let snapshot = initial.snapshot;
    for (;;) {
      const pull = await network<{ logs: SyncLog[]; cursor: number; more: boolean; revision: number }>(`pull?epoch=${encodeURIComponent(snapshot.epoch)}&cursor=${snapshot.cursor}`);
      snapshot = applySyncLogs(snapshot, pull.logs, pull.cursor); snapshot = { ...snapshot, library: { ...snapshot.library, revision: pull.revision } };
      if (!pull.more) break;
    }
    await exclusive(async () => {
      if (!cached || cached.deviceId !== initial.deviceId) return;
      if (snapshot.cursor === initial.snapshot.cursor && !accepted.size && !failed) {
        const next = { ...cached, lastSync: new Date().toISOString(), connectionError: '' }; await storage(next); cached = next; emit(); return;
      }
      const pending = cached.pending.filter(item => !accepted.has(item.operation.id)).map(item => item.operation.id === failed?.id ? { ...item, conflicts: failed.conflicts } : item);
      const localVersion = cached.library.revision;
      const library = replay(snapshot, pending); library.revision = Math.max(library.revision, localVersion + 1);
      const next = { ...cached, snapshot, pending, library, lastSync: new Date().toISOString(), connectionError: '' };
      await storage(next); cached = next; emit(); window.dispatchEvent(new Event('replica-library'));
    });
  } catch (error) {
    await exclusive(async () => {
      if (!cached) return;
      const pending = error instanceof AppError && error.code === 'EPOCH_CHANGED' ? cached.pending.map((item, index) => index ? item : { ...item, conflicts: [{ kind: 'library', id: item.operation.id, field: 'generation', before: item.operation.epoch, computer: '电脑已从完整备份恢复，需要重新选择保留哪些手机修改。', phone: item.operation.changes }] }) : cached.pending;
      const next = { ...cached, pending, connectionError: error instanceof Error ? error.message : '电脑暂时不可达' }; await storage(next); cached = next; emit();
    });
  } finally { synchronizing = false; emit(); }
}

export async function resolveSyncConflict(id: string, choice: 'computer' | 'phone', edits?: Record<string, string>) {
  // Pull the latest base before resolving. A further concurrent edit will conflict again safely.
  const snapshot = await network<SyncSnapshot>('snapshot');
  await exclusive(async () => {
    if (!cached) return;
    const index = cached.pending.findIndex(item => item.operation.id === id); if (index < 0) return;
    const pending = [...cached.pending], item = pending[index];
    if (choice === 'computer') pending.splice(index, 1);
    else {
      const rebased = replay(snapshot, pending.slice(0, index));
      const changes = item.operation.changes.map(change => {
        const before = (rebased[change.kind] as Entity[]).find(value => value.id === change.id);
        let after = change.after ? { ...(before ?? change.after) } as Record<string, unknown> : null;
        if (after && change.after) for (const [field, value] of Object.entries(change.after)) if (!change.before || canonical(change.before[field]) !== canonical(value)) after[field] = value;
        if (after && edits) for (const field of ['question', 'title', 'summary_md', 'answer_md']) if (edits[`${change.id}:${field}`] !== undefined) after[field] = edits[`${change.id}:${field}`];
        // Retaining a deleted entity is an explicit user choice, with a new operation ID.
        return { ...change, before: before ? { ...before } : null, after };
      });
      pending[index] = { operation: { ...item.operation, id: crypto.randomUUID(), epoch: snapshot.epoch, changes } };
    }
    const next = { ...cached, snapshot, pending, library: replay(snapshot, pending), connectionError: '' };
    next.library.revision = cached.library.revision + 1;
    await storage(next); cached = next; emit(); window.dispatchEvent(new Event('replica-library'));
  });
}

export async function acceptRestoredLibrary() {
  if (pendingReplica()) throw new Error('还有待同步修改。请先在冲突界面逐项处理，或导出设备备份后再操作。');
  const snapshot = await network<SyncSnapshot>('snapshot');
  await exclusive(async () => { if (!cached) return; const next = { ...cached, snapshot, library: snapshot.library, connectionError: '', lastSync: new Date().toISOString() }; await storage(next); cached = next; emit(); window.dispatchEvent(new Event('replica-library')); });
}
