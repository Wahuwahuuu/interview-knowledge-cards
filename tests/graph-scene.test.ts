import { describe, expect, it, vi } from 'vitest';
import { buildGraphScene, defaultGraphForces, normalizeGraphForces, type GraphWorkerRequest, type GraphWorkerResponse } from '../shared/graph-scene';
import { emptyLibrary, importSchema, prepareImport } from '../shared/model';

function fixture() {
  return prepareImport(emptyLibrary(), importSchema.parse({ schema_version: 1,
    projects: [{ id: 'p1', name: '主项目' }, { id: 'p2', name: '独立项目' }, { id: 'empty', name: '空项目' }],
    topics: [{ id: 't1', name: '共享知识点' }, { id: 'unused', name: '未使用知识点' }],
    cards: [
      { id: 'c1', project_id: 'p1', title: '这是一道需要保留完整长标题的问题，不应在构图时被截断', question: '问题', topic_ids: ['t1'] },
      { id: 'c2', project_id: 'p1', title: '第二问', question: '问题' },
      { id: 'c3', project_id: 'p2', title: '独立问题', question: '问题', topic_ids: ['t1'] },
      { id: 'archived', project_id: 'p1', title: '归档问题', question: '问题', archived: true },
    ],
    relations: [{ id: 'r1', from_card_id: 'c1', to_card_id: 'c2', kind: 'followup' }, { id: 'r2', from_card_id: 'c1', to_card_id: 'c3', kind: 'related' }],
  }));
}

describe('Canvas 图谱场景', () => {
  it('按题库过滤归档问题和跨题库关系，保留完整标题及实际引用的知识点', () => {
    const library = fixture(), scene = buildGraphScene(library, 'p1');
    expect(scene.nodes.map(node => node.id)).toEqual(['p:p1', 'c:c1', 'c:c2', 't:t1']);
    expect(scene.nodes.find(node => node.id === 'c:c1')?.label).toBe(library.cards[0].title);
    expect(scene.links).toHaveLength(4);
  });
  it('所有连线使用有效数字索引，节点半径由真实度数决定且受限', () => {
    const scene = buildGraphScene(fixture());
    const degrees = scene.nodes.map(() => 0);
    for (const { source, target } of scene.links) {
      expect(scene.nodes[source]).toBeDefined(); expect(scene.nodes[target]).toBeDefined();
      expect(source).not.toBe(target); degrees[source]++; degrees[target]++;
    }
    scene.nodes.forEach((node, index) => { expect(node.degree).toBe(degrees[index]); expect(node.radius).toBeGreaterThanOrEqual(5.8); expect(node.radius).toBeLessThanOrEqual(16); });
  });
  it('空题库和完全空库没有幽灵节点或连线', () => {
    expect(buildGraphScene(emptyLibrary())).toEqual({ nodes: [], links: [] });
    expect(buildGraphScene(fixture(), 'empty')).toEqual({ nodes: [], links: [] });
    expect(buildGraphScene(fixture(), 'missing')).toEqual({ nodes: [], links: [] });
  });
  it('无知识点和追问的独立题库仍显示项目连接，初始位置有限且确定', () => {
    const library = fixture(); library.cards = library.cards.map(card => ({ ...card, topic_ids: [] })); library.relations = [];
    const first = buildGraphScene(library), second = buildGraphScene({ ...library, cards: [...library.cards].reverse(), projects: [...library.projects].reverse() });
    expect(first).toEqual(second);
    expect(first.links).toHaveLength(3);
    for (const node of first.nodes) { expect(Number.isFinite(node.x)).toBe(true); expect(Number.isFinite(node.y)).toBe(true); }
    expect(new Set(first.nodes.map(node => `${node.x},${node.y}`)).size).toBe(first.nodes.length);
  });
  it('无向显示合并同一对节点的多条问题关系，度数不会重复计算', () => {
    const library = fixture(); library.relations.push({ ...library.relations[0], id: 'reverse', from_card_id: 'c2', to_card_id: 'c1', kind: 'related' });
    const scene = buildGraphScene(library, 'p1');
    expect(scene.links).toHaveLength(4);
    expect(scene.nodes.find(node => node.id === 'c:c1')?.degree).toBe(3);
  });
  it('非有限和越界的物理配置被限制，合法的零力可以关闭该项', () => {
    expect(normalizeGraphForces({ centerForce: 0, repelForce: NaN, linkForce: Infinity, linkDistance: -12 })).toEqual({ ...defaultGraphForces, centerForce: 0, linkDistance: 10 });
    expect(normalizeGraphForces({ repelForce: 99999, linkForce: 9 })).toMatchObject({ repelForce: 3000, linkForce: 1 });
  });

  it('物理线程限速输出、隐藏暂停、拖动固定跟手并在释放后自然停止', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
    const updates: GraphWorkerResponse[] = [];
    vi.stubGlobal('postMessage', (message: GraphWorkerResponse) => updates.push(message));
    vi.stubGlobal('onmessage', null);
    const endpoint = globalThis as unknown as { onmessage: (event: { data: GraphWorkerRequest }) => void };
    try {
      await import('../src/graph.worker');
      const send = (data: GraphWorkerRequest) => endpoint.onmessage({ data });
      const scene = buildGraphScene(fixture());
      send({ type: 'init', scene });
      vi.advanceTimersByTime(120);
      expect(updates.length).toBeGreaterThan(1);
      expect(updates.length).toBeLessThanOrEqual(5);
      send({ type: 'pause', paused: true });
      const pausedCount = updates.length;
      vi.advanceTimersByTime(1000);
      expect(updates).toHaveLength(pausedCount);
      send({ type: 'pause', paused: false });
      vi.advanceTimersByTime(6000);
      expect(updates.at(-1)?.settled).toBe(true);
      const settledCount = updates.length;
      vi.advanceTimersByTime(1000);
      expect(updates).toHaveLength(settledCount);
      expect(updates.at(-1)?.revision).toBe(0);
      send({ type: 'drag', index: 1, x: 300, y: -250, revision: 3 });
      vi.advanceTimersByTime(120);
      expect(updates.at(-1)?.settled).toBe(false);
      expect(updates.at(-1)?.revision).toBe(3);
      expect([...updates.at(-1)!.positions.slice(2, 4)]).toEqual([300, -250]);
      send({ type: 'release', index: 1, revision: 4 });
      vi.advanceTimersByTime(6000);
      expect(updates.at(-1)?.settled).toBe(true);
      expect(updates.at(-1)?.revision).toBe(4);
      for (const update of updates) {
        expect(update.positions).toHaveLength(scene.nodes.length * 2);
        expect([...update.positions].every(Number.isFinite)).toBe(true);
      }
      updates.length = 0;
      send({ type: 'init', scene, reducedMotion: true });
      expect(updates).toHaveLength(1);
      vi.advanceTimersByTime(120);
      expect(updates).toHaveLength(1);
      vi.advanceTimersByTime(6000);
      expect(updates).toHaveLength(2);
      expect(updates.at(-1)?.settled).toBe(true);
      send({ type: 'drag', index: 1, x: 50, y: 75, revision: 10 });
      vi.advanceTimersByTime(120);
      expect(updates.length).toBeGreaterThan(2);
      expect(updates.at(-1)?.revision).toBe(10);
      expect([...updates.at(-1)!.positions.slice(2, 4)]).toEqual([50, 75]);
      send({ type: 'release', index: 1, revision: 9 });
      const beforeReducedSettle = updates.length;
      vi.advanceTimersByTime(120);
      expect(updates).toHaveLength(beforeReducedSettle);
      vi.advanceTimersByTime(6000);
      expect(updates.at(-1)?.revision).toBe(10);
      expect(updates.at(-1)?.settled).toBe(true);
      send({ type: 'pause', paused: true });
    } finally { vi.unstubAllGlobals(); vi.useRealTimers(); }
  });
});
