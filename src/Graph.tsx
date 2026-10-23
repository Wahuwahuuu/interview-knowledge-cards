import { useEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, Minus, Plus, RotateCcw, Search, Settings2, X } from 'lucide-react';
import type { Library } from '../shared/model';
import { anchoredGraphViewport, graphWheelZoom, graphZoomLimits, type GraphPoint, type GraphViewport } from '../shared/graph-viewport';
import { buildGraphScene, defaultGraphForces, type GraphForces, type GraphScene, type GraphWorkerRequest, type GraphWorkerResponse } from '../shared/graph-scene';

type Props = { library: Library; projectId?: string; onScopeChange: (id?: string) => void; onCard: (id: string) => void; onProject: (id: string) => void; onTopic: (id: string) => void };
type Display = { nodeScale: number; textScale: number; lineScale: number; labelThreshold: number };
type Controls = { fit: () => void; zoom: (factor: number) => void; restart: () => void; draw: () => void; open: (index: number) => void };
const defaults: Display = { nodeScale: 1, textScale: 1, lineScale: 1, labelThreshold: 0.55 };
const idleControls: Controls = { fit() {}, zoom() {}, restart() {}, draw() {}, open() {} };

function titleLines(title: string) {
  const lines: string[] = []; let line = '', width = 0;
  for (const character of title) {
    const unit = /[\x00-\xff]/.test(character) ? 0.55 : 1;
    if (width + unit > 18 && line) { lines.push(line); line = ''; width = 0; }
    line += character; width += unit;
  }
  if (line) lines.push(line);
  return lines.length > 3 ? [...lines.slice(0, 2), lines[2].slice(0, -1) + '…'] : lines;
}

export function Graph(props: Props) {
  const { library, projectId, onScopeChange } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null), hostRef = useRef<HTMLDivElement>(null), workerRef = useRef<Worker | null>(null);
  const propsRef = useRef(props); propsRef.current = props;
  const api = useRef<Controls>(idleControls);
  const [settingsOpen, setSettingsOpen] = useState(false), [query, setQuery] = useState('');
  const [visibleTypes, setVisibleTypes] = useState({ project: true, card: true, topic: true });
  const [display, setDisplay] = useState(defaults), [forces, setForces] = useState<GraphForces>(defaultGraphForces);
  const [zoom, setZoom] = useState(100), [notice, setNotice] = useState(''), [keyboardNode, setKeyboardNode] = useState('');
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const displayRef = useRef(display), forcesRef = useRef(forces); displayRef.current = display; forcesRef.current = forces;
  const rawScene = useMemo(() => buildGraphScene(library, projectId), [library, projectId]);
  const scene = useMemo<GraphScene>(() => {
    const included = new Set<number>(), needle = query.trim().toLocaleLowerCase();
    rawScene.nodes.forEach((node, index) => { if (visibleTypes[node.type] && (!needle || node.label.toLocaleLowerCase().includes(needle))) included.add(index); });
    const indices = new Map<number, number>();
    const nodes = rawScene.nodes.filter((_, index) => { if (!included.has(index)) return false; indices.set(index, indices.size); return true; });
    return { nodes, links: rawScene.links.filter(link => included.has(link.source) && included.has(link.target)).map(link => ({ source: indices.get(link.source)!, target: indices.get(link.target)! })) };
  }, [rawScene, visibleTypes, query]);

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReduced(preference.matches);
    preference.addEventListener('change', change); return () => preference.removeEventListener('change', change);
  }, []);
  useEffect(() => { api.current.draw(); }, [display]);
  useEffect(() => { workerRef.current?.postMessage({ type: 'forces', forces } satisfies GraphWorkerRequest); }, [forces]);

  useEffect(() => {
    const canvas = canvasRef.current, host = hostRef.current;
    if (!canvas || !host) return;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) { setNotice('画布暂时不可用，请刷新页面重试。'); return; }
    setNotice(''); setKeyboardNode('');
    let width = 1, height = 1, ratio = 1, frame = 0, destroyed = false, visible = true, dirty = true, firstSize = true;
    let hover = -1, keyboardIndex = -1, touched = false, initialFit = false, lastZoomNotice = 0, zoomTimer = 0;
    let view: GraphViewport = { zoom: 1, pan: { x: 0, y: 0 } };
    let automaticView: GraphViewport | null = null;
    let targets: Float32Array = new Float32Array(scene.nodes.flatMap(node => [node.x, node.y]));
    const positions = new Float32Array(targets), labels = scene.nodes.map(node => titleLines(node.label));
    const neighbors = scene.nodes.map(() => new Set<number>());
    scene.links.forEach(link => { neighbors[link.source].add(link.target); neighbors[link.target].add(link.source); });
    const points = new Map<number, GraphPoint>();
    let gesture: { pointerId: number; index: number; start: GraphPoint; last: GraphPoint; offset: GraphPoint; moved: boolean } | null = null;
    let pinch: { distance: number; midpoint: GraphPoint; view: GraphViewport } | null = null;
    let revision = 0;
    let protectedNode: { index: number; x: number; y: number; revision: number; released: boolean } | null = null;
    let worker: Worker | null = null;
    function post(message: GraphWorkerRequest) { worker?.postMessage(message); }
    function screen(index: number) { return { x: positions[index * 2] * view.zoom + view.pan.x, y: positions[index * 2 + 1] * view.zoom + view.pan.y }; }
    function model(point: GraphPoint) { return { x: (point.x - view.pan.x) / view.zoom, y: (point.y - view.pan.y) / view.zoom }; }
    function local(event: { clientX: number; clientY: number }) { const rect = canvas!.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; }
    function publishZoom(force = false) {
      const now = performance.now(); window.clearTimeout(zoomTimer);
      if (force || now - lastZoomNotice > 100) { setZoom(Math.round(view.zoom * 100)); lastZoomNotice = now; }
      else zoomTimer = window.setTimeout(() => { if (!destroyed) { setZoom(Math.round(view.zoom * 100)); lastZoomNotice = performance.now(); } }, 100 - (now - lastZoomNotice));
    }
    function requestDraw() { dirty = true; if (!frame && visible && !document.hidden && !destroyed) frame = requestAnimationFrame(draw); }
    function fittedViewport(coordinates: Float32Array): GraphViewport {
      if (!scene.nodes.length) return view;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let index = 0; index < scene.nodes.length; index++) { minX = Math.min(minX, coordinates[index * 2]); maxX = Math.max(maxX, coordinates[index * 2]); minY = Math.min(minY, coordinates[index * 2 + 1]); maxY = Math.max(maxY, coordinates[index * 2 + 1]); }
      const availableWidth = Math.max(120, width - (width < 600 ? 100 : 180)), availableHeight = Math.max(120, height - 160);
      const zoom = Math.min(1.5, Math.max(graphZoomLimits.min, Math.min(availableWidth / Math.max(120, maxX - minX), availableHeight / Math.max(120, maxY - minY))));
      return { zoom, pan: { x: width / 2 - (minX + maxX) / 2 * zoom, y: height / 2 - (minY + maxY) / 2 * zoom } };
    }
    function fit() { automaticView = null; view = fittedViewport(positions); publishZoom(true); requestDraw(); }
    function radius(index: number) { return Math.max(2, scene.nodes[index].radius * Math.sqrt(view.zoom) * displayRef.current.nodeScale); }
    function hit(point: GraphPoint, touch = false) {
      let found = -1, nearest = Infinity;
      for (let index = 0; index < scene.nodes.length; index++) {
        const p = screen(index), distance = (p.x - point.x) ** 2 + (p.y - point.y) ** 2;
        if (distance < Math.max(touch ? 19 : 9, radius(index) + 4) ** 2 && distance < nearest) { found = index; nearest = distance; }
      }
      return found;
    }
    function open(index: number) {
      const node = scene.nodes[index]; if (!node) return;
      if (node.type === 'card') propsRef.current.onCard(node.entityId);
      else if (node.type === 'project') propsRef.current.onProject(node.entityId);
      else propsRef.current.onTopic(node.entityId);
    }
    function draw() {
      frame = 0; if (destroyed || !visible || document.hidden) return;
      let moving = false;
      if (automaticView && !touched) {
        const deltaZoom = automaticView.zoom - view.zoom, dx = automaticView.pan.x - view.pan.x, dy = automaticView.pan.y - view.pan.y;
        if (Math.abs(deltaZoom) > 0.0001 || Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1) {
          const step = reduced ? 1 : 0.18;
          view = { zoom: view.zoom + deltaZoom * step, pan: { x: view.pan.x + dx * step, y: view.pan.y + dy * step } }; moving = true; publishZoom();
        } else { view = automaticView; automaticView = null; publishZoom(true); }
      }
      for (let index = 0; index < positions.length; index++) {
        if (protectedNode && Math.floor(index / 2) === protectedNode.index) continue;
        const delta = targets[index] - positions[index];
        if (Math.abs(delta) > 0.025) { positions[index] += reduced ? delta : delta * 0.38; moving = true; } else positions[index] = targets[index];
      }
      if (!dirty && !moving) return; dirty = false;
      context!.setTransform(ratio, 0, 0, ratio, 0, 0); context!.fillStyle = '#ffffff'; context!.fillRect(0, 0, width, height);
      const focus = gesture?.index !== undefined && gesture.index >= 0 ? gesture.index : hover >= 0 ? hover : keyboardIndex;
      const adjacent = focus >= 0 ? neighbors[focus] : null;
      const locations = scene.nodes.map((_, index) => screen(index));
      context!.lineWidth = Math.max(0.35, 0.65 * displayRef.current.lineScale);
      for (let pass = 0; pass < (focus >= 0 ? 2 : 1); pass++) {
        context!.beginPath(); context!.strokeStyle = focus < 0 ? '#d0d0d5' : pass ? '#a59acb' : '#ececef';
        for (const link of scene.links) {
          const active = link.source === focus || link.target === focus;
          if (focus >= 0 && Number(active) !== pass) continue;
          const a = locations[link.source], b = locations[link.target];
          if ((a.x < -10 && b.x < -10) || (a.x > width + 10 && b.x > width + 10) || (a.y < -10 && b.y < -10) || (a.y > height + 10 && b.y > height + 10)) continue;
          context!.moveTo(a.x, a.y); context!.lineTo(b.x, b.y);
        }
        context!.stroke();
      }
      const fontSize = Math.max(10, Math.min(22, 14 * Math.sqrt(view.zoom))) * displayRef.current.textScale;
      context!.font = `${fontSize}px Arial, "Microsoft YaHei", sans-serif`; context!.textAlign = 'center'; context!.textBaseline = 'top';
      const labelThreshold = Math.max(scene.nodes.length < 180 ? 0 : 0.65, displayRef.current.labelThreshold);
      const labelOpacity = Math.max(0, Math.min(1, (view.zoom - labelThreshold + 0.1) / 0.15));
      for (let index = 0; index < scene.nodes.length; index++) {
        const point = locations[index]; if (point.x < -180 || point.x > width + 180 || point.y < -60 || point.y > height + 80) continue;
        const focused = index === focus, linked = adjacent?.has(index), dim = focus >= 0 && !focused && !linked, size = radius(index);
        context!.fillStyle = focused ? '#8b6cef' : dim ? '#d7d7d7' : '#5c5c5c';
        context!.beginPath(); context!.arc(point.x, point.y, size, 0, Math.PI * 2); context!.fill();
        if (labelOpacity > 0 || scene.nodes[index].type === 'project' || focused || linked) {
          const opacity = focused || linked || scene.nodes[index].type === 'project' ? 1 : labelOpacity;
          context!.fillStyle = dim ? `rgba(160,160,160,${opacity * 0.5})` : `rgba(48,48,48,${opacity})`;
          const lines = labels[index]; for (let line = 0; line < lines.length; line++) context!.fillText(lines[line], point.x, point.y + size + 5 + line * fontSize * 1.25);
        }
      }
      if (moving) frame = requestAnimationFrame(draw);
    }
    function zoomBy(factor: number, point = { x: width / 2, y: height / 2 }) { touched = true; view = anchoredGraphViewport(view, view.zoom * factor, point); publishZoom(); requestDraw(); }
    api.current = { fit() { touched = true; fit(); }, zoom: zoomBy, restart() { post({ type: 'restart' }); }, draw: requestDraw, open };
    function resize() {
      const previousWidth = width, previousHeight = height, rect = host!.getBoundingClientRect();
      width = Math.max(1, rect.width); height = Math.max(1, rect.height); ratio = Math.min(2, window.devicePixelRatio || 1);
      canvas!.width = Math.round(width * ratio); canvas!.height = Math.round(height * ratio);
      if (firstSize) { firstSize = false; fit(); } else { view.pan.x += (width - previousWidth) / 2; view.pan.y += (height - previousHeight) / 2; }
      requestDraw();
    }
    function wheel(event: WheelEvent) { event.preventDefault(); event.stopPropagation(); view = anchoredGraphViewport(view, graphWheelZoom(view.zoom, event.deltaY, event.deltaMode, height), local(event)); touched = true; publishZoom(); requestDraw(); }
    function beginPinch() {
      if (gesture?.moved && gesture.index >= 0) releaseNode(gesture.index);
      gesture = null; const [a, b] = [...points.values()];
      pinch = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), midpoint: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, view: { zoom: view.zoom, pan: { ...view.pan } } };
    }
    function down(event: PointerEvent) {
      if (event.button !== 0) return;
      event.preventDefault(); canvas!.focus({ preventScroll: true }); canvas!.setPointerCapture(event.pointerId);
      const point = local(event); points.set(event.pointerId, point); touched = true;
      if (points.size >= 2) { beginPinch(); return; }
      const index = hit(point, event.pointerType === 'touch'), at = model(point);
      gesture = { pointerId: event.pointerId, index, start: point, last: point, moved: false, offset: index < 0 ? { x: 0, y: 0 } : { x: positions[index * 2] - at.x, y: positions[index * 2 + 1] - at.y } };
      canvas!.style.cursor = 'grabbing'; requestDraw();
    }
    function move(event: PointerEvent) {
      const point = local(event); if (points.has(event.pointerId)) points.set(event.pointerId, point);
      if (pinch && points.size >= 2) {
        const [a, b] = [...points.values()], midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        view = anchoredGraphViewport(pinch.view, pinch.view.zoom * Math.hypot(a.x - b.x, a.y - b.y) / pinch.distance, pinch.midpoint);
        view.pan.x += midpoint.x - pinch.midpoint.x; view.pan.y += midpoint.y - pinch.midpoint.y; publishZoom(); requestDraw(); return;
      }
      if (gesture && event.pointerId === gesture.pointerId) {
        if (Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y) > 4) gesture.moved = true;
        if (gesture.moved && gesture.index >= 0) {
          const at = model(point), index = gesture.index, x = at.x + gesture.offset.x, y = at.y + gesture.offset.y;
          positions[index * 2] = targets[index * 2] = x; positions[index * 2 + 1] = targets[index * 2 + 1] = y;
          protectedNode = { index, x, y, revision: ++revision, released: false };
          post({ type: 'drag', index, x, y, revision });
        } else if (gesture.moved) { view.pan.x += point.x - gesture.last.x; view.pan.y += point.y - gesture.last.y; }
        gesture.last = point; requestDraw(); return;
      }
      const next = hit(point); if (next !== hover) { hover = next; canvas!.style.cursor = next >= 0 ? 'pointer' : 'grab'; requestDraw(); }
    }
    function releaseNode(index: number) {
      const releaseRevision = ++revision;
      protectedNode = { index, x: positions[index * 2], y: positions[index * 2 + 1], revision: releaseRevision, released: true };
      post({ type: 'release', index, revision: releaseRevision });
      if (!worker) protectedNode = null;
    }
    function up(event: PointerEvent) {
      const cancelled = event.type === 'pointercancel' || event.type === 'lostpointercapture', wasPinching = pinch !== null; points.delete(event.pointerId);
      if (gesture?.pointerId === event.pointerId) {
        const completed = gesture; gesture = null;
        if (completed.index >= 0 && completed.moved) releaseNode(completed.index);
        else if (completed.index >= 0 && !cancelled && !pinch) open(completed.index);
      }
      if (points.size < 2) pinch = null;
      if (wasPinching && points.size === 1 && !cancelled) {
        const [pointerId, point] = [...points.entries()][0];
        gesture = { pointerId, index: -1, start: point, last: point, offset: { x: 0, y: 0 }, moved: true };
      }
      if (canvas!.hasPointerCapture(event.pointerId)) canvas!.releasePointerCapture(event.pointerId);
      hover = -1; canvas!.style.cursor = gesture ? 'grabbing' : 'grab'; requestDraw();
    }
    function leave() { if (!gesture) { hover = -1; canvas!.style.cursor = 'grab'; requestDraw(); } }
    function key(event: KeyboardEvent) {
      if (event.key === '+' || event.key === '=') zoomBy(1.2);
      else if (event.key === '-') zoomBy(1 / 1.2);
      else if (event.key === 'Home' || event.key === '0') { touched = true; fit(); }
      else if (event.key === 'Escape') { hover = keyboardIndex = -1; setKeyboardNode(''); setSettingsOpen(false); requestDraw(); }
      else if (event.key === '[' || event.key === ']') { if (!scene.nodes.length) return; keyboardIndex = (keyboardIndex + (event.key === ']' ? 1 : -1) + scene.nodes.length) % scene.nodes.length; setKeyboardNode(scene.nodes[keyboardIndex].label); requestDraw(); }
      else if (event.key === 'Enter' && keyboardIndex >= 0) open(keyboardIndex);
      else if (event.key.startsWith('Arrow')) { touched = true; view.pan.x += event.key === 'ArrowLeft' ? 40 : event.key === 'ArrowRight' ? -40 : 0; view.pan.y += event.key === 'ArrowUp' ? 40 : event.key === 'ArrowDown' ? -40 : 0; requestDraw(); }
      else return; event.preventDefault();
    }
    function cancelInteraction() {
      const active = gesture; gesture = null; pinch = null;
      if (active?.moved && active.index >= 0) releaseNode(active.index);
      for (const id of points.keys()) if (canvas!.hasPointerCapture(id)) canvas!.releasePointerCapture(id);
      points.clear(); hover = -1; canvas!.style.cursor = 'grab'; requestDraw();
    }
    function activity() { if (document.hidden || !visible) cancelInteraction(); post({ type: 'pause', paused: document.hidden || !visible }); if (document.hidden || !visible) { cancelAnimationFrame(frame); frame = 0; } else requestDraw(); }
    canvas.addEventListener('wheel', wheel, { passive: false }); canvas.addEventListener('pointerdown', down); canvas.addEventListener('pointermove', move); canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up); canvas.addEventListener('lostpointercapture', up); canvas.addEventListener('pointerleave', leave); canvas.addEventListener('keydown', key);
    document.addEventListener('visibilitychange', activity);
    window.addEventListener('blur', cancelInteraction);
    const resizeObserver = new ResizeObserver(resize); resizeObserver.observe(host);
    const observer = new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting ?? true; activity(); }); observer.observe(host);
    resize();
    if (scene.nodes.length) {
      try {
        worker = new Worker(new URL('./graph.worker.ts', import.meta.url), { type: 'module' }); workerRef.current = worker;
        worker.onmessage = (event: MessageEvent<GraphWorkerResponse>) => {
          if (destroyed || event.data.type !== 'positions' || event.data.positions.length !== positions.length) return;
          targets = event.data.positions;
          if (protectedNode?.released && event.data.revision >= protectedNode.revision) protectedNode = null;
          if (protectedNode) { targets[protectedNode.index * 2] = protectedNode.x; targets[protectedNode.index * 2 + 1] = protectedNode.y; }
          if (reduced) positions.set(targets);
          if (!initialFit && !touched) automaticView = fittedViewport(targets);
          if (event.data.settled) initialFit = true;
          requestDraw();
        };
        worker.onerror = () => { worker?.terminate(); worker = null; workerRef.current = null; protectedNode = null; targets.set(positions); setNotice('自动布局暂时不可用，仍可拖动和缩放。刷新页面可重试。'); };
        post({ type: 'init', scene, forces: forcesRef.current, reducedMotion: reduced }); activity();
      } catch { setNotice('自动布局暂时不可用，仍可拖动和缩放。刷新页面可重试。'); }
    }
    return () => {
      destroyed = true; cancelAnimationFrame(frame); window.clearTimeout(zoomTimer); worker?.terminate(); workerRef.current = null; resizeObserver.disconnect(); observer.disconnect();
      document.removeEventListener('visibilitychange', activity);
      window.removeEventListener('blur', cancelInteraction);
      canvas.removeEventListener('wheel', wheel); canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up); canvas.removeEventListener('pointercancel', up); canvas.removeEventListener('lostpointercapture', up); canvas.removeEventListener('pointerleave', leave); canvas.removeEventListener('keydown', key);
      api.current = idleControls;
    };
  }, [scene, reduced]);

  function setForce(key: keyof GraphForces, value: number) { setForces(previous => ({ ...previous, [key]: value })); }
  return <div className="obsidian-graph" ref={hostRef}>
    <canvas ref={canvasRef} className="obsidian-graph-canvas" tabIndex={0} role="img" aria-label="知识图谱。拖动节点调整布局，拖动空白移动画布，滚轮缩放，点击节点打开内容。" aria-describedby="graph-keyboard-help" />
    <p className="visually-hidden" id="graph-keyboard-help">方向键移动画布，加减号缩放，Home 显示全部。左右方括号选择节点，回车打开节点。也可以在图谱设置中搜索并打开问题。</p>
    <span className="visually-hidden" aria-live="polite">{keyboardNode}</span>
    <div className="obsidian-graph-scope"><select aria-label="图谱项目范围" value={projectId ?? ''} onChange={event => onScopeChange(event.target.value || undefined)}><option value="">全库图谱</option>{library.projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
    <div className="obsidian-graph-actions">
      <button type="button" title="显示全部节点" aria-label="适应图谱" onClick={() => api.current.fit()}><Maximize2 size={18} /></button>
      <button type="button" title="图谱设置" aria-label="图谱设置" aria-expanded={settingsOpen} aria-controls="graph-settings" onClick={() => setSettingsOpen(open => !open)}><Settings2 size={19} /></button>
    </div>
    {settingsOpen && <aside className="obsidian-graph-settings" id="graph-settings" aria-label="图谱设置">
      <header><strong>图谱设置</strong><button type="button" aria-label="关闭图谱设置" onClick={() => setSettingsOpen(false)}><X size={17} /></button></header>
      <details open><summary>筛选</summary><label className="obsidian-graph-search"><Search size={15} /><input aria-label="搜索图谱节点" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索节点…" /></label>
        {([['project', '项目'], ['card', '问题'], ['topic', '知识大类']] as const).map(([type, name]) => <label className="obsidian-graph-check" key={type}>{name}<input type="checkbox" checked={visibleTypes[type]} onChange={event => setVisibleTypes(old => ({ ...old, [type]: event.target.checked }))} /></label>)}
        {query.trim() && <div className="obsidian-graph-results">{scene.nodes.slice(0, 15).map((node, index) => <button key={node.id} type="button" onClick={() => api.current.open(index)}>{node.label}</button>)}{!scene.nodes.length && <p>没有匹配的节点</p>}</div>}
      </details>
      <details><summary>显示</summary>{([['nodeScale', '节点大小', 0.5, 2], ['textScale', '文字大小', 0.65, 1.8], ['lineScale', '连线粗细', 0.4, 3], ['labelThreshold', '文字淡化阈值', 0.15, 1.5]] as const).map(([key, name, min, max]) => <label className="obsidian-graph-range" key={key}><span>{name}</span><input type="range" aria-label={name} min={min} max={max} step="0.05" value={display[key]} onChange={event => setDisplay(old => ({ ...old, [key]: Number(event.target.value) }))} /></label>)}</details>
      <details><summary>力</summary>{([['centerForce', '向心力', 0, 0.15, 0.005], ['repelForce', '斥力', 20, 700, 10], ['linkForce', '连线强度', 0.01, 1, 0.01], ['linkDistance', '连线距离', 40, 260, 5]] as const).map(([key, name, min, max, step]) => <label className="obsidian-graph-range" key={key}><span>{name}</span><input type="range" aria-label={name} min={min} max={max} step={step} value={forces[key]} onChange={event => setForce(key, Number(event.target.value))} /></label>)}<button className="obsidian-graph-restart" type="button" onClick={() => api.current.restart()}><RotateCcw size={14} />重新布局</button></details>
      <button type="button" className="obsidian-graph-reset" onClick={() => { setQuery(''); setVisibleTypes({ project: true, card: true, topic: true }); setDisplay(defaults); setForces(defaultGraphForces); }}>恢复默认设置</button>
    </aside>}
    <div className="obsidian-graph-zoom"><button aria-label="缩小图谱" title="缩小" onClick={() => api.current.zoom(1 / 1.2)}><Minus size={15} /></button><output aria-label={`当前缩放 ${zoom}%`}>{zoom}%</output><button aria-label="放大图谱" title="放大" onClick={() => api.current.zoom(1.2)}><Plus size={15} /></button></div>
    {!scene.nodes.length && <div className="obsidian-graph-empty"><p>{query || !Object.values(visibleTypes).every(Boolean) ? '没有匹配的节点' : '这里还没有可展示的问题'}</p><span>{query ? '试试其他关键词，或清空筛选。' : '添加问题后，就能看到它们之间的连接。'}</span></div>}
    {notice && <p className="obsidian-graph-notice" role="status">{notice}</p>}
  </div>;
}
