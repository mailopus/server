-- Compose: per-identity signatures, scheduled sends, and a Scheduled mailbox for mail waiting to go.

-- textSignature/htmlSignature are JMAP Identity properties (RFC 8621 §6). signature_provider names an
-- extension that supplies a live signature instead (server/lib/signatures.ts); its config is JSON.
ALTER TABLE identities ADD COLUMN text_signature TEXT NOT NULL DEFAULT '';
ALTER TABLE identities ADD COLUMN html_signature TEXT NOT NULL DEFAULT '';
ALTER TABLE identities ADD COLUMN signature_provider TEXT;
ALTER TABLE identities ADD COLUMN signature_config TEXT NOT NULL DEFAULT '{}';

-- One row per EmailSubmission held for later (RFC 4865 HOLDUNTIL). The account's Durable Object
-- alarm sends due rows, then deletes them.
CREATE TABLE scheduled_submissions (
	id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL REFERENCES accounts (id),
	email_id TEXT NOT NULL,
	identity_id TEXT NOT NULL,
	rcpts_json TEXT NOT NULL,
	send_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX scheduled_due ON scheduled_submissions (account_id, send_at);

INSERT INTO mailboxes (id, account_id, name, role, uidvalidity)
SELECT lower(hex(randomblob(16))), id, 'Scheduled', 'scheduled', unixepoch() FROM accounts
WHERE id NOT IN (SELECT account_id FROM mailboxes WHERE role = 'scheduled');
