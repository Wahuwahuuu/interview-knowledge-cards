import type { ImportBatch, Library } from '../shared/model';
import { ApiError, api, loadLibrary } from './api';

export function refreshImportBatch(batch: ImportBatch): Promise<ImportBatch> {
  const path = `/imports/${encodeURIComponent(batch.id)}`;
  return batch.status === 'pending'
    ? api<ImportBatch>(`${path}/repreview`, { method: 'POST', body: '{}' })
    : api<ImportBatch>(path);
}

type ApplyResult = { kind: 'applied'; batch: ImportBatch; library: Library } | { kind: 'refreshed'; batch: ImportBatch };

export async function applyImportBatch(batch: ImportBatch): Promise<ApplyResult> {
  try {
    const result = await api<{ batch: ImportBatch; library: Library }>(`/imports/${encodeURIComponent(batch.id)}/apply`, {
      method: 'POST', body: JSON.stringify({ expected_revision: batch.base_revision }),
    });
    return { kind: 'applied', batch: result.batch, library: result.library };
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 409 || error.code !== 'REVISION_CONFLICT') throw error;
    const refreshed = await refreshImportBatch(batch);
    if (refreshed.status === 'applied') return { kind: 'applied', batch: refreshed, library: await loadLibrary() };
    return { kind: 'refreshed', batch: refreshed };
  }
}
