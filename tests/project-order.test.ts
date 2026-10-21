import { describe, expect, it } from 'vitest';
import { emptyLibrary, importSchema, librarySchema, prepareImport, projectSchema } from '../shared/model';
import { applyProjectOrder, moveProject, orderedProjects } from '../shared/project-order';

const projects = () => ['b', 'a', 'c'].map(id => projectSchema.parse({ id, name: id, description: '项目资料', revision: 3, updated_at: '2026-10-20' }));
describe('项目显示顺序', () => {
  it('旧题库沿用内部编号顺序，手动顺序稳定且不改变传入数组', () => {
    const old = projects();
    expect(orderedProjects(old).map(p => p.id)).toEqual(['a', 'b', 'c']);
    const saved = applyProjectOrder(old, ['c', 'a', 'b'], '2026-10-22');
    expect(orderedProjects([...saved].reverse()).map(p => p.id)).toEqual(['c', 'a', 'b']);
    expect(old.every(p => p.sort_order === undefined && p.revision === 3)).toBe(true);
    expect(saved.every(p => p.description === '项目资料')).toBe(true);
  });
  it('向上、向下、首尾拖动正确，同位置和无效目标不改变顺序', () => {
    const ids = ['a', 'b', 'c'];
    expect(moveProject(ids, 'a', 'c', true)).toEqual(['b', 'c', 'a']);
    expect(moveProject(ids, 'c', 'a')).toEqual(['c', 'a', 'b']);
    expect(moveProject(ids, 'b', 'a', true)).toEqual(ids);
    expect(moveProject(ids, 'a', 'a')).toBe(ids);
    expect(moveProject(ids, 'missing', 'c')).toBe(ids);
  });
  it('缺少、重复及其他账号项目均不能构成合法顺序', () => {
    for (const ids of [['a', 'b'], ['a', 'a', 'b'], ['a', 'b', 'foreign']]) expect(() => applyProjectOrder(projects(), ids)).toThrow();
  });
  it('重复保存相同顺序不产生新版本', () => {
    const saved = applyProjectOrder(projects(), ['c', 'b', 'a']);
    expect(applyProjectOrder(saved, ['c', 'b', 'a'])).toEqual(saved);
  });
  it('修改项目和旧格式导入保留顺序，新项目追加到末尾', () => {
    const base = { ...emptyLibrary(), projects: applyProjectOrder(projects(), ['c', 'a', 'b']) };
    const edited = { ...base.projects[0], name: '改名后的项目' };
    delete edited.sort_order;
    const next = prepareImport(base, importSchema.parse({ schema_version: 1, projects: [edited, { id: '0-new', name: '新项目' }] }));
    expect(orderedProjects(next.projects).map(p => p.id)).toEqual(['c', 'a', 'b', '0-new']);
    expect(next.projects.find(p => p.id === 'c')?.name).toBe('改名后的项目');
  });
  it('完整备份恢复保留手动顺序，旧备份无需迁移', () => {
    const base = { ...emptyLibrary(), projects: applyProjectOrder(projects(), ['b', 'c', 'a']) };
    const restored = prepareImport(emptyLibrary(), importSchema.parse({ ...JSON.parse(JSON.stringify(base)), mode: 'restore' }));
    expect(orderedProjects(restored.projects).map(p => p.id)).toEqual(['b', 'c', 'a']);
    expect(librarySchema.parse({ ...emptyLibrary(), projects: projects() }).projects).toHaveLength(3);
  });
});
