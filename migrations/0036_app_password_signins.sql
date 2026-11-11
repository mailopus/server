-- What mail apps did with app passwords, for Settings: which address each password signed in as, from which
-- network, and wrong passwords tried for your addresses. One row per (password, address, network, outcome),
-- counted. password_id is '' for a failure, which matches no password. Rows older than 30 days are deleted
-- by the cron (server/plugins/purge.ts). network is a /24 or /48, never a full address.
CREATE TABLE app_password_signins (
	user_id TEXT NOT NULL REFERENCES users (id),
	password_id TEXT NOT NULL,
	address TEXT NOT NULL,
	network TEXT NOT NULL,
	ok INTEGER NOT NULL,
	count INTEGER NOT NULL,
	first_at INTEGER NOT NULL,
	last_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, password_id, address, network, ok)
);
CREATE INDEX app_password_signins_last ON app_password_signins (last_at);
