-- One provider connection per account (Swiftly's agent token from "Connect Swiftly"), shared by every
-- identity that turns the provider on, so connecting once covers all your addresses.
CREATE TABLE signature_connections (
	account_id TEXT NOT NULL REFERENCES accounts (id),
	provider TEXT NOT NULL,
	-- Secrets live here (the token). Never returned to clients.
	config TEXT NOT NULL DEFAULT '{}',
	-- Who the provider says you are, for display: {"memberEmail": ..., "org": ...}.
	info TEXT NOT NULL DEFAULT '{}',
	created_at INTEGER NOT NULL,
	PRIMARY KEY (account_id, provider)
);
