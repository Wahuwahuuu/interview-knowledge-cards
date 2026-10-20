import { describe, expect, it } from 'vitest';
import { emptyLibrary, importSchema, prepareImport } from '../shared/model';
import { parseImportFile, validateMergeImport } from '../shared/import-file';

const input = { schema_version: 1, projects: [{ id: 'p', name: '测试题库' }], cards: [{ id: 'q', project_id: 'p', title: '测试标题', question: '测试问题？' }] };
const library = prepareImport(emptyLibrary(), importSchema.parse(input));
const backup = { ...library, revision: 7, mode: 'restore', exported_at: '2026-10-20T00:00:00Z' };

describe('导入文件与完整备份分流', () => {
  it('普通文件按 merge 预览，保留系统生成的字段', () => {
    const result = parseImportFile(JSON.stringify(input), 'import', emptyLibrary());
    expect(result.mode).toBe('merge');
    expect(result.cards[0].id).toBe('q');
    expect(result.revisions).toEqual([]);
  });
  it('普通入口拒绝完整备份或带历史的合并文件', () => {
    expect(() => parseImportFile(JSON.stringify(backup), 'import', library)).toThrow('备份与恢复');
    expect(() => validateMergeImport({ ...backup, mode: 'merge' }, library)).toThrow('备份与恢复');
  });
  it('恢复完整保留题目和历史，但不采用备份自带批次 ID', () => {
    const result = parseImportFile(JSON.stringify({ ...backup, batch_id: 'old-batch' }), 'backup', emptyLibrary());
    expect(result.mode).toBe('restore');
    expect(result.cards).toEqual(library.cards);
    expect(result.revisions).toEqual(library.revisions);
    expect(result.batch_id).toBeUndefined();
  });
  it.each(['projects', 'topics', 'cards', 'sources', 'occurrences', 'relations', 'revisions', 'revision', 'mode'])('缺少 %s 的文件不能借默认空数组变成恢复', key => {
    const partial: Record<string, unknown> = { ...backup }; delete partial[key];
    expect(() => parseImportFile(JSON.stringify(partial), 'backup', library)).toThrow('完整备份');
  });
  it('普通导入和错误引用不能从恢复入口进入', () => {
    expect(() => parseImportFile(JSON.stringify(input), 'backup', library)).toThrow('完整备份');
    expect(() => parseImportFile(JSON.stringify({ ...backup, projects: [] }), 'backup', library)).toThrow('不存在的项目');
  });
  it.each(['bad json', 'null', '[]'])('损坏 JSON 被拒绝：%s', text => {
    expect(() => parseImportFile(text, 'import', library)).toThrow();
  });
  it('预检合并后的总量，避免只校验上传数量而超出题库上限', () => {
    const full = { ...library, cards: Array.from({ length: 2000 }, (_, index) => ({ ...library.cards[0], id: `q${index}` })), revisions: [] };
    expect(() => validateMergeImport({ ...input, projects: [], cards: [{ ...input.cards[0], id: 'extra' }] }, full)).toThrow();
  });
  it('恢复补齐当前快照后仍受历史总量限制', () => {
    const card = { ...library.cards[0], revision: 20_001 };
    const revisions = Array.from({ length: 20_000 }, (_, index) => ({ card_id: card.id, revision: index + 1, saved_at: '', action: '测试历史', snapshot: { ...card, revision: index + 1 } }));
    expect(() => parseImportFile(JSON.stringify({ ...backup, cards: [card], revisions }), 'backup', library)).toThrow();
  });
});
