import { readFile } from 'node:fs/promises';
export async function demoLegacySql() {
  const seed=JSON.parse(await readFile('examples/demo-import.json','utf8'));
  const defaults={projects:{description:''},topics:{},sources:{date:'',company:'',job:'',round:'',notes:'',source_path:'',original_markdown:''},cards:{summary_md:'',answer_md:'',limitations_md:'',source_baseline:'',evidence:[],topic_ids:[],favorite:false,mastery:'review',archived:false},occurrences:{original_answer_md:'',section:'',notes:''},relations:{}};
  const quote=value=>"'"+String(value).replaceAll("'","''")+"'", saved='2026-10-14T00:00:00.000Z', lines=[];
  const cards=[];
  for(const kind of ['projects','topics','sources','cards','occurrences','relations']) for(const value of seed[kind]) {
    const record={revision:1,updated_at:saved,...defaults[kind],...value},extra=kind==='cards'?['project_id']:kind==='occurrences'?['card_id','source_id']:kind==='relations'?['from_card_id','to_card_id']:[];
    lines.push(`INSERT INTO ${kind}(id,revision,payload${extra.map(key=>','+key).join('')}) VALUES (${[quote(record.id),'1',quote(JSON.stringify(record)),...extra.map(key=>quote(record[key]))].join(',')});`);
    if(kind==='cards')cards.push(record);
  }
  for(const card of cards) {
    for(const topic of card.topic_ids)lines.push(`INSERT INTO card_topics(card_id,topic_id) VALUES (${quote(card.id)},${quote(topic)});`);
    const entry={card_id:card.id,revision:1,saved_at:saved,action:'示例旧版导入',snapshot:card};
    lines.push(`INSERT INTO card_revisions(card_id,revision,saved_at,action,payload) VALUES (${quote(card.id)},1,${quote(saved)},${quote(entry.action)},${quote(JSON.stringify(entry))});`);
  }
  lines.push('UPDATE library_meta SET revision=1 WHERE id=1;');
  return lines.join('\n');
}
