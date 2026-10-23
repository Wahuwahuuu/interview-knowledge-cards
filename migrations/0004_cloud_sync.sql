CREATE TABLE cloud_sync_state(user_id TEXT PRIMARY KEY REFERENCES users(id),epoch TEXT NOT NULL);
INSERT INTO cloud_sync_state SELECT id,lower(hex(randomblob(16))) FROM users;
CREATE TABLE cloud_sync_codes(user_id TEXT PRIMARY KEY REFERENCES users(id),token_hash TEXT UNIQUE NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE cloud_sync_devices(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,created_at TEXT NOT NULL,last_seen TEXT NOT NULL,expires_at TEXT NOT NULL);
CREATE INDEX cloud_sync_devices_user ON cloud_sync_devices(user_id);
CREATE TABLE cloud_sync_receipts(user_id TEXT NOT NULL REFERENCES users(id),device_id TEXT NOT NULL,op_id TEXT NOT NULL,digest TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(user_id,device_id,op_id));
CREATE TRIGGER cloud_sync_new_user AFTER INSERT ON users BEGIN INSERT INTO cloud_sync_state VALUES(NEW.id,lower(hex(randomblob(16)))); END;
CREATE TRIGGER cloud_sync_credentials_changed AFTER UPDATE OF password_hash,status ON users
WHEN OLD.password_hash IS NOT NEW.password_hash OR NEW.status='disabled'
BEGIN DELETE FROM cloud_sync_devices WHERE user_id=NEW.id; DELETE FROM cloud_sync_codes WHERE user_id=NEW.id; END;
