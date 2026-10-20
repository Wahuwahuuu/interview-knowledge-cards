import { useEffect, useMemo, useRef, useState } from 'react';
import type { Library } from '../shared/model';
import { CardStateQueue, overlayCardStates, type StateSaveSnapshot } from './card-state-actions';

export function useCardStateUpdates(options: {
  library: Library | null;
  owner?: string;
  getContext: () => number;
  onLibrary: (library: Library) => void;
  onError: (error: unknown) => void;
}) {
  const latest = useRef(options); latest.current = options;
  const confirmed = useRef(options.library); confirmed.current = options.library;
  const [snapshot, setSnapshot] = useState<StateSaveSnapshot>({ pending: [], failed: [], retrying: false });
  const queueRef = useRef<CardStateQueue | null>(null);
  if (!queueRef.current) queueRef.current = new CardStateQueue({
    getLibrary: () => confirmed.current,
    getContext: () => latest.current.getContext(),
    onLibrary: library => { confirmed.current = library; latest.current.onLibrary(library); },
    onChange: setSnapshot,
    onError: error => latest.current.onError(error),
  });
  const queue = queueRef.current;
  useEffect(() => { queue.reset(); return () => queue.reset(); }, [queue, options.owner]);
  const library = useMemo(() => overlayCardStates(options.library, snapshot.pending), [options.library, snapshot.pending]);
  const statusById = useMemo(() => ({ ...Object.fromEntries(snapshot.failed.map(edit => [edit.id, 'error' as const])), ...Object.fromEntries(snapshot.pending.map(edit => [edit.id, 'saving' as const])) }), [snapshot]);
  return { library, queue, ...snapshot, statusById, saving: snapshot.pending.length > 0 || snapshot.retrying };
}
