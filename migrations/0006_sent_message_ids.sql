-- Cloudflare Email Sending assigns its own Message-ID to each outgoing copy (one per recipient).
-- Replies reference those, so threading has to know them.
CREATE TABLE sent_message_ids (
	account_id TEXT NOT NULL REFERENCES accounts (id),
	message_id TEXT NOT NULL,
	thread_id TEXT NOT NULL,
	PRIMARY KEY (account_id, message_id)
);
