import type { CardStatePatch, CardStateRequest, CardStateResult } from '../shared/card-state';
import type { Library } from '../shared/model';
import { ApiError, api, loadLibrary } from './api';

export type StateEdit = { id: string; patch: CardStatePatch; version: number };
export type StateSaveSnapshot = { pending: StateEdit[]; failed: StateEdit[]; retrying: boolean };
type Options = {
  getLibrary: () => Library | null;
  getContext: () => number;
  onLibrary: (library: Library) => void;
  onChange: (snapshot: StateSaveSnapshot) => void;
  onError: (error: unknown) => void;
  send?: (id: string, input: CardStateRequest) => Promise<CardStateResult>;
  reload?: () => Promise<Library>;
};

export function overlayCardStates(library: Library | null, edits: StateEdit[]): Library | null {
  if (!library || !edits.length) return library;
  const byId = new Map(edits.map(edit => [edit.id, edit.patch]));
  return { ...library, cards: library.cards.map(card => byId.has(card.id) ? { ...card, ...byId.get(card.id) } : card) };
}

/** Serialize small state writes while the UI can keep moving through questions. */
export class CardStateQueue {
  private pending = new Map<string, StateEdit>();
  private failed = new Map<string, StateEdit>();
  private version = 0;
  private generation = 0;
  private running = false;
  private retrying = false;
  constructor(private options: Options) {}
  get hasPending() { return this.pending.size > 0 || this.retrying; }
  private emit() { this.options.onChange({ pending: [...this.pending.values()], failed: [...this.failed.values()], retrying: this.retrying }); }
  reset() { this.generation++; this.pending.clear(); this.failed.clear(); this.running = false; this.retrying = false; this.emit(); }

  enqueue(id: string, patch: CardStatePatch) {
    const card = this.options.getLibrary()?.cards.find(card => card.id === id);
    if (!card) return;
    const previous = this.pending.get(id);
    const combined = { ...this.failed.get(id)?.patch, ...previous?.patch, ...patch };
    if (previous && Object.entries(combined).every(([key, value]) => previous.patch[key as keyof CardStatePatch] === value)) return;
    if (!previous && !this.failed.has(id) && Object.entries(combined).every(([key, value]) => card[key as keyof CardStatePatch] === value)) return;
    this.failed.delete(id);
    this.pending.set(id, { id, patch: combined, version: ++this.version });
    this.emit();
    void this.drain();
  }

  private async drain() {
    if (this.running || this.retrying) return;
    this.running = true;
    const generation = this.generation, context = this.options.getContext();
    const current = () => generation === this.generation && context === this.options.getContext();
    try {
      while (this.pending.size && current()) {
        const edit = this.pending.values().next().value!;
        const library = this.options.getLibrary(), card = library?.cards.find(card => card.id === edit.id);
        try {
          if (!library || !card) throw new ApiError('这道题已被移除，标记没有保存', 404);
          const input: CardStateRequest = { expected_revision: library.revision, card_revision: card.revision, patch: edit.patch };
          const result = await (this.options.send ?? ((id, value) => api<CardStateResult>(`/cards/${encodeURIComponent(id)}/state`, { method: 'PATCH', body: JSON.stringify(value), signal: AbortSignal.timeout(15000) })))(edit.id, input);
          if (!current()) return;
          const latest = this.options.getLibrary();
          if (!latest || latest.revision !== library.revision || result.card.id !== edit.id) throw new ApiError('题库刚有更新，请重试保存标记', 409, 'REVISION_CONFLICT');
          this.options.onLibrary({ ...latest, revision: result.revision, cards: latest.cards.map(value => value.id === edit.id ? { ...value, ...result.card } : value) });
          if (this.pending.get(edit.id)?.version === edit.version) this.pending.delete(edit.id);
          this.emit();
        } catch (error) {
          if (!current()) return;
          for (const [id, value] of this.pending) this.failed.set(id, value);
          this.pending.clear();
          this.emit();
          this.options.onError(error);
          break;
        }
      }
    } finally {
      if (generation === this.generation) {
        this.running = false;
        if (!current()) { this.pending.clear(); this.failed.clear(); this.emit(); }
      }
    }
  }

  async retry() {
    if (this.hasPending || !this.failed.size) return;
    this.retrying = true; this.emit();
    const generation = this.generation, context = this.options.getContext();
    const current = () => generation === this.generation && context === this.options.getContext();
    try {
      // A lost response may have committed. Refresh before explicitly retrying.
      const library = await (this.options.reload ?? loadLibrary)();
      if (!current()) return;
      this.options.onLibrary(library);
      const deleted = [...this.failed.keys()].filter(id => !library.cards.some(card => card.id === id));
      for (const id of deleted) this.failed.delete(id);
      for (const [id, edit] of this.failed) this.pending.set(id, { ...edit, version: ++this.version });
      this.failed.clear();
      if (deleted.length) this.options.onError(new ApiError('部分题目已被移除，已跳过对应标记', 404));
    } catch (error) {
      if (current()) this.options.onError(error);
    } finally {
      if (generation === this.generation) { this.retrying = false; this.emit(); }
    }
    if (current()) void this.drain();
  }
}
