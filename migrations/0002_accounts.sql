PRAGMA foreign_keys = ON;
CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE, display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  password_hash TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
INSERT INTO users(id,email,display_name,role,created_at,updated_at) VALUES ('admin',NULL,'管理员','admin',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,expires_at TEXT NOT NULL);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE auth_limits (key TEXT PRIMARY KEY,window_start INTEGER NOT NULL,attempts INTEGER NOT NULL);
CREATE TABLE app_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT INTO app_settings(key,value) VALUES ('registration_open','true');
CREATE TABLE user_library_meta (user_id TEXT PRIMARY KEY REFERENCES users(id),revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE user_mutation_guard (user_id TEXT NOT NULL REFERENCES users(id),id TEXT NOT NULL,ok INTEGER NOT NULL CHECK(ok=1),PRIMARY KEY(user_id,id));
CREATE TABLE user_projects (user_id TEXT NOT NULL REFERENCES users(id),id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(user_id,id));
CREATE TABLE user_topics (user_id TEXT NOT NULL REFERENCES users(id),id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(user_id,id));
CREATE TABLE user_sources (user_id TEXT NOT NULL REFERENCES users(id),id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(user_id,id));
CREATE TABLE user_cards (user_id TEXT NOT NULL REFERENCES users(id),id TEXT NOT NULL,project_id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(user_id,id),FOREIGN KEY(user_id,project_id) REFERENCES user_projects(user_id,id));
CREATE INDEX user_cards_project ON user_cards(user_id,project_id);
CREATE TABLE user_card_topics (user_id TEXT NOT NULL,card_id TEXT NOT NULL,topic_id TEXT NOT NULL,PRIMARY KEY(user_id,card_id,topic_id),FOREIGN KEY(user_id,card_id) REFERENCES user_cards(user_id,id),FOREIGN KEY(user_id,topic_id) REFERENCES user_topics(user_id,id));
CREATE TABLE user_occurrences (user_id TEXT NOT NULL REFERENCES users(id),id TEXT NOT NULL,card_id TEXT NOT NULL,source_id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(user_id,id),FOREIGN KEY(user_id,card_id) REFERENCES user_cards(user_id,id),FOREIGN KEY(user_id,source_id) REFERENCES user_sources(user_id,id));
CREATE INDEX user_occurrences_card ON user_occurrences(user_id,card_id);
CREATE TABLE user_relations (user_id TEXT NOT NULL REFERENCES users(id),id TEXT NOT NULL,from_card_id TEXT NOT NULL,to_card_id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(user_id,id),FOREIGN KEY(user_id,from_card_id) REFERENCES user_cards(user_id,id),FOREIGN KEY(user_id,to_card_id) REFERENCES user_cards(user_id,id));
CREATE TABLE user_card_revisions (user_id TEXT NOT NULL,card_id TEXT NOT NULL,revision INTEGER NOT NULL,saved_at TEXT NOT NULL,action TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(user_id,card_id,revision),FOREIGN KEY(user_id,card_id) REFERENCES user_cards(user_id,id));
CREATE TABLE user_import_batches (user_id TEXT NOT NULL REFERENCES users(id),id TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','applied','cancelled')),base_revision INTEGER NOT NULL,digest TEXT NOT NULL,created_at TEXT NOT NULL,applied_at TEXT,payload TEXT NOT NULL,preview TEXT NOT NULL,PRIMARY KEY(user_id,id));
CREATE INDEX user_import_status ON user_import_batches(user_id,status,created_at);

-- Legacy tables remain as the pre-upgrade snapshot; application code uses user_* only.
INSERT INTO user_library_meta SELECT 'admin',revision FROM library_meta WHERE id=1;
INSERT INTO user_projects SELECT 'admin',id,revision,payload FROM projects;
INSERT INTO user_topics SELECT 'admin',id,revision,payload FROM topics;
INSERT INTO user_sources SELECT 'admin',id,revision,payload FROM sources;
INSERT INTO user_cards SELECT 'admin',id,project_id,revision,payload FROM cards;
INSERT INTO user_card_topics SELECT 'admin',card_id,topic_id FROM card_topics;
INSERT INTO user_occurrences SELECT 'admin',id,card_id,source_id,revision,payload FROM occurrences;
INSERT INTO user_relations SELECT 'admin',id,from_card_id,to_card_id,revision,payload FROM relations;
INSERT INTO user_card_revisions SELECT 'admin',card_id,revision,saved_at,action,payload FROM card_revisions;
INSERT INTO user_import_batches SELECT 'admin',id,status,base_revision,digest,created_at,applied_at,payload,preview FROM import_batches;
