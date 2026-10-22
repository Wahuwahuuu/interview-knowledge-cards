import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { cardSchema, emptyLibrary, graphElements, projectSnapshot } from '../shared/model';
import { buildGraphScene } from '../shared/graph-scene';
import { cardSource, isSourceTopic } from '../shared/card-source';
import { CardCollection } from '../src/CardCollection';
import { SourceBadge } from '../src/SourceBadge';

const sourceId = (kind: string) => `source-audit-20261022-${kind}`;
const card = (id: string, kind?: string) => cardSchema.parse({ id, project_id: 'p', title: id, question: id, topic_ids: [...(kind ? [sourceId(kind)] : []), 'index'] });

describe('来源徽标', () => {
  it('明确区分原题、拆问、改编、仅有主题、其他材料和扩展练习', () => {
    for (const [kind, label] of Object.entries({ original: '面经原题', split: '面经拆问', mixed: '原题改编', 'topic-only': '仅记主题', other: '其他来源', extension: '扩展练习' })) {
      const html = renderToStaticMarkup(createElement(SourceBadge, { card: card('q', kind) }));
      expect(html).toContain(`>${label}</span>`);
      expect(html).toContain('aria-label="题目来源：');
    }
    expect(cardSource(card('q', 'mixed'))?.description).toContain('包含扩展');
    expect(cardSource(card('q', 'extension'))?.description).toContain('本次提供');
  });

  it('未核对的卡片不根据标题、普通知识点或父卡来源推测来源', () => {
    expect(cardSource(card('q'))).toBeUndefined();
    expect(renderToStaticMarkup(createElement(SourceBadge, { card: card('q') }))).toBe('');
    expect(isSourceTopic('source-audit-20261022-unknown')).toBe(false);
    expect(isSourceTopic('MySQL索引')).toBe(false);
  });

  it('卡片和列表分别显示主问题与追问自己的徽标，普通标签区不重复来源', () => {
    const library = emptyLibrary(), main = card('main', 'original'), child = card('child', 'extension');
    library.cards = [main, child];
    library.topics = [sourceId('original'), sourceId('extension'), 'index'].map(id => ({ id, name: id === 'index' ? '联合索引' : '来源重复文本', revision: 1, updated_at: '' }));
    for (const layout of ['cards', 'list'] as const) {
      const html = renderToStaticMarkup(createElement(CardCollection, { library, cards: [main], groups: [{ main, children: [{ card: child, depth: 1 }], expandForMatches: true }], layout, disabled: false, onOpen() {}, onFavorite() {} }));
      expect(html).toContain('>面经原题</span>');
      expect(html).toContain('>扩展练习</span>');
      expect(html).not.toContain('来源重复文本');
      if (layout === 'cards') expect(html).toContain('>联合索引</span>');
    }
  });

  it('来源元数据随离线下载保留，但不成为图谱知识点或连线', () => {
    const library = emptyLibrary(); library.cards = [card('q', 'split')];
    library.projects = [{ id: 'p', name: '示例', description: '', revision: 1, updated_at: '' }];
    library.topics = [sourceId('split'), 'index'].map(id => ({ id, name: id, revision: 1, updated_at: '' }));
    expect(projectSnapshot(library, 'p').topics.map(t => t.id)).toContain(sourceId('split'));
    expect(buildGraphScene(library).nodes.map(n => n.entityId)).toEqual(['p', 'q', 'index']);
    expect(JSON.stringify(graphElements(library))).not.toContain(sourceId('split'));
  });
});
