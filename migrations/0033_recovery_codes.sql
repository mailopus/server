-- Recovery codes (server/lib/recovery.ts): ten per user, for when no passkey works. Only SHA-256 hashes are
-- stored: the codes are random (80 bits), like session tokens. A code opens passkey registration once.
-- used_at stays on the row, so Settings counts the ones left and a used code is refused, not unknown.
CREATE TABLE recovery_codes (
	user_id TEXT NOT NULL REFERENCES users (id),
	code_hash TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	used_at INTEGER,
	PRIMARY KEY (user_id, code_hash)
);
-- Recovery looks a code up by its hash before it knows the user.
CREATE INDEX recovery_codes_hash ON recovery_codes (code_hash);

-- App passwords: the network that last used one, as a /24 or /48 prefix, and an optional expiry (ms).
-- Both nullable: passwords from before this never expire and fill last_ip in at their next use.
ALTER TABLE app_passwords ADD COLUMN last_ip TEXT;
ALTER TABLE app_passwords ADD COLUMN expires_at INTEGER;
