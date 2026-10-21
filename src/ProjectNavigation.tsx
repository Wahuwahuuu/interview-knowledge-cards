import { useEffect, useId, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { Folder, GripVertical } from 'lucide-react';
import type { Project } from '../shared/model';
import { moveProject } from '../shared/project-order';
import './project-navigation.css';

type DropTarget = { id: string; after: boolean };
type Drag = { id: string; pointerId: number; handle: HTMLButtonElement; startX: number; startY: number; x: number; y: number; active: boolean; target?: DropTarget };

export function ProjectNavigation({ projects, selectedId, counts, disabled, onOpen, onMenu, onReorder }: {
  projects: Project[]; selectedId?: string; counts: Record<string, number>; disabled: boolean;
  onOpen: (id: string) => void; onMenu: (event: MouseEvent<HTMLElement>, id: string) => void; onReorder: (ids: string[]) => void;
}) {
  const nav = useRef<HTMLElement>(null), drag = useRef<Drag | null>(null), frame = useRef(0);
  const [moving, setMoving] = useState(''), [drop, setDrop] = useState<DropTarget>(), [announcement, setAnnouncement] = useState('');
  const instructions = useId();
  const ids = projects.map(project => project.id);
  function cancel() {
    const current = drag.current;
    drag.current = null; cancelAnimationFrame(frame.current); setMoving(''); setDrop(undefined);
    if (current?.handle.hasPointerCapture(current.pointerId)) current.handle.releasePointerCapture(current.pointerId);
  }
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && drag.current) { event.preventDefault(); cancel(); } };
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('keydown', escape); cancelAnimationFrame(frame.current); };
  }, []);
  useEffect(() => { if (disabled) cancel(); }, [disabled]);
  function locate() {
    const current = drag.current;
    if (!current?.active || !nav.current) return;
    const row = document.elementFromPoint(current.x, current.y)?.closest<HTMLElement>('[data-project-order-id]');
    const id = row?.dataset.projectOrderId;
    const target = row && id && nav.current.contains(row) ? { id, after: current.y >= row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2 } : undefined;
    if (current.target?.id !== target?.id || current.target?.after !== target?.after) { current.target = target; setDrop(target); }
  }
  function autoScroll() {
    const current = drag.current, scroller = nav.current?.closest<HTMLElement>('.projects-nav');
    if (!current?.active || !scroller) return;
    const bounds = scroller.getBoundingClientRect();
    if (current.x >= bounds.left && current.x <= bounds.right) {
      const speed = current.y < bounds.top + 38 ? -8 : current.y > bounds.bottom - 38 ? 8 : 0;
      if (speed) { scroller.scrollTop += speed; locate(); }
    }
    frame.current = requestAnimationFrame(autoScroll);
  }
  function start(event: PointerEvent<HTMLButtonElement>, id: string) {
    if (disabled || event.button !== 0) return;
    event.preventDefault(); event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id, pointerId: event.pointerId, handle: event.currentTarget, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, active: false };
  }
  function move(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    current.x = event.clientX; current.y = event.clientY;
    if (!current.active && Math.hypot(current.x - current.startX, current.y - current.startY) > 4) {
      current.active = true; setMoving(current.id); frame.current = requestAnimationFrame(autoScroll);
    }
    locate();
  }
  function finish(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (current.active && current.target) commit(moveProject(ids, current.id, current.target.id, current.target.after), current.id);
    cancel();
  }
  function commit(next: string[], id: string) {
    if (next.every((value, index) => value === ids[index])) return;
    setAnnouncement(`${projects.find(project => project.id === id)?.name}已移到第 ${next.indexOf(id) + 1} 位`);
    onReorder(next);
  }
  return <>
    <span id={instructions} className="visually-hidden">按住拖动调整项目顺序，或使用上下方向键移动。按 Escape 取消拖动。</span>
    <nav ref={nav} className="project-order-nav" aria-label="项目列表">{projects.map((project, index) => <div key={project.id} data-project-order-id={project.id} className={`project-nav-row${selectedId === project.id ? ' active' : ''}${moving === project.id ? ' is-dragging' : ''}${moving && drop?.id === project.id && moving !== project.id ? drop.after ? ' drop-after' : ' drop-before' : ''}`} onContextMenu={event => onMenu(event, project.id)}>
      <button type="button" className="project-nav-open" aria-current={selectedId === project.id ? 'page' : undefined} onClick={() => onOpen(project.id)}><span className={'project-symbol symbol-' + index % 4}><Folder size={15} /></span><span className="nav-project-name">{project.name}</span><span className="nav-count">{counts[project.id] ?? 0}</span></button>
      <button type="button" className="project-drag-handle" aria-label={`调整 ${project.name} 的顺序`} aria-describedby={instructions} aria-disabled={disabled} title="拖动调整顺序" onPointerDown={event => start(event, project.id)} onPointerMove={move} onPointerUp={finish} onPointerCancel={cancel} onLostPointerCapture={cancel} onClick={event => event.stopPropagation()} onKeyDown={event => {
        if (disabled || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault(); const offset = event.key === 'ArrowUp' ? -1 : 1, target = ids[index + offset];
        if (target) commit(moveProject(ids, project.id, target, offset > 0), project.id);
      }}><GripVertical size={15} /></button>
    </div>)}</nav>
    <span className="visually-hidden" role="status">{announcement}</span>
  </>;
}
