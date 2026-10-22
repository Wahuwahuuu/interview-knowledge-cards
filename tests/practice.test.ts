import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cardSchema, emptyLibrary } from '../shared/model';
import { canAdvancePractice, currentPracticeId, nextPractice, practiceCards, previousPractice, setPracticeMode, startPractice } from '../shared/practice';
import { PracticeView } from '../src/PracticeView';

const card = (id: string, title: string, updated_at = '', project_id = 'redis') => cardSchema.parse({ id, title, question: `${title}？`, project_id, updated_at });

describe('复习范围与稳定顺序', () => {
  it('按标题的题号自然排序，保存掌握状态与更新时间不改变出题顺序', () => {
    const library = emptyLibrary();
    library.cards = [card('z', '10. 十', '2026-10-20'), card('x', '2. 二', '2026-10-19'), card('y', '01 · 一', '2026-10-18')];
    expect(practiceCards(library).map(value => value.id)).toEqual(['y', 'x', 'z']);
    library.cards[2].updated_at = '2026-10-21';
    library.cards[2].mastery = 'mastered';
    expect(practiceCards(library).map(value => value.id)).toEqual(['y', 'x', 'z']);
  });

  it('没有题号时按 ID 自然顺序，全库按题库分组，并排除归档题', () => {
    const library = emptyLibrary();
    library.cards = [card('q10', '事务'), card('q2', '索引'), card('q1', '锁'), card('sql1', 'SQL', '', 'mysql'), { ...card('q0', '归档'), archived: true }];
    expect(practiceCards(library).map(value => value.id)).toEqual(['sql1', 'q1', 'q2', 'q10']);
    expect(practiceCards(library, 'redis').map(value => value.id)).toEqual(['q1', 'q2', 'q10']);
    expect(practiceCards(library, 'absent')).toEqual([]);
  });

  it('进入复习先显示两个入口和方式选择，不自动发第一题，也不预渲染答案', () => {
    const library = emptyLibrary();
    library.cards = [{ ...card('q1', '测试题'), summary_md: 'PRIVATE_OUTLINE', answer_md: 'PRIVATE_ANSWER' }];
    library.projects = [{ id: 'redis', name: 'Redis', revision: 1, updated_at: '', description: '' }];
    const html = renderToStaticMarkup(createElement(PracticeView, { library, offline: false, busy: false, editDisabled: false, onMark: async () => {}, onEdit: () => {}, onScopeChange: () => {}, onOpenProject: () => {} }));
    expect(html).toContain('全库发问');
    expect(html).toContain('按题库发问');
    expect(html).toContain('顺序出题');
    expect(html).toContain('随机出题');
    expect(html).toContain('开始发问');
    expect(html).not.toContain('揭晓答案');
    expect(html).not.toContain('PRIVATE_OUTLINE');
    expect(html).not.toContain('PRIVATE_ANSWER');
    expect(html).toContain('aria-pressed="true"');
  });

  it('从项目进入时预选题库，空题库禁用开始', () => {
    const library = emptyLibrary();
    library.projects = [{ id: 'mysql', name: 'MySQL', revision: 1, updated_at: '', description: '' }];
    const html = renderToStaticMarkup(createElement(PracticeView, { library, initialProjectId: 'mysql', offline: false, busy: false, editDisabled: false, onMark: async () => {}, onEdit: () => {}, onScopeChange: () => {}, onOpenProject: () => {} }));
    expect(html).toContain('<option value="mysql" selected="">MySQL（0 道主问题）</option>');
    expect(html).toMatch(/<button class="primary" disabled="">/);
    expect(html).toContain('这个题库还没有可复习的问题');
  });
});

describe('复习会话的顺序、随机与历史', () => {
  it('顺序模式从第一题开始，下一题依次前进，到结尾停止', () => {
    const first = startPractice(['a', 'b', 'c'], 'sequential');
    const second = nextPractice(first);
    const third = nextPractice(second);
    expect(currentPracticeId(first)).toBe('a');
    expect(currentPracticeId(second)).toBe('b');
    expect(currentPracticeId(third)).toBe('c');
    expect(canAdvancePractice(third)).toBe(false);
    expect(nextPractice(third)).toBe(third);
    expect(currentPracticeId(previousPractice(third))).toBe('b');
  });

  it('随机模式每次下一题避开当前题，一轮遍历无重复，轮末继续随机', () => {
    let session = startPractice(['a', 'b', 'c', 'd'], 'random', () => 0.3);
    const visited = [currentPracticeId(session)];
    for (let i = 0; i < 3; i++) {
      session = nextPractice(session, () => 0.7);
      visited.push(currentPracticeId(session));
    }
    expect(new Set(visited).size).toBe(4);
    const last = currentPracticeId(session);
    session = nextPractice(session, () => 0.4);
    expect(currentPracticeId(session)).not.toBe(last);
    expect(session.ids).toEqual(['a', 'b', 'c', 'd']);
  });

  it('随机上一题返回实际访问历史，连续返回不会小于第一题', () => {
    const first = startPractice(['a', 'b', 'c'], 'random', () => 0);
    const second = nextPractice(first, () => 0);
    const third = nextPractice(second, () => 0);
    const back = previousPractice(third);
    expect(currentPracticeId(back)).toBe(currentPracticeId(second));
    expect(currentPracticeId(previousPractice(back))).toBe(currentPracticeId(first));
    expect(previousPractice(first)).toBe(first);
    expect(currentPracticeId(nextPractice(back, () => 0.8))).not.toBe(currentPracticeId(back));
  });

  it('切换方式保留当前题，只在下一题时使用新方式；顺序按稳定题序接续', () => {
    let session = startPractice(['a', 'b', 'c', 'd'], 'sequential');
    session = setPracticeMode(session, 'random');
    expect(currentPracticeId(session)).toBe('a');
    const randomNext = nextPractice(session, () => 0);
    expect(currentPracticeId(randomNext)).toBe('c');
    const sequential = setPracticeMode(randomNext, 'sequential');
    expect(currentPracticeId(sequential)).toBe('c');
    expect(currentPracticeId(nextPractice(sequential))).toBe('d');
    expect(setPracticeMode(sequential, 'sequential')).toBe(sequential);
  });

  it('切换方式后向前后查看历史仍能随机出题，不会产生空题或原地重复', () => {
    let session = startPractice(['a', 'b', 'c'], 'sequential');
    session = nextPractice(nextPractice(session));
    session = setPracticeMode(session, 'random');
    session = nextPractice(session, () => 0.9);
    session = previousPractice(previousPractice(session));
    const current = currentPracticeId(session);
    session = nextPractice(session, () => 0);
    expect(currentPracticeId(session)).toBeDefined();
    expect(currentPracticeId(session)).not.toBe(current);
  });

  it.each(['sequential', 'random'] as const)('空库与单题库在 %s 模式不报错且不重复下一题', mode => {
    const empty = startPractice([], mode);
    expect(currentPracticeId(empty)).toBeUndefined();
    expect(canAdvancePractice(empty)).toBe(false);
    expect(nextPractice(empty)).toBe(empty);
    expect(previousPractice(empty)).toBe(empty);
    const only = startPractice(['a'], mode);
    expect(currentPracticeId(only)).toBe('a');
    expect(canAdvancePractice(only)).toBe(false);
    expect(nextPractice(only)).toBe(only);
  });

  it('重复 ID 不造成随机重复题，创建会话不修改输入数组', () => {
    const ids = ['a', 'b', 'a'];
    const session = startPractice(ids, 'random', () => 0);
    expect(session.ids).toEqual(['a', 'b']);
    expect(ids).toEqual(['a', 'b', 'a']);
  });
});
