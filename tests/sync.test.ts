import { describe, expect, it } from 'vitest';
import { emptyLibrary, importSchema, prepareImport, type Library } from '../shared/model';
import { changesBetween, mergeOperation } from '../shared/sync';
import { removeCard } from '../shared/card-actions';
const seed = () => prepareImport(emptyLibrary(), importSchema.parse({ schema_version: 1, projects: [{ id: 'p', name: '测试项目' }], cards: [{ id: 'q', project_id: 'p', title: '事务', question: '事务是什么？', summary_md: '原口述', answer_md: '原讲解' }, { id: 'child', project_id: 'p', title: '隔离', question: '隔离是什么？' }], relations: [{ id: 'r', from_card_id: 'q', to_card_id: 'child', kind: 'followup' }] }));
function edit(base: Library, patch: object) { return prepareImport(base, importSchema.parse({ schema_version: 1, cards: [{ ...base.cards[0], ...patch }] })); }
const operation = (a: Library, b: Library) => ({ id: 'op', epoch: 'epoch', changes: changesBetween(a, b) });
describe('双向同步的语义合并', () => {
  it('不同字段合并，保持手机的掌握状态与电脑的新答案', () => {
    const base = seed(), phone = edit(base, { mastery: 'mastered' }), computer = edit(base, { answer_md: '电脑详细讲解' });
    const { target, conflicts } = mergeOperation(computer, operation(base, phone));
    expect(conflicts).toEqual([]); expect(target.cards[0].mastery).toBe('mastered'); expect(target.cards[0].answer_md).toBe('电脑详细讲解');
    expect(target.cards[0].revision).toBe(computer.cards[0].revision); expect(target.revisions).toHaveLength(computer.revisions.length);
  });
  it('同字段冲突保留双方且不提交部分修改', () => {
    const base = seed(), phone = edit(base, { summary_md: '手机口述', important: true }), computer = edit(base, { summary_md: '电脑口述' });
    const { target, conflicts } = mergeOperation(computer, operation(base, phone));
    expect(target).toEqual(computer); expect(conflicts[0]).toMatchObject({ field: 'summary_md', computer: '电脑口述', phone: '手机口述' });
  });
  it('电脑已删除的卡片不会因旧设备编辑而复活', () => {
    const base = seed(), phone = edit(base, { summary_md: '手机口述' }), computer = removeCard(base, 'q');
    expect(mergeOperation(computer, operation(base, phone)).conflicts[0].field).toBe('deleted');
  });
  it('删除及追问提升一起执行；删除对端修改过的卡片需要解决冲突', () => {
    const base = seed(), phone = removeCard(base, 'q');
    const ok = mergeOperation(base, operation(base, phone));
    expect(ok.conflicts).toEqual([]); expect(ok.target.cards.map(c => c.id)).toEqual(['child']);
    expect(mergeOperation(edit(base, { answer_md: '新答案' }), operation(base, phone)).conflicts[0].field).toBe('delete');
  });
  it('有依赖的新增项目、题目与关联可以原子提交', () => {
    const base = emptyLibrary(), target = seed();
    expect(mergeOperation(base, operation(base, target)).conflicts).toEqual([]);
  });
});
