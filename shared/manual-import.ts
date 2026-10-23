import { importSchema, type ImportEnvelope, type Library } from './model';
import { knowledgeCategories, withCategory } from './topic-categories';

export type ManualImportQuestion = {
  id: string;
  title: string;
  question: string;
  summary: string;
  answer: string;
  important?: boolean;
  categoryId?: string;
};

export type ManualImportDraft = {
  destination: 'existing' | 'new';
  projectId: string;
  newProjectId: string;
  newProjectName: string;
  questions: ManualImportQuestion[];
};

type IdFactory = (prefix: string) => string;
const createId: IdFactory = prefix => `${prefix}-${crypto.randomUUID()}`;
const validId = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;

export class ManualImportError extends Error {
  constructor(message: string, public field?: string) { super(message); }
}

export function createManualImportQuestion(idFactory: IdFactory = createId): ManualImportQuestion {
  return { id: idFactory('card'), title: '', question: '', summary: '', answer: '', important: false };
}

export function createManualImportDraft(projectId = '', idFactory: IdFactory = createId): ManualImportDraft {
  return {
    destination: projectId ? 'existing' : 'new', projectId,
    newProjectId: idFactory('project'), newProjectName: '',
    questions: [createManualImportQuestion(idFactory)],
  };
}

/** Only creates a merge proposal. Existing bank metadata and library records stay untouched. */
export function buildManualImportEnvelope(library: Library, draft: ManualImportDraft): ImportEnvelope {
  if (!draft.questions.length) throw new ManualImportError('请至少填写一道题。');
  if (draft.questions.length > 2000) throw new ManualImportError('一批最多导入 2000 道题，请分批填写。');
  const projectId = draft.destination === 'new' ? draft.newProjectId : draft.projectId;
  let projects: ImportEnvelope['projects'] = [];
  if (draft.destination === 'new') {
    if (!validId.test(projectId)) throw new ManualImportError('这份填写内容已失效，请检查导入记录后重新填写。');
    if (!library.projects.some(project => project.id === projectId)) {
      const name = draft.newProjectName.trim();
      if (!name) throw new ManualImportError('请填写新题库的名称。', 'new-project-name');
      if (name.length > 100) throw new ManualImportError('题库名称最多 100 个字符。', 'new-project-name');
      projects = [{ id: projectId, name, description: '', revision: 1, updated_at: '' }];
    }
  } else if (!library.projects.some(project => project.id === projectId)) {
    throw new ManualImportError('请选择一个现有题库，或选择新建题库。', 'project');
  }

  const ids = new Set<string>();
  const existingCards = new Map(library.cards.map(card => [card.id, card]));
  const cards = draft.questions.map((row, index) => {
    const number = index + 1, title = row.title.trim(), question = row.question.trim();
    if (!title) throw new ManualImportError(`请填写第 ${number} 题的标题。`, `title-${row.id}`);
    if (!question) throw new ManualImportError(`请填写第 ${number} 题的问题。`, `question-${row.id}`);
    if (title.length > 150) throw new ManualImportError(`第 ${number} 题的标题最多 150 个字符。`, `title-${row.id}`);
    for (const [field, label, value] of [['question', '问题', question], ['summary', '复习提纲', row.summary], ['answer', '完整答案', row.answer]] as const) {
      if (value.length > 400_000) throw new ManualImportError(`第 ${number} 题的${label}最多 400000 个字符。`, `${field}-${row.id}`);
    }
    const existing = existingCards.get(row.id);
    if (!validId.test(row.id) || ids.has(row.id) || existing && existing.project_id !== projectId) throw new ManualImportError('这份填写内容已失效，请检查导入记录后重新填写。');
    ids.add(row.id);
    if (row.categoryId && !knowledgeCategories(library.topics).some(topic => topic.id === row.categoryId)) throw new ManualImportError(`请选择第 ${number} 题的现有知识大类。`, `categoryId-${row.id}`);
    return { ...existing, id: row.id, project_id: projectId, title, question, summary_md: row.summary, answer_md: row.answer, important: row.important ?? existing?.important,
      topic_ids: row.categoryId === undefined ? existing?.topic_ids : withCategory(existing ?? { topic_ids: [] }, row.categoryId) };
  });
  // The submitter assigns a stable batch ID for retries of the same content.
  return importSchema.parse({ schema_version: 1, mode: 'merge', projects, cards });
}
