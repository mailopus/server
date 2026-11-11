-- Senders whose domain you've written to are highlighted in the list (from correspondents).
-- These addresses are left out: the automated mail from a domain you otherwise talk to.
CREATE TABLE highlight_exclusions (
	user_id TEXT NOT NULL REFERENCES users (id),
	address TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, address)
);
