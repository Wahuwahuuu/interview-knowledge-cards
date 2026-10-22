import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const args = new Map(process.argv.slice(2).map(value => { const [key, ...rest] = value.replace(/^--/, '').split('='); return [key, rest.join('=')]; }));
const stamp = new Date().toISOString().replace(/[:.]/g, '-'), privateDir = resolve('.private', 'desktop-migration-' + stamp);
mkdirSync(privateDir, { recursive: true });
const dataDir = resolve(args.get('data') || join(process.env.APPDATA ?? '.private', 'InterviewKnowledgeCards'));
const target = join(dataDir, 'knowledge-cards.sqlite');
if (existsSync(target)) throw new Error('本地题库已存在，停止迁移以保护现有修改。请在客户端备份后使用单独的数据目录；不会覆盖。');
let sqlFile = args.get('sql') ? resolve(args.get('sql')) : join(privateDir, 'cloud-export.sql');
if (!args.has('sql')) {
  const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
  if (!config.d1_databases?.[0]?.database_id || config.d1_databases[0].database_id.startsWith('00000000-')) throw new Error('线上数据库未配置');
  const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'export', 'DB', '--remote', '--output', sqlFile], { env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_CF_FETCH_ENABLED: 'false' }, encoding: 'utf8', windowsHide: true });
  writeFileSync(join(privateDir, 'export.log'), (result.stdout ?? '') + (result.stderr ?? ''));
  if (result.status !== 0 || !existsSync(sqlFile)) throw new Error('线上完整备份导出未完成，未创建本地题库。详情位于 ' + join(privateDir, 'export.log'));
}
const temporary = join(privateDir, 'imported.sqlite'), imported = new DatabaseSync(temporary);
// Only ingest the explicitly selected D1 export, never a file from a web import form.
const sql = readFileSync(sqlFile, 'utf8');
imported.exec('PRAGMA foreign_keys=OFF;');
if (/\bBEGIN\s+(?:TRANSACTION|IMMEDIATE|EXCLUSIVE|DEFERRED)\b/i.test(sql)) imported.exec(sql);
else { imported.exec('BEGIN IMMEDIATE'); try { imported.exec(sql); imported.exec('COMMIT'); } catch (error) { imported.exec('ROLLBACK'); throw error; } }
imported.exec('PRAGMA foreign_keys=ON;');
if (imported.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' || imported.prepare('PRAGMA foreign_key_check').all().length) throw new Error('导出数据库完整性检查未通过，原始备份保留；不继续迁移。');
const required = ['users', 'user_library_meta', 'user_projects', 'user_topics', 'user_sources', 'user_cards', 'user_occurrences', 'user_relations', 'user_card_revisions', 'user_import_batches'];
for (const table of required) if (!imported.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw new Error('备份缺少表：' + table);
function fingerprints(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all().map(row => row.name);
  return Object.fromEntries(tables.map(table => {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) throw new Error('不支持的表名');
    const rows = db.prepare(`SELECT * FROM "${table}"`).all().map(row => JSON.stringify(row)).sort();
    return [table, { count: rows.length, sha256: createHash('sha256').update(rows.join('\n')).digest('hex') }];
  }));
}
const before = fingerprints(imported);
mkdirSync(dataDir, { recursive: true });
const staging = target + '.incoming';
if (existsSync(staging)) throw new Error('存在尚未处理的迁移文件：' + staging);
await backup(imported, staging); imported.close();
const verify = new DatabaseSync(staging), after = fingerprints(verify);
if (JSON.stringify(before) !== JSON.stringify(after)) { verify.close(); throw new Error('迁移前后内容摘要不一致，原始数据库和临时文件保留。'); }
const accounts = verify.prepare('SELECT id,role,status FROM users ORDER BY id').all();
const cards = verify.prepare("SELECT count(*) AS total,sum(CASE WHEN coalesce(json_extract(payload,'$.archived'),0)=0 THEN 1 ELSE 0 END) AS active FROM user_cards").get();
verify.close();
if (existsSync(target)) throw new Error('迁移期间发现本地题库已创建，停止避免覆盖。');
renameSync(staging, target);
const report = { migrated_at: new Date().toISOString(), source: sqlFile, destination: target, sql_sha256: createHash('sha256').update(sql).digest('hex'), tables: before, accounts, cards, verified: true, cloud_unchanged: true };
writeFileSync(join(privateDir, 'migration-report.json'), JSON.stringify(report, null, 2));
mkdirSync(join(dataDir, 'backups'), { recursive: true });
writeFileSync(join(dataDir, 'backups', 'migration-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ok: true, database: target, cards, accounts: accounts.length, histories: before.user_card_revisions.count, import_records: before.user_import_batches.count, verified_tables: Object.keys(before).length, report: join(privateDir, 'migration-report.json'), cloud_unchanged: true }, null, 2));
