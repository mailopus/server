-- A user is a person who signs in. An account is a mailbox store they own; a user can own
-- several once Gmail and IMAP accounts connect.
CREATE TABLE users (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL
);
ALTER TABLE accounts ADD COLUMN user_id TEXT REFERENCES users (id);

CREATE TABLE passkeys (
	-- WebAuthn credential id, base64url.
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users (id),
	public_key TEXT NOT NULL, -- base64url COSE key
	counter INTEGER NOT NULL,
	transports TEXT NOT NULL DEFAULT '[]',
	created_at INTEGER NOT NULL,
	last_used_at INTEGER
);
CREATE INDEX passkeys_user ON passkeys (user_id);

-- Tokens are stored as SHA-256 hex; the raw value only ever lives in the cookie or invite link.
CREATE TABLE sessions (
	token_hash TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users (id),
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL
);
CREATE TABLE invites (
	token_hash TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users (id),
	expires_at INTEGER NOT NULL
);
-- One-time WebAuthn challenges. Deleted on use, so a captured response can't be replayed.
CREATE TABLE challenges (
	id TEXT PRIMARY KEY,
	challenge TEXT NOT NULL,
	user_id TEXT, -- set for registration (from the invite), null for sign-in
	expires_at INTEGER NOT NULL
);
