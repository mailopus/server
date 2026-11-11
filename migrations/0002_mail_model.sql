-- Spike rows only; their raw files stay in R2.
DROP TABLE messages;

CREATE TABLE accounts (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	-- JMAP state counter. Only the account's Durable Object writes it.
	modseq INTEGER NOT NULL DEFAULT 0
);

-- Exact addresses, or '*@domain' as a catch-all. Exact wins.
CREATE TABLE addresses (
	address TEXT PRIMARY KEY,
	account_id TEXT NOT NULL REFERENCES accounts (id)
);

CREATE TABLE mailboxes (
	id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL REFERENCES accounts (id),
	name TEXT NOT NULL,
	role TEXT,
	-- IMAP bookkeeping, kept so a bridge stays possible without a migration.
	uidvalidity INTEGER NOT NULL,
	uidnext INTEGER NOT NULL DEFAULT 1,
	UNIQUE (account_id, role)
);

CREATE TABLE emails (
	id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL REFERENCES accounts (id),
	thread_id TEXT NOT NULL,
	blob_key TEXT NOT NULL,
	message_id TEXT,
	subject TEXT,
	from_json TEXT NOT NULL DEFAULT '[]',
	to_json TEXT NOT NULL DEFAULT '[]',
	cc_json TEXT NOT NULL DEFAULT '[]',
	sent_at INTEGER,
	received_at INTEGER NOT NULL,
	size INTEGER NOT NULL,
	preview TEXT NOT NULL DEFAULT '',
	has_attachment INTEGER NOT NULL DEFAULT 0,
	auth_results TEXT,
	keywords_json TEXT NOT NULL DEFAULT '{}',
	created_modseq INTEGER NOT NULL,
	updated_modseq INTEGER NOT NULL
);
CREATE INDEX emails_account_received ON emails (account_id, received_at DESC);
CREATE INDEX emails_account_message_id ON emails (account_id, message_id);
CREATE INDEX emails_thread ON emails (thread_id);
CREATE INDEX emails_account_updated ON emails (account_id, updated_modseq);

CREATE TABLE email_mailboxes (
	email_id TEXT NOT NULL REFERENCES emails (id),
	mailbox_id TEXT NOT NULL REFERENCES mailboxes (id),
	uid INTEGER NOT NULL,
	PRIMARY KEY (email_id, mailbox_id),
	UNIQUE (mailbox_id, uid)
);

CREATE VIRTUAL TABLE emails_fts USING fts5 (
	email_id UNINDEXED,
	subject,
	addresses,
	body,
	tokenize = 'porter unicode61'
);
