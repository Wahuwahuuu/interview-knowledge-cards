import { describe, expect, it } from 'vitest';
import { emptyLibrary, importSchema, prepareImport, projectSchema } from '../shared/model';

function fixture() {
  const library = emptyLibrary();
  library.projects = [
    projectSchema.parse({ id: 'p1', name: 'MySQL八股' }),
    projectSchema.parse({ id: 'p2', name: 'Redis八股' }),
  ];
  return library;
}

describe('项目名称唯一性', () => {
  it.each(['MySQL八股', '  MySQL八股  '])('创建时拒绝重名：%s', name => {
    const base = fixture();
    expect(() => prepareImport(base, importSchema.parse({ schema_version: 1, projects: [{ id: 'p3', name }] }))).toThrow('已存在');
    expect(base.projects).toHaveLength(2);
  });

  it('改名不能与其他项目重复，保存原名称和修改说明可以正常进行', () => {
    const base = fixture();
    expect(() => prepareImport(base, importSchema.parse({ schema_version: 1, projects: [{ ...base.projects[1], name: 'MySQL八股' }] }))).toThrow('已存在');
    const next = prepareImport(base, importSchema.parse({ schema_version: 1, projects: [{ ...base.projects[0], description: '新说明' }] }));
    expect(next.projects[0].description).toBe('新说明');
  });

  it.each(['merge', 'restore'])('%s 不能一次导入两个同名项目', mode => {
    expect(() => prepareImport(emptyLibrary(), importSchema.parse({ schema_version: 1, mode, projects: [
      { id: 'p1', name: 'MySQL八股' }, { id: 'p2', name: ' MySQL八股 ' },
    ] }))).toThrow('已存在');
  });

  it('历史重名不阻止卡片编辑、说明修改和消除重名，但不能新增重名项目', () => {
    const base = fixture();
    base.projects[1].name = base.projects[0].name;
    const next = prepareImport(base, importSchema.parse({ schema_version: 1,
      projects: [{ ...base.projects[0], description: '仍可编辑' }],
      cards: [{ id: 'c1', project_id: 'p1', title: '事务', question: '什么是事务？' }],
    }));
    expect(next.cards).toHaveLength(1);
    expect(next.projects[0].description).toBe('仍可编辑');
    const renamed = prepareImport(base, importSchema.parse({ schema_version: 1, projects: [{ ...base.projects[1], name: '事务专题' }] }));
    expect(renamed.projects[1].name).toBe('事务专题');
    expect(() => prepareImport(base, importSchema.parse({ schema_version: 1, projects: [{ id: 'p3', name: 'MySQL八股' }] }))).toThrow('已存在');
  });

  it('不同账号题库可以使用相同项目名称', () => {
    const envelope = importSchema.parse({ schema_version: 1, projects: [{ id: 'p1', name: 'MySQL八股' }] });
    expect(prepareImport(emptyLibrary(), envelope).projects[0].name).toBe('MySQL八股');
    expect(prepareImport(emptyLibrary(), envelope).projects[0].name).toBe('MySQL八股');
  });
});
