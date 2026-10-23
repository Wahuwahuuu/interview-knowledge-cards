import type { Card, Topic } from './model';
import { isSourceTopic } from './card-source';

/** Provenance tags and retired fine-grained topics are metadata, not selectable categories. */
export function knowledgeCategories(topics: Topic[]) {
  return topics.filter(topic => !topic.archived && !isSourceTopic(topic.id));
}

export function cardCategories(card: Pick<Card, 'topic_ids'>, topics: Topic[]) {
  return knowledgeCategories(topics).filter(topic => card.topic_ids.includes(topic.id));
}

/** A card has one human-facing category. Source provenance must survive category edits. */
export function withCategory(card: Pick<Card, 'topic_ids'>, categoryId: string) {
  return [...card.topic_ids.filter(isSourceTopic), ...(categoryId ? [categoryId] : [])];
}
