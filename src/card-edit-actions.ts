import { applyCardEditResult, cardEditRequest, type CardEditRequest, type CardEditResult } from '../shared/card-edit';
import type { Card, Library } from '../shared/model';
import { api } from './api';

export async function saveCard(library: Library, expectedRevision: number, before: Card | null, after: Card, followup?: CardEditRequest['followup']): Promise<Library> {
  const input = cardEditRequest(before, after, expectedRevision);
  if (followup) input.followup = followup;
  if (before && Object.keys(input.patch).length === 0) return library;
  const result = await api<CardEditResult>(`/cards/${encodeURIComponent(after.id)}`, { method: 'PATCH', body: JSON.stringify(input) });
  return applyCardEditResult(library, expectedRevision, after.id, result);
}
