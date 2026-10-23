import type { Library, Entity } from './model';
import type { CloudDelta } from './cloud-sync';

/** Apply authoritative rows from complete committed mutations; retain untouched objects. */
export function applyLibraryDelta(library:Library,page:CloudDelta):Library {
  const next={...library,revision:page.cursor};
  const groups=new Map<string,Map<string,Entity|null>>();
  for(const row of page.records){let group=groups.get(row.kind);if(!group){group=new Map();groups.set(row.kind,group);}group.set(row.id,row.value);}
  for(const [kind,rows] of groups){const key=kind as keyof Pick<Library,'projects'|'topics'|'sources'|'cards'|'occurrences'|'relations'>,old=library[key] as Entity[],seen=new Set<string>();const values=old.flatMap(row=>{if(!rows.has(row.id))return[row];seen.add(row.id);const value=rows.get(row.id);return value?[value]:[];});for(const [id,value] of rows)if(value&&!seen.has(id))values.push(value);(next[key] as Entity[])=values;}
  if(groups.has('cards')&&next.revisions.length){const ids=new Set(next.cards.map(card=>card.id));next.revisions=next.revisions.filter(row=>ids.has(row.card_id));}
  return next;
}
