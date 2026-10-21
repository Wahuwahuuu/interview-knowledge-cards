import { canonical, type ImportBatch, type ImportEnvelope, type Library } from '../shared/model';
import { ApiError, api, loadLibrary } from './api';

export type ImportResult = { batch: ImportBatch; library: Library; already_applied: boolean };

// Keep the request identity after an ambiguous network failure. Retrying unchanged
// content must retrieve the committed result instead of creating a second batch.
export function createImportSubmitter() {
  const ids = new Map<string, string>();
  return async (envelope: ImportEnvelope): Promise<ImportResult> => {
    const fingerprint = canonical(envelope);
    const batchId = envelope.batch_id ?? ids.get(fingerprint) ?? crypto.randomUUID();
    ids.set(fingerprint, batchId);
    return api<ImportResult>('/imports/submit', { method: 'POST', body: JSON.stringify({ ...envelope, batch_id: batchId }) });
  };
}

export async function refreshImportBatch(batch: ImportBatch): Promise<ImportBatch> {
  const path = `/imports/${encodeURIComponent(batch.id)}`;
  if (batch.status !== 'pending') return api<ImportBatch>(path);
  try { return await api<ImportBatch>(`${path}/repreview`, { method: 'POST', body: '{}' }); }
  catch (error) {
    if (!(error instanceof ApiError) || error.status !== 409) throw error;
    const latest = await api<ImportBatch>(path);
    if (latest.status !== 'pending') return latest;
    throw error;
  }
}

export async function cancelImportBatch(batch: ImportBatch): Promise<ImportBatch> {
  if (batch.status !== 'pending') return batch;
  const result = await api<ImportBatch>(`/imports/${encodeURIComponent(batch.id)}/cancel`, { method: 'POST', body: '{}' });
  if (result.status === 'pending') throw new ApiError('取消状态尚未确认，请刷新记录后重试', 502);
  return result;
}

type ApplyResult = { kind: 'applied'; batch: ImportBatch; library: Library } | { kind: 'refreshed'; batch: ImportBatch } | { kind: 'cancelled'; batch: ImportBatch };

export async function applyImportBatch(batch: ImportBatch): Promise<ApplyResult> {
  try {
    const result = await api<{ batch: ImportBatch; library: Library }>(`/imports/${encodeURIComponent(batch.id)}/apply`, {
      method: 'POST', body: JSON.stringify({ expected_revision: batch.base_revision }),
    });
    return { kind: 'applied', batch: result.batch, library: result.library };
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 409 || !['REVISION_CONFLICT', 'IMPORT_CANCELLED'].includes(error.code)) throw error;
    const refreshed = error.code === 'IMPORT_CANCELLED' ? await api<ImportBatch>(`/imports/${encodeURIComponent(batch.id)}`) : await refreshImportBatch(batch);
    if (refreshed.status === 'applied') return { kind: 'applied', batch: refreshed, library: await loadLibrary() };
    if (refreshed.status === 'cancelled') return { kind: 'cancelled', batch: refreshed };
    return { kind: 'refreshed', batch: refreshed };
  }
}
