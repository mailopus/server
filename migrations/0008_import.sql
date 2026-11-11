-- Where an email came from outside live delivery, e.g. 'gmail:<user>:<gmail message id>'.
-- Unique per account, so a retried import page never stores a message twice.
ALTER TABLE emails ADD COLUMN source_id TEXT;
CREATE UNIQUE INDEX emails_account_source ON emails (account_id, source_id) WHERE source_id IS NOT NULL;

-- One row per mailbox being imported. The queue consumer advances page_token.
CREATE TABLE import_jobs (
	id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL REFERENCES accounts (id),
	-- Which service-account secret to use: GOOGLE_SA_<WORKSPACE> (e.g. WORK).
	workspace TEXT NOT NULL,
	source_email TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | failed | paused
	page_token TEXT,
	-- Gmail label id -> name, fetched once when the job starts.
	labels_json TEXT,
	pages INTEGER NOT NULL DEFAULT 0,
	imported INTEGER NOT NULL DEFAULT 0,
	merged INTEGER NOT NULL DEFAULT 0,
	skipped INTEGER NOT NULL DEFAULT 0,
	failed INTEGER NOT NULL DEFAULT 0,
	last_error TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
