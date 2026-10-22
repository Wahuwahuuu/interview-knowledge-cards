import type { Card } from './model';

const sourceLabels = {
  original: { label: '面经原题', description: '提供的面经表格中存在同一核心提问。' },
  split: { label: '面经拆问', description: '从面经原题明确包含的问句中拆出，或按原意改写。' },
  mixed: { label: '原题改编', description: '面经有对应原题，但本题增加了条件、比较或场景，包含扩展内容。' },
  'topic-only': { label: '仅记主题', description: '面经只记录了知识主题，未记录本题的具体问法。' },
  other: { label: '其他来源', description: '来自另外提供的原始题目材料，不属于本次面经表格原题。' },
  extension: { label: '扩展练习', description: '在本次提供的面经表格和其他原始材料中，未找到对应的具体原题。' },
} as const;

function sourceKind(topicId: string) {
  const kind = /^source-audit-\d{8}-(original|split|mixed|topic-only|other|extension)$/.exec(topicId)?.[1];
  return kind as keyof typeof sourceLabels | undefined;
}

export function isSourceTopic(topicId: string) { return sourceKind(topicId) !== undefined; }

export function cardSource(card: Pick<Card, 'topic_ids'>) {
  for (const id of card.topic_ids) {
    const kind = sourceKind(id);
    if (kind) return { kind, ...sourceLabels[kind] };
  }
}
