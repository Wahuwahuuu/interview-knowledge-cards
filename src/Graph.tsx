import { useEffect, useRef, useState } from 'react';
import cytoscape, { type Core } from 'cytoscape';
import { Focus, Maximize2, Minus, Plus } from 'lucide-react';
import { graphElements, type Library } from '../shared/model';

export function Graph({ library, projectId, onCard, onProject, onTopic }: { library: Library; projectId?: string; onCard: (id: string) => void; onProject: (id: string) => void; onTopic: (id: string) => void }) {
  const container = useRef<HTMLDivElement>(null), instance = useRef<Core | null>(null);
  const [focus, setFocus] = useState(''), [entity, setEntity] = useState<{ id: string; type: string } | null>(null);
  useEffect(() => {
    if (!container.current) return;
    setFocus(''); setEntity(null);
    const cy = cytoscape({
      container: container.current, elements: graphElements(library, projectId), minZoom: 0.25, maxZoom: 3, wheelSensitivity: 0.2,
      style: [
        { selector: 'node', style: { 'background-color': '#758b79', 'label': 'data(label)', 'font-size': 13, 'font-family': 'system-ui, sans-serif', 'color': '#283f33', 'text-valign': 'bottom', 'text-margin-y': 9, 'text-wrap': 'wrap', 'text-max-width': '140px', 'text-background-color': '#fdfef9', 'text-background-opacity': 0.9, 'text-background-padding': '3px', 'width': 32, 'height': 32, 'border-width': 3, 'border-color': '#f7f8f1' } },
        { selector: 'node[type="project"]', style: { 'background-color': '#294c3a', 'width': 56, 'height': 56, 'font-weight': 700, 'font-size': 15 } },
        { selector: 'node[type="card"]', style: { 'background-color': '#d7ac54', 'width': 40, 'height': 40, 'shape': 'round-rectangle' } },
        { selector: 'node[type="topic"]', style: { 'background-color': '#98abbd', 'width': 23, 'height': 23, 'font-size': 12 } },
        { selector: 'edge', style: { 'line-color': '#ccd4c5', 'width': 1.5, 'curve-style': 'bezier' } },
        { selector: 'edge[kind="followup"]', style: { 'target-arrow-shape': 'triangle', 'target-arrow-color': '#986d22', 'line-color': '#b78937', 'width': 2.5, 'label': 'data(label)', 'font-size': 11, 'color': '#986d22', 'text-background-color': '#f7f8f1', 'text-background-opacity': 1, 'text-background-padding': '3px' } },
        { selector: 'edge[kind="related"]', style: { 'line-style': 'dashed', 'line-color': '#71858f', 'label': 'data(label)', 'font-size': 11 } },
        { selector: '.dim', style: { 'opacity': 0.15 } },
        { selector: '.focus', style: { 'border-width': 5, 'border-color': '#e5b852' } },
      ],
      layout: { name: 'cose', animate: false, padding: 60, nodeDimensionsIncludeLabels: true, nodeRepulsion: () => 120000, idealEdgeLength: () => 150, gravity: 0.15, randomize: true, numIter: 1200 },
    });
    instance.current = cy;
    cy.on('tap', 'node', event => {
      const node = event.target;
      cy.elements().removeClass('dim focus'); cy.elements().addClass('dim'); node.closedNeighborhood().removeClass('dim'); node.addClass('focus');
      setFocus(String(node.data('label'))); setEntity({ id: String(node.data('entity_id')), type: String(node.data('type')) });
    });
    cy.on('tap', event => { if (event.target === cy) { cy.elements().removeClass('dim focus'); setFocus(''); setEntity(null); } });
    const resize = new ResizeObserver(() => { cy.resize(); cy.fit(undefined, 55); }); resize.observe(container.current);
    return () => { resize.disconnect(); cy.destroy(); instance.current = null; };
  }, [library, projectId]);
  function open() { if (entity?.type === 'card') onCard(entity.id); else if (entity?.type === 'project') onProject(entity.id); else if (entity) onTopic(entity.id); }
  return <div className="graph-wrap">
    <div className="graph-legend"><span><i className="dot project-dot" />项目</span><span><i className="dot card-dot" />问题</span><span><i className="dot topic-dot" />知识点</span><span className="muted">箭头表示追问</span></div>
    <div ref={container} className="graph-canvas" aria-label="项目、问题和知识点的交互关系图" />
    <div className="graph-controls"><button aria-label="放大图谱" onClick={() => instance.current?.zoom(instance.current.zoom() * 1.25)}><Plus size={18} /></button><button aria-label="缩小图谱" onClick={() => instance.current?.zoom(instance.current.zoom() / 1.25)}><Minus size={18} /></button><button aria-label="适应图谱" onClick={() => instance.current?.fit(undefined, 45)}><Maximize2 size={17} /></button><button aria-label="取消图谱聚焦" onClick={() => { instance.current?.elements().removeClass('dim focus'); setFocus(''); setEntity(null); }}><Focus size={17} /></button></div>
    <div className="graph-caption">{focus ? <><span>{focus}</span><button className="text-button" onClick={open}>打开{entity?.type === 'card' ? '卡片' : entity?.type === 'project' ? '项目' : '相关问题'} →</button></> : <span>点击一个节点，沿着关联复习。拖动节点可整理视图。</span>}</div>
  </div>;
}
