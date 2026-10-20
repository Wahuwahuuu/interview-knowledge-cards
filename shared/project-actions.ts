import { AppError, importSchema, type ImportEnvelope, type Library } from './model';

/** A merge import package for one project, including archived cards and their sources. */
export function projectExport(library: Library, projectId: string): ImportEnvelope {
  if (!library.projects.some(project => project.id === projectId)) throw new AppError(404, '项目不存在');
  const cards = library.cards.filter(card => card.project_id === projectId), cardIds = new Set(cards.map(card => card.id));
  const topicIds = new Set(cards.flatMap(card => card.topic_ids));
  const occurrences = library.occurrences.filter(record => cardIds.has(record.card_id));
  const sourceIds = new Set(occurrences.map(record => record.source_id));
  return importSchema.parse({
    schema_version: 1, mode: 'merge',
    projects: library.projects.filter(project => project.id === projectId), cards,
    topics: library.topics.filter(topic => topicIds.has(topic.id)),
    sources: library.sources.filter(source => sourceIds.has(source.id)), occurrences,
    relations: library.relations.filter(relation => cardIds.has(relation.from_card_id) && cardIds.has(relation.to_card_id)),
  });
}

/** Remove a project and its cards, retaining shared topics and original source documents. */
export function removeProject(library: Library, projectId: string): Library {
  if (!library.projects.some(project => project.id === projectId)) throw new AppError(404, '项目不存在');
  const cardIds = new Set(library.cards.filter(card => card.project_id === projectId).map(card => card.id));
  return {
    ...library,
    projects: library.projects.filter(project => project.id !== projectId),
    cards: library.cards.filter(card => !cardIds.has(card.id)),
    occurrences: library.occurrences.filter(record => !cardIds.has(record.card_id)),
    relations: library.relations.filter(relation => !cardIds.has(relation.from_card_id) && !cardIds.has(relation.to_card_id)),
    revisions: library.revisions.filter(entry => !cardIds.has(entry.card_id)),
  };
}
