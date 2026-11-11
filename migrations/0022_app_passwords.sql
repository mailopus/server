-- Per-device passwords for IMAP and SMTP clients, which can't do passkeys. Mailopus generates them
-- (100 random bits), so SHA-256 is enough, as for session tokens. They authenticate /jmap/* only.
CREATE TABLE app_passwords (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users (id),
	name TEXT NOT NULL,
	token_hash TEXT NOT NULL UNIQUE,
	created_at INTEGER NOT NULL,
	last_used_at INTEGER
);
CREATE INDEX app_passwords_user ON app_passwords (user_id);
