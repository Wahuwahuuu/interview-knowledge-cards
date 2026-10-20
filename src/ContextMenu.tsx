import { useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal } from 'lucide-react';

export type ContextMenuItem = { label: string; icon: ReactNode; onSelect: () => void; disabled?: boolean; danger?: boolean };

export function MoreActionsButton({ label, expanded, onOpen }: { label: string; expanded?: boolean; onOpen: (event: MouseEvent<HTMLButtonElement>) => void }) {
  return <button type="button" className="icon-button more-actions" aria-label={label} aria-haspopup="menu" aria-expanded={!!expanded} onClick={event => { event.stopPropagation(); onOpen(event); }}><MoreHorizontal size={18} /></button>;
}

export function ContextMenu({ label, x, y, items, onClose }: {
  label: string; x: number; y: number; items: ContextMenuItem[]; onClose: (restoreFocus?: boolean) => void;
}) {
  const menu = useRef<HTMLDivElement>(null), close = useRef(onClose); close.current = onClose;
  const [position, setPosition] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const node = menu.current;
    if (!node) return;
    const bounds = node.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8)) });
    node.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const dismiss = (event: Event) => { if (!node.contains(event.target as Node)) close.current(false); };
    const resize = () => close.current(false);
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', resize);
    window.addEventListener('blur', resize);
    return () => { document.removeEventListener('pointerdown', dismiss, true); document.removeEventListener('scroll', dismiss, true); window.removeEventListener('resize', resize); window.removeEventListener('blur', resize); };
  }, [x, y]);

  return createPortal(<div ref={menu} className="context-menu" role="menu" aria-label={label} style={position} onContextMenu={event => event.preventDefault()} onKeyDown={event => {
    if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); event.stopPropagation(); onClose(true); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }}>
    <div className="context-menu-name" aria-hidden="true">{label}</div>
    {items.map(item => <button type="button" role="menuitem" tabIndex={-1} key={item.label} className={item.danger ? 'context-menu-danger' : undefined} disabled={item.disabled} onClick={() => { onClose(true); item.onSelect(); }}>{item.icon}<span>{item.label}</span></button>)}
  </div>, document.body);
}
