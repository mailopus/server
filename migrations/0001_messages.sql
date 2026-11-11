CREATE TABLE messages (
	id TEXT PRIMARY KEY,
	received_at INTEGER NOT NULL,
	env_from TEXT NOT NULL,
	env_to TEXT NOT NULL,
	message_id TEXT,
	subject TEXT,
	auth_results TEXT,
	size INTEGER NOT NULL,
	r2_key TEXT NOT NULL
);
CREATE INDEX messages_to_received ON messages (env_to, received_at DESC);
