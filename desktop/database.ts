import { DatabaseSync, backup, type SQLInputValue } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { kinds } from '../shared/model';

/** The D1 surface used by the existing application, backed by one local SQLite file. */
export class LocalDatabase {
  raw: DatabaseSync;
  private depth = 0;
  constructor(public filename: string, migrations: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.raw = new DatabaseSync(filename);
    this.raw.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.raw.exec('CREATE TABLE IF NOT EXISTS desktop_migrations(name TEXT PRIMARY KEY);');
    for (const file of readdirSync(migrations).filter(f => /^\d+.*\.sql$/.test(f)).sort()) {
      if (this.raw.prepare('SELECT name FROM desktop_migrations WHERE name=?').get(file)) continue;
      // A D1 export may already contain all original tables, without this local ledger.
      const existing = file.startsWith('0001') ? 'library_meta' : file.startsWith('0002') ? 'users' : undefined;
      const present = existing && this.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(existing);
      const hasErrorColumn = file.startsWith('0003') && this.raw.prepare('PRAGMA table_info(user_import_batches)').all().some(row => row.name === 'error_message');
      this.raw.exec('BEGIN IMMEDIATE');
      try {
        if (!present && !hasErrorColumn) this.raw.exec(readFileSync(join(migrations, file), 'utf8'));
        this.raw.prepare('INSERT INTO desktop_migrations VALUES (?)').run(file);
        this.raw.exec('COMMIT');
      } catch (error) { this.raw.exec('ROLLBACK'); throw error; }
    }
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS sync_state(user_id TEXT PRIMARY KEY REFERENCES users(id), epoch TEXT NOT NULL);
      INSERT OR IGNORE INTO sync_state SELECT id,lower(hex(randomblob(16))) FROM users;
      CREATE TABLE IF NOT EXISTS sync_log(seq INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,payload TEXT);
      CREATE INDEX IF NOT EXISTS sync_log_user ON sync_log(user_id,seq);
      CREATE TABLE IF NOT EXISTS sync_devices(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,created_at TEXT NOT NULL,last_seen TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_pairing(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_receipts(user_id TEXT NOT NULL,device_id TEXT NOT NULL,op_id TEXT NOT NULL,digest TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(user_id,device_id,op_id));
      CREATE TABLE IF NOT EXISTS desktop_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS sync_new_user AFTER INSERT ON users BEGIN INSERT INTO sync_state VALUES(NEW.id,lower(hex(randomblob(16)))); END;
      CREATE TRIGGER IF NOT EXISTS sync_credentials_changed AFTER UPDATE OF password_hash,status ON users
      WHEN OLD.password_hash IS NOT NEW.password_hash OR NEW.status='disabled'
      BEGIN DELETE FROM sync_devices WHERE user_id=NEW.id; DELETE FROM sync_pairing WHERE user_id=NEW.id; END;
    `);
    for (const kind of [...kinds, 'revisions', 'imports']) {
      const table = kind === 'revisions' ? 'user_card_revisions' : kind === 'imports' ? 'user_import_batches' : `user_${kind}`;
      const key = (row: string) => kind === 'revisions' ? `${row}.card_id||':'||${row}.revision` : `${row}.id`;
      const payload = kind === 'imports'
        ? "json_object('id',NEW.id,'status',NEW.status,'base_revision',NEW.base_revision,'created_at',NEW.created_at,'applied_at',NEW.applied_at,'preview',json(NEW.preview),'mode',coalesce(json_extract(NEW.payload,'$.mode'),'merge'),'error',NEW.error_message,'question_count',coalesce(json_array_length(NEW.payload,'$.cards'),0))"
        : 'NEW.payload';
      for (const verb of ['INSERT', 'UPDATE', 'DELETE']) this.raw.exec(`CREATE TRIGGER IF NOT EXISTS sync_${kind}_${verb} AFTER ${verb} ON ${table} BEGIN INSERT INTO sync_log(user_id,kind,id,payload) VALUES(${verb === 'DELETE' ? 'OLD' : 'NEW'}.user_id,'${kind}',${key(verb === 'DELETE' ? 'OLD' : 'NEW')},${verb === 'DELETE' ? 'NULL' : payload}); END;`);
    }
  }
  prepare(sql: string) { return new LocalStatement(this, sql); }
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const name = `local_tx_${++this.depth}`;
    this.raw.exec(`SAVEPOINT ${name}`);
    try { const value = await fn(); this.raw.exec(`RELEASE ${name}`); return value; }
    catch (error) { this.raw.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
    finally { this.depth--; }
  }
  async batch(statements: LocalStatement[]) {
    return this.transaction(async () => statements.map(statement => statement.execute()));
  }
  asD1() { return this as unknown as D1Database; }
  async saveBackup(path: string) { mkdirSync(dirname(path), { recursive: true }); await backup(this.raw, path); return path; }
  close() { this.raw.close(); }
}
class LocalStatement {
  private values: SQLInputValue[] = [];
  constructor(private db: LocalDatabase, private sql: string) {}
  bind(...values: SQLInputValue[]) { const statement = new LocalStatement(this.db, this.sql); statement.values = values; return statement; }
  execute() {
    const statement = this.db.raw.prepare(this.sql);
    const results = statement.columns().length ? statement.all(...this.values) : [];
    const result = statement.columns().length ? undefined : statement.run(...this.values);
    return { success: true, results, meta: { changes: Number(result?.changes ?? 0), last_row_id: Number(result?.lastInsertRowid ?? 0) } };
  }
  async all<T = Record<string, unknown>>() { return this.execute() as unknown as { results: T[]; success: boolean; meta: { changes: number } }; }
  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> { const row = this.db.raw.prepare(this.sql).get(...this.values); return (column ? row?.[column] : row) as T ?? null; }
  async run() { return this.execute(); }
}
