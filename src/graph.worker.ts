import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationNodeDatum, type SimulationLinkDatum } from 'd3-force';
import { defaultGraphForces, normalizeGraphForces, type GraphForces, type GraphSceneNode, type GraphWorkerRequest, type GraphWorkerResponse } from '../shared/graph-scene';

interface PhysicalNode extends SimulationNodeDatum { radius: number; x: number; y: number }
interface PhysicalLink extends SimulationLinkDatum<PhysicalNode> { source: number | PhysicalNode; target: number | PhysicalNode }
const endpoint = globalThis as unknown as {
  onmessage: ((event: MessageEvent<GraphWorkerRequest>) => void) | null;
  postMessage: (message: GraphWorkerResponse, transfer: Transferable[]) => void;
};
const frameInterval = 1000 / 30;
let simulation: Simulation<PhysicalNode, PhysicalLink> | null = null;
let nodes: PhysicalNode[] = [], links: PhysicalLink[] = [], settings: GraphForces = { ...defaultGraphForces };
let timer: ReturnType<typeof setTimeout> | undefined, paused = false, held = new Set<number>(), reducedMotion = false;
let lastFrameAt = -Infinity, lastInteractionRevision = 0;

function sendPositions(settled: boolean) {
  const positions = new Float32Array(nodes.length * 2);
  nodes.forEach((node, index) => { positions[index * 2] = node.x; positions[index * 2 + 1] = node.y; });
  endpoint.postMessage({ type: 'positions', positions, settled, revision: lastInteractionRevision }, [positions.buffer]);
}
function schedule() {
  if (!simulation || paused || timer !== undefined) return;
  timer = setTimeout(frame, Math.ceil(Math.max(0, frameInterval - (performance.now() - lastFrameAt))));
}
function frame() {
  timer = undefined;
  if (!simulation || paused) return;
  const startedAt = performance.now();
  // A single Barnes–Hut tick cannot be interrupted; never queue more than two.
  for (let tick = 0; tick < 2; tick++) {
    simulation.tick();
    if (performance.now() - startedAt >= 16 || simulation.alpha() <= simulation.alphaMin()) break;
  }
  const settled = held.size === 0 && simulation.alpha() <= simulation.alphaMin();
  lastFrameAt = performance.now();
  if (!reducedMotion || held.size || settled) sendPositions(settled);
  if (!settled) schedule();
}
function cancelFrame() { if (timer !== undefined) clearTimeout(timer); timer = undefined; }
function configureForces() {
  if (!simulation) return;
  simulation
    .force('charge', forceManyBody<PhysicalNode>().strength(-settings.repelForce).theta(0.9).distanceMin(8))
    .force('link', forceLink<PhysicalNode, PhysicalLink>(links).distance(settings.linkDistance).strength(settings.linkForce).iterations(1))
    .force('x', forceX<PhysicalNode>(0).strength(settings.centerForce))
    .force('y', forceY<PhysicalNode>(0).strength(settings.centerForce))
    .force('collide', forceCollide<PhysicalNode>().radius(node => node.radius + 8).strength(0.7).iterations(1));
}
function reheat(alpha = 0.35) {
  if (!simulation || !nodes.length) return;
  simulation.alpha(Math.max(alpha, simulation.alpha()));
  schedule();
}
function physicalNode(node: GraphSceneNode): PhysicalNode {
  return { radius: node.radius, x: node.x, y: node.y, vx: 0, vy: 0 };
}
function acknowledge(revision?: number) {
  if (revision !== undefined && Number.isFinite(revision)) lastInteractionRevision = Math.max(lastInteractionRevision, Math.floor(revision));
}
endpoint.onmessage = ({ data: message }) => {
  switch (message.type) {
    case 'init': {
      cancelFrame(); simulation?.stop(); held = new Set(); paused = false;
      lastInteractionRevision = 0; reducedMotion = Boolean(message.reducedMotion); lastFrameAt = performance.now();
      settings = normalizeGraphForces(message.forces ?? {});
      nodes = message.scene.nodes.map(physicalNode);
      links = message.scene.links.map(link => ({ ...link }));
      simulation = forceSimulation<PhysicalNode>(nodes).stop().velocityDecay(0.4).alphaDecay(message.reducedMotion ? 0.07 : 0.035).alphaMin(0.004);
      configureForces();
      if (!nodes.length) simulation.alpha(0);
      sendPositions(nodes.length === 0);
      if (nodes.length) schedule();
      break;
    }
    case 'drag': {
      const node = nodes[message.index];
      if (!node || !Number.isFinite(message.x) || !Number.isFinite(message.y)) break;
      acknowledge(message.revision);
      held.add(message.index); node.fx = node.x = message.x; node.fy = node.y = message.y; node.vx = node.vy = 0;
      simulation?.alphaTarget(0.12); reheat(0.22);
      break;
    }
    case 'release': {
      const node = nodes[message.index];
      if (!node) break;
      acknowledge(message.revision);
      held.delete(message.index); node.fx = node.fy = null;
      simulation?.alphaTarget(held.size ? 0.12 : 0); reheat(0.25);
      break;
    }
    case 'pause': paused = message.paused; if (paused) cancelFrame(); else if (simulation && (held.size || simulation.alpha() > simulation.alphaMin())) schedule(); break;
    case 'restart': reheat(0.7); break;
    case 'forces': settings = normalizeGraphForces(message.forces, settings); configureForces(); reheat(0.45); break;
  }
};
