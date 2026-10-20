import { useRef, type ReactNode } from 'react';
import { Trash2 } from 'lucide-react';
import { Modal } from './Editors';

export function ConfirmationDialog({ title, name, description, busy = false, confirmDisabled = false, error = '', confirmLabel = '确认删除', onCancel, onConfirm }: {
  title: string; name?: ReactNode; description: string; busy?: boolean; confirmDisabled?: boolean; error?: string; confirmLabel?: string;
  onCancel: () => void; onConfirm: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  return <Modal title={title} role="alertdialog" closeDisabled={busy} initialFocusRef={cancel} descriptionId="delete-description" onClose={() => { if (!busy) onCancel(); }}>
    <section className="delete-confirmation">
      {name && <p className="delete-confirmation-name">{name}</p>}
      <p id="delete-description">{description}</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="button-row">
        <button ref={cancel} type="button" className="secondary" disabled={busy} onClick={onCancel}>取消</button>
        <button type="button" className="primary danger-button" disabled={busy || confirmDisabled} onClick={onConfirm}><Trash2 size={15} />{busy ? '正在处理…' : confirmLabel}</button>
      </div>
    </section>
  </Modal>;
}
