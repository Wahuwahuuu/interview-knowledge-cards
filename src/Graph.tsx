import { useEffect, useMemo, useRef, useState } from 'react';
import cytoscape, { type Core, type NodeSingular } from 'cytoscape';
import { Focus, Maximize2, Minus, Pause, Play, Plus } from 'lucide-react';
import { graphElements, type Library } from '../shared/model';
import { anchoredGraphViewport, graphWheelZoom, graphZoomLimits } from '../shared/graph-viewport';

export function Graph({ library, projectId, onCard, onProject, onTopic }: { library: Library; projectId?: string; onCard: (id: string) => void; onProject: (id: string) => void; onTopic: (id: string) => void }) {
  const wrapper = useRef<HTMLDivElement>(null), container = useRef<HTMLDivElement>(null), instance = useRef<Core | null>(null);
  const clearSelection = useRef(() => {}), updateMotion = useRef(() => {}), stabilizeLayout = useRef(() => {}), motionWanted = useRef(true);
  const [focus, setFocus] = useState(''), [entity, setEntity] = useState<{ id: string; type: string } | null>(null);
  const [motionEnabled, setMotionEnabled] = useState(true), [reducedMotion, setReducedMotion] = useState(false), [zoom, setZoom] = useState(100);
  const elements = useMemo(() => graphElements(library, projectId), [library, projectId]);
  const empty = elements.length === 0;
  const large = useMemo(() => elements.reduce((count, element) => count + ('type' in element.data ? 1 : 0), 0) > 300, [elements]);

  useEffect(() => {
    const canvas = container.current, wrap = wrapper.current;
    setFocus(''); setEntity(null);
    if (!canvas || !wrap || empty) return;
    let destroyed = false, selected = false, hovering = false, pressing = false, wheeling = false, inView = true, layoutReady = false, viewportTouched = false;
    let animationId = 0, wheelTimer = 0, lastFrame = 0, elapsed = 0;
    let anchors: { node: NodeSingular; x: number; y: number; phase: number; amplitude: number }[] = [];
    let interruptedPositions: { node: NodeSingular; position: { x: number; y: number } }[] | null = null;
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reduced = preference.matches;
    setReducedMotion(reduced);
    const cy = cytoscape({
      container: canvas, elements, minZoom: graphZoomLimits.min, maxZoom: graphZoomLimits.max,
      autoungrabify: true, autounselectify: true, userPanningEnabled: true, userZoomingEnabled: true,
      style: [
        { selector: 'node', style: { 'background-color': '#758b79', 'label': 'data(label)', 'font-size': 13, 'font-family': 'system-ui, sans-serif', 'color': '#283f33', 'text-valign': 'bottom', 'text-margin-y': 9, 'text-wrap': 'wrap', 'text-max-width': '140px', 'text-background-color': '#fdfef9', 'text-background-opacity': 0.9, 'text-background-padding': '3px', 'width': 32, 'height': 32, 'border-width': 3, 'border-color': '#f7f8f1' } },
        { selector: 'node[type="project"]', style: { 'background-color': '#294c3a', 'width': 56, 'height': 56, 'font-weight': 700, 'font-size': 15 } },
        { selector: 'node[type="card"]', style: { 'background-color': '#d7ac54', 'width': 40, 'height': 40, 'shape': 'round-rectangle' } },
        { selector: 'node[type="topic"]', style: { 'background-color': '#98abbd', 'width': 23, 'height': 23, 'font-size': 12 } },
        { selector: 'edge', style: { 'line-color': '#ccd4c5', 'width': 1.5, 'curve-style': 'bezier', 'line-opacity': 0.78 } },
        { selector: 'edge[kind="followup"]', style: { 'target-arrow-shape': 'triangle', 'target-arrow-color': '#986d22', 'line-color': '#b78937', 'width': 2.5, 'label': 'data(label)', 'font-size': 11, 'color': '#986d22', 'text-background-color': '#f7f8f1', 'text-background-opacity': 1, 'text-background-padding': '3px' } },
        { selector: 'edge[kind="related"]', style: { 'line-style': 'dashed', 'line-color': '#71858f', 'label': 'data(label)', 'font-size': 11 } },
        { selector: '.dim', style: { 'opacity': 0.15 } },
        { selector: '.focus', style: { 'border-width': 5, 'border-color': '#e5b852' } },
      ],
      layout: { name: 'circle', padding: 65, avoidOverlap: true },
    });
    instance.current = cy;
    cy.nodes().ungrabify();
    setZoom(Math.round(cy.zoom() * 100));

    function canAnimate() { return !destroyed && !large && layoutReady && motionWanted.current && !reduced && !document.hidden && inView && !selected && !hovering && !pressing && !wheeling; }
    function frame(now: number) {
      animationId = 0;
      if (!canAnimate()) { lastFrame = 0; return; }
      if (!lastFrame) lastFrame = now;
      const delta = now - lastFrame;
      if (delta >= 1000 / 30) {
        elapsed += Math.min(delta, 70); lastFrame = now;
        const time = elapsed / 1000;
        cy.batch(() => {
          for (const anchor of anchors) {
            const { node, x, y, phase, amplitude } = anchor;
            node.position({ x: x + (Math.sin(time * 0.55 + phase) - Math.sin(phase)) * amplitude, y: y + (Math.cos(time * 0.43 + phase) - Math.cos(phase)) * amplitude * 0.7 });
          }
          cy.edges().style('line-opacity', 0.78 + Math.sin(time * 0.7) * 0.1);
        });
      }
      animationId = requestAnimationFrame(frame);
    }
    function syncMotion() {
      if (animationId) { cancelAnimationFrame(animationId); animationId = 0; }
      lastFrame = 0;
      if (canAnimate()) animationId = requestAnimationFrame(frame);
    }
    updateMotion.current = syncMotion;
    clearSelection.current = () => {
      cy.elements().removeClass('dim focus'); selected = false;
      setFocus(''); setEntity(null); syncMotion();
    };
    cy.on('tap', 'node', event => {
      const node = event.target;
      cy.elements().removeClass('dim focus'); cy.elements().addClass('dim'); node.closedNeighborhood().removeClass('dim'); node.addClass('focus');
      selected = true; syncMotion();
      setFocus(String(node.data('label'))); setEntity({ id: String(node.data('entity_id')), type: String(node.data('type')) });
    });
    cy.on('tap', event => { if (event.target === cy) clearSelection.current(); });
    cy.on('mouseover', 'node', () => { hovering = true; syncMotion(); });
    cy.on('mouseout', 'node', () => { hovering = false; syncMotion(); });
    cy.on('zoom', () => { viewportTouched = true; setZoom(Math.round(cy.zoom() * 100)); });
    cy.on('pan', () => { viewportTouched = true; });

    function pointerDown() { pressing = true; stabilizeLayout.current(); syncMotion(); }
    function pointerUp() { pressing = false; syncMotion(); }
    function pointerLeave() { hovering = false; syncMotion(); }
    function visibilityChange() { syncMotion(); }
    function preferenceChange() { reduced = preference.matches; setReducedMotion(reduced); syncMotion(); }
    function wheel(event: WheelEvent) {
      if (!(event.target instanceof Node) || !canvas!.contains(event.target)) return;
      // Wrapper capture precedes the renderer: wheel zoom runs once, native pinch remains available.
      event.preventDefault(); event.stopImmediatePropagation();
      if (!event.deltaY) return;
      wheeling = true; stabilizeLayout.current();
      const rect = canvas!.getBoundingClientRect();
      const target = graphWheelZoom(cy.zoom(), event.deltaY, event.deltaMode, rect.height);
      cy.viewport(anchoredGraphViewport({ zoom: cy.zoom(), pan: cy.pan() }, target, { x: event.clientX - rect.left, y: event.clientY - rect.top }));
      syncMotion();
      window.clearTimeout(wheelTimer);
      wheelTimer = window.setTimeout(() => { wheeling = false; syncMotion(); }, 180);
    }
    canvas.addEventListener('pointerdown', pointerDown); canvas.addEventListener('pointerleave', pointerLeave);
    window.addEventListener('pointerup', pointerUp); window.addEventListener('pointercancel', pointerUp);
    wrap.addEventListener('wheel', wheel, { capture: true, passive: false });
    document.addEventListener('visibilitychange', visibilityChange); preference.addEventListener('change', preferenceChange);
    const intersection = new IntersectionObserver(entries => { inView = entries[0]?.isIntersecting ?? true; syncMotion(); }); intersection.observe(canvas);
    const resize = new ResizeObserver(() => { cy.resize(); }); resize.observe(canvas);

    // Calculate in small batches, then fit once unless the user already moved the viewport.
    // Large libraries keep the initial linear-time circle layout and skip continuous redraws.
    const layout = large ? null : cy.layout({ name: 'cose', animate: true, animationThreshold: Number.POSITIVE_INFINITY, refresh: 4, fit: false, padding: 65, nodeDimensionsIncludeLabels: true, nodeRepulsion: () => 6000, idealEdgeLength: () => 100, gravity: 0.6, randomize: true, numIter: 450, initialTemp: 300, coolingFactor: 0.985 });
    function finishLayout() {
      if (destroyed || layoutReady) return;
      anchors = cy.nodes().map((node, index) => ({ node, ...node.position(), phase: index * 2.39996, amplitude: node.data('type') === 'project' ? 3 : 7 + index % 4 }));
      layoutReady = true;
      if (!viewportTouched) cy.fit(undefined, 65);
      syncMotion();
    }
    layout?.on('layoutstop', () => {
      if (destroyed) return;
      // CoSE may publish one final update after stop(); keep the user's current scene stable.
      if (interruptedPositions) cy.batch(() => { for (const { node, position } of interruptedPositions!) node.position(position); });
      finishLayout();
    });
    stabilizeLayout.current = () => {
      if (!layout || layoutReady || destroyed) return;
      viewportTouched = true;
      interruptedPositions = cy.nodes().map(node => ({ node, position: { ...node.position() } }));
      layout.stop();
    };
    layout?.run();
    return () => {
      destroyed = true; layout?.stop();
      cancelAnimationFrame(animationId); window.clearTimeout(wheelTimer);
      resize.disconnect(); intersection.disconnect();
      canvas.removeEventListener('pointerdown', pointerDown); canvas.removeEventListener('pointerleave', pointerLeave);
      window.removeEventListener('pointerup', pointerUp); window.removeEventListener('pointercancel', pointerUp);
      wrap.removeEventListener('wheel', wheel, true);
      document.removeEventListener('visibilitychange', visibilityChange); preference.removeEventListener('change', preferenceChange);
      updateMotion.current = () => {}; clearSelection.current = () => {}; stabilizeLayout.current = () => {};
      cy.destroy(); instance.current = null;
    };
  }, [elements, empty, large]);

  function zoomBy(factor: number) {
    stabilizeLayout.current();
    const cy = instance.current;
    if (cy) cy.viewport(anchoredGraphViewport({ zoom: cy.zoom(), pan: cy.pan() }, cy.zoom() * factor, { x: cy.width() / 2, y: cy.height() / 2 }));
  }
  function toggleMotion() { stabilizeLayout.current(); motionWanted.current = !motionWanted.current; setMotionEnabled(motionWanted.current); updateMotion.current(); }
  function open() { if (entity?.type === 'card') onCard(entity.id); else if (entity?.type === 'project') onProject(entity.id); else if (entity) onTopic(entity.id); }
  return <div ref={wrapper} className="graph-wrap">
    <div className="graph-toolbar">
      <div className="graph-legend"><span><i className="dot project-dot" />项目</span><span><i className="dot card-dot" />问题</span><span><i className="dot topic-dot" />知识点</span><span className="muted">箭头表示追问</span></div>
      <div className="graph-controls">
        <button aria-label="缩小图谱" title="缩小图谱" disabled={empty} onClick={() => zoomBy(1 / 1.25)}><Minus size={18} /></button>
        <output className="graph-zoom-label" aria-live="off" aria-label={`当前缩放 ${zoom}%`}>{zoom}%</output>
        <button aria-label="放大图谱" title="放大图谱" disabled={empty} onClick={() => zoomBy(1.25)}><Plus size={18} /></button>
        <button aria-label="适应图谱" title="适应图谱" disabled={empty} onClick={() => { stabilizeLayout.current(); instance.current?.fit(undefined, 65); }}><Maximize2 size={17} /></button>
        <button aria-label="取消图谱聚焦" title="取消图谱聚焦" disabled={!entity} onClick={() => clearSelection.current()}><Focus size={17} /></button>
        <button className="graph-motion-toggle" aria-pressed={motionEnabled && !reducedMotion && !large} aria-label={large ? '题库较大，静态显示' : reducedMotion ? '系统已减少动态' : motionEnabled ? '暂停动态' : '开启动态'} title={large ? '可选择单个题库查看动态' : reducedMotion ? '系统已开启减少动态' : undefined} disabled={empty || reducedMotion || large} onClick={toggleMotion}>{motionEnabled && !reducedMotion && !large ? <Pause size={16} /> : <Play size={16} />}<span>{large ? '题库较大，静态显示' : reducedMotion ? '静态显示' : motionEnabled ? '暂停动态' : '开启动态'}</span></button>
      </div>
    </div>
    {empty ? <div className="graph-empty"><p>这里还没有可展示的问题。</p><span>添加问题后，项目和知识点的关联会出现在这里。</span></div> : <div ref={container} className="graph-canvas" tabIndex={0} role="img" aria-label="项目、问题和知识点的交互关系图。滚轮缩放，拖动空白区域平移，点击节点查看关联。" onKeyDown={event => {
      const cy = instance.current; if (!cy) return;
      if (!['+', '=', '-', 'Home', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      stabilizeLayout.current();
      if (event.key === '+' || event.key === '=') zoomBy(1.25);
      else if (event.key === '-') zoomBy(1 / 1.25);
      else if (event.key === 'Home') cy.fit(undefined, 65);
      else if (event.key === 'Escape') clearSelection.current();
      else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) cy.panBy({ x: event.key === 'ArrowLeft' ? 40 : event.key === 'ArrowRight' ? -40 : 0, y: event.key === 'ArrowUp' ? 40 : event.key === 'ArrowDown' ? -40 : 0 });
      else return;
      event.preventDefault();
    }} />}
    {!empty && <div className="graph-caption">{focus ? <><span>{focus}</span><button className="text-button" onClick={open}>打开{entity?.type === 'card' ? '卡片' : entity?.type === 'project' ? '项目' : '相关问题'} →</button></> : <span>滚轮缩放 · 拖动空白处平移 · 点击节点查看关联</span>}</div>}
  </div>;
}
