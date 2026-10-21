import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';

const sourceIndex = process.argv.indexOf('--library');
const source = sourceIndex >= 0 ? process.argv[sourceIndex + 1] : undefined;
const defaults = { revision: 1, updated_at: '', summary_md: '这里展示这道独立问题的口述答案。', answer_md: '这里展示该问题的详细讲解。', topic_ids: [], favorite: false, important: false, mastery: 'review', archived: false };
const fixture = {
  schema_version: 1, revision: 0,
  projects: [{ id: 'mysql', name: 'MySQL八股', description: '按主问题整理索引、事务与查询优化。', revision: 1, updated_at: '' }, { id: 'redis', name: 'Redis八股', description: '从基础概念延伸到业务场景。', revision: 1, updated_at: '' }],
  topics: [{ id: 'index', name: 'MySQL索引', revision: 1, updated_at: '' }, { id: 'transaction', name: '事务与并发', revision: 1, updated_at: '' }],
  cards: [
    ['mysql-01', 'mysql', '如何使用 EXPLAIN 分析 SQL 执行计划？', ['index']],
    ['mysql-01-a', 'mysql', 'EXPLAIN 中需要重点关注哪些字段？', ['index']],
    ['mysql-01-b', 'mysql', '扫描行数很大时，如何定位索引问题？', ['index']],
    ['mysql-02', 'mysql', 'MySQL 联合索引的最左前缀原则是什么？', ['index']],
    ['mysql-02-a', 'mysql', '范围查询为什么会影响后续索引列？', ['index']],
    ['mysql-02-b', 'mysql', '什么是索引下推？', ['index']],
    ['mysql-03', 'mysql', '什么是读写分离？', ['transaction']],
    ['mysql-03-a', 'mysql', '主从复制延迟会带来哪些问题？', ['transaction']],
    ['mysql-03-b', 'mysql', '如何处理读写分离中的旧数据读取？', ['transaction']],
    ['mysql-04', 'mysql', 'MySQL 默认使用什么事务隔离级别？', ['transaction']],
    ['redis-01', 'redis', 'Redis 支持哪些基本数据类型？', []],
    ['redis-01-a', 'redis', 'Redis Hash 与 String 存储对象如何选择？', []],
  ].map(([id, project_id, question, topic_ids]) => ({ ...defaults, id, project_id, title: question, question, topic_ids, important: id === 'mysql-01', mastery: id === 'mysql-04' ? 'mastered' : 'review' })),
  relations: [['mysql-01','mysql-01-a'],['mysql-01','mysql-01-b'],['mysql-02','mysql-02-a'],['mysql-02','mysql-02-b'],['mysql-03','mysql-03-a'],['mysql-03','mysql-03-b'],['redis-01','redis-01-a']].map(([from_card_id,to_card_id], i) => ({ id: 'followup-' + i, from_card_id, to_card_id, kind: 'followup', order: i, revision: 1, updated_at: '' })),
  sources: [], occurrences: [], revisions: [],
};
const library = source ? JSON.parse(await readFile(resolve(source), 'utf8')) : fixture;
const root = resolve('dist'), port = Number(process.env.GROUP_PREVIEW_PORT || 5291);
const json = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json;charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method !== 'GET') return json(res, { error: { code: 'PREVIEW_READ_ONLY', message: '这是只读预览，题库内容不会保存修改。' } }, 405);
  if (url.pathname === '/api/v1/me') return json(res, { user_id: 'group-preview', email: 'preview@example.test', display_name: '预览题库', role: 'admin', local: true });
  if (url.pathname === '/api/v1/library') return json(res, library);
  if (url.pathname.startsWith('/api/')) return json(res, { error: { code: 'PREVIEW_READ_ONLY', message: '只读预览仅提供浏览和自测展示。' } }, 405);
  if (url.pathname === '/_preview/phone') { res.setHeader('Content-Type', 'text/html;charset=utf-8'); return res.end('<!doctype html><meta name="viewport" content="width=device-width"><iframe title="手机宽度预览" src="/" style="width:390px;height:844px;border:0"></iframe>'); }
  const target = resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!target.startsWith(root + sep)) { res.writeHead(403); return res.end(); }
  try {
    const data = await readFile(target);
    res.setHeader('Content-Type', ({ '.html': 'text/html;charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' })[extname(target)] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store'); res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
server.listen(port, '127.0.0.1', () => console.log(`主问题分组只读预览：http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
