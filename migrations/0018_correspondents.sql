-- Addresses this account has written to. "Have I ever mailed this person" is the strongest
-- local spam signal available, and the only cheap way to ask it: contacts() answers the same
-- question from the newest 5,000 emails with json_each, which reads tens of thousands of rows
-- and is far too heavy to run per inbound message.
CREATE TABLE correspondents (
	account_id TEXT NOT NULL REFERENCES accounts (id),
	address TEXT NOT NULL,
	first_at INTEGER NOT NULL,
	PRIMARY KEY (account_id, address)
);

-- Maintained by trigger rather than by the senders, so every path that files a message in Sent
-- is covered: immediate send, a scheduled send moving out of Scheduled, and an import of your
-- Gmail Sent mail. The writer pushes the emails INSERT before place() pushes email_mailboxes
-- (see begin() in server/lib/jmap/write.ts) and D1 runs a batch in order, so the emails row is
-- always visible here.
CREATE TRIGGER correspondents_on_send AFTER INSERT ON email_mailboxes
WHEN (SELECT role FROM mailboxes WHERE id = NEW.mailbox_id) = 'sent'
BEGIN
	INSERT OR IGNORE INTO correspondents (account_id, address, first_at)
	SELECT e.account_id, lower(json_extract(j.value, '$.email')), e.received_at
	FROM emails e, json_each(e.to_json) j
	WHERE e.id = NEW.email_id AND json_extract(j.value, '$.email') LIKE '%@%';
	INSERT OR IGNORE INTO correspondents (account_id, address, first_at)
	SELECT e.account_id, lower(json_extract(j.value, '$.email')), e.received_at
	FROM emails e, json_each(e.cc_json) j
	WHERE e.id = NEW.email_id AND json_extract(j.value, '$.email') LIKE '%@%';
END;

-- Backfill from the Sent mail already stored. One statement; on a fresh database it does nothing.
INSERT OR IGNORE INTO correspondents (account_id, address, first_at)
SELECT account_id, address, min(received_at) FROM (
	SELECT e.account_id, lower(json_extract(j.value, '$.email')) AS address, e.received_at
	FROM emails e
	JOIN email_mailboxes em ON em.email_id = e.id
	JOIN mailboxes m ON m.id = em.mailbox_id AND m.role = 'sent'
	JOIN json_each(e.to_json) j
	WHERE e.destroyed_modseq IS NULL AND json_extract(j.value, '$.email') LIKE '%@%'
	UNION ALL
	SELECT e.account_id, lower(json_extract(j.value, '$.email')), e.received_at
	FROM emails e
	JOIN email_mailboxes em ON em.email_id = e.id
	JOIN mailboxes m ON m.id = em.mailbox_id AND m.role = 'sent'
	JOIN json_each(e.cc_json) j
	WHERE e.destroyed_modseq IS NULL AND json_extract(j.value, '$.email') LIKE '%@%'
) GROUP BY 1, 2;
