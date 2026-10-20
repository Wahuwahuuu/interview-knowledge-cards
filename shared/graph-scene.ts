import type { Library } from './model';

export type GraphNodeType = 'project' | 'card' | 'topic';
export interface GraphSceneNode {
  id: string;
  entityId: string;
  type: GraphNodeType;
  label: string;
  radius: number;
  degree: number;
  x: number;
  y: number;
}
export interface GraphSceneLink { source: number; target: number }
export interface GraphScene { nodes: GraphSceneNode[]; links: GraphSceneLink[] }
export interface GraphForces {
  centerForce: number;
  repelForce: number;
  linkForce: number;
  linkDistance: number;
}
export const defaultGraphForces: GraphForces = { centerForce: 0.08, repelForce: 260, linkForce: 0.12, linkDistance: 150 };
export type GraphWorkerRequest =
  | { type: 'init'; scene: GraphScene; forces?: Partial<GraphForces>; reducedMotion?: boolean }
  | { type: 'drag'; index: number; x: number; y: number; revision?: number }
  | { type: 'release'; index: number; revision?: number }
  | { type: 'pause'; paused: boolean }
  | { type: 'restart' }
  | { type: 'forces'; forces: Partial<GraphForces> };
export type GraphWorkerResponse = { type: 'positions'; positions: Float32Array; settled: boolean; revision: number };

const goldenAngle = Math.PI * (3 - Math.sqrt(5));
const byId = <T extends { id: string }>(a: T, b: T) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const phyllotaxis = (index: number, spacing: number) => {
  const angle = index * goldenAngle, distance = spacing * Math.sqrt(index + 0.5);
  return { x: Math.cos(angle) * distance, y: Math.sin(angle) * distance };
};

/** Build a plain, stable, transferable scene; only visible cards contribute links. */
export function buildGraphScene(library: Library, projectId?: string): GraphScene {
  const cards = library.cards.filter(card => !card.archived && (!projectId || card.project_id === projectId)).sort(byId);
  const projectIds = new Set(cards.map(card => card.project_id));
  const topicIds = new Set(cards.flatMap(card => card.topic_ids));
  const projects = library.projects.filter(project => projectIds.has(project.id)).sort(byId);
  const topics = library.topics.filter(topic => topicIds.has(topic.id)).sort(byId);
  const nodes: GraphSceneNode[] = [], links: GraphSceneLink[] = [], indices = new Map<string, number>();
  const projectPositions = new Map<string, { x: number; y: number }>();
  const groupSpacing = Math.max(210, Math.sqrt(cards.length / Math.max(1, projects.length)) * 35);
  const addNode = (type: GraphNodeType, entityId: string, label: string, position: { x: number; y: number }) => {
    const id = `${type[0]}:${entityId}`;
    indices.set(id, nodes.length);
    nodes.push({ id, entityId, type, label, radius: 4.8, degree: 0, ...position });
  };
  projects.forEach((project, index) => {
    const position = projects.length === 1 ? { x: 0, y: 0 } : phyllotaxis(index, groupSpacing);
    projectPositions.set(project.id, position);
    addNode('project', project.id, project.name, position);
  });
  const groupCounts = new Map<string, number>();
  for (const card of cards) {
    const count = groupCounts.get(card.project_id) ?? 0;
    groupCounts.set(card.project_id, count + 1);
    const center = projectPositions.get(card.project_id) ?? { x: 0, y: 0 }, offset = phyllotaxis(count, 32);
    addNode('card', card.id, card.title, { x: center.x + offset.x, y: center.y + offset.y });
  }
  const topicCenters = new Map<string, { x: number; y: number; count: number }>();
  for (const card of cards) {
    const node = nodes[indices.get(`c:${card.id}`)!];
    for (const topicId of new Set(card.topic_ids)) {
      const center = topicCenters.get(topicId) ?? { x: 0, y: 0, count: 0 };
      center.x += node.x; center.y += node.y; center.count += 1;
      topicCenters.set(topicId, center);
    }
  }
  topics.forEach((topic, index) => {
    const center = topicCenters.get(topic.id)!, offset = phyllotaxis(index, 48);
    addNode('topic', topic.id, topic.name, { x: center.x / center.count + offset.x, y: center.y / center.count + offset.y });
  });
  const pairs = new Set<string>();
  const addLink = (sourceId: string, targetId: string) => {
    const source = indices.get(sourceId), target = indices.get(targetId);
    if (source === undefined || target === undefined || source === target) return;
    const key = source < target ? `${source}:${target}` : `${target}:${source}`;
    if (pairs.has(key)) return;
    pairs.add(key); links.push({ source, target });
    nodes[source].degree += 1; nodes[target].degree += 1;
  };
  for (const card of cards) {
    addLink(`p:${card.project_id}`, `c:${card.id}`);
    for (const topicId of card.topic_ids) addLink(`c:${card.id}`, `t:${topicId}`);
  }
  for (const relation of [...library.relations].sort(byId)) addLink(`c:${relation.from_card_id}`, `c:${relation.to_card_id}`);
  for (const node of nodes) node.radius = Math.min(16, 5.8 + Math.sqrt(node.degree) * 1.2);
  return { nodes, links };
}

/** Finite force settings protect the simulation from malformed input. */
export function normalizeGraphForces(options: Partial<GraphForces>, current = defaultGraphForces): GraphForces {
  const number = (key: keyof GraphForces, min: number, max: number) => Number.isFinite(options[key]) ? Math.max(min, Math.min(max, options[key]!)) : current[key];
  return { centerForce: number('centerForce', 0, 0.3), repelForce: number('repelForce', 0, 3000), linkForce: number('linkForce', 0, 1), linkDistance: number('linkDistance', 10, 500) };
}
