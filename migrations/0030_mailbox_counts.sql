-- Message counts per mailbox and per address it was sent to (emails.addressed_to), kept by triggers in the
-- same statement as each placement or read-state change. An app password limited to some addresses sums
-- the rows its scope matches (server/lib/jmap/mail.ts, Mailbox/get) instead of counting messages: a few
-- hundred rows instead of the whole account. The unscoped counts on mailboxes stay with the writer.
--
-- Triggers rather than the writer's place()/unplace(), so set-based moves, imports and one-off SQL fixes
-- keep it right too. Every placement counts: the writer removes a message's placements when it's destroyed.
-- addressed_to NULL (rows from before 0025 not yet backfilled) is stored as ''.
CREATE TABLE mailbox_counts (
	mailbox_id TEXT NOT NULL REFERENCES mailboxes (id) ON DELETE CASCADE,
	addressed_to TEXT NOT NULL,
	total INTEGER NOT NULL DEFAULT 0,
	unread INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (mailbox_id, addressed_to)
) WITHOUT ROWID;

INSERT INTO mailbox_counts (mailbox_id, addressed_to, total, unread)
SELECT em.mailbox_id, coalesce(e.addressed_to, ''), count(*), sum(json_extract(e.keywords_json, '$."$seen"') IS NULL)
FROM email_mailboxes em JOIN emails e ON e.id = em.email_id
GROUP BY em.mailbox_id, coalesce(e.addressed_to, '');

CREATE TRIGGER mailbox_counts_place AFTER INSERT ON email_mailboxes BEGIN
	INSERT INTO mailbox_counts (mailbox_id, addressed_to, total, unread)
	SELECT NEW.mailbox_id, coalesce(e.addressed_to, ''), 1, json_extract(e.keywords_json, '$."$seen"') IS NULL
	FROM emails e WHERE e.id = NEW.email_id
	ON CONFLICT (mailbox_id, addressed_to) DO UPDATE SET total = total + 1, unread = unread + excluded.unread;
END;

CREATE TRIGGER mailbox_counts_unplace AFTER DELETE ON email_mailboxes BEGIN
	UPDATE mailbox_counts SET
		total = total - 1,
		unread = unread - (SELECT json_extract(e.keywords_json, '$."$seen"') IS NULL FROM emails e WHERE e.id = OLD.email_id)
	WHERE mailbox_id = OLD.mailbox_id AND addressed_to = (SELECT coalesce(e.addressed_to, '') FROM emails e WHERE e.id = OLD.email_id);
END;

-- Read or unread while staying put. The writer updates keywords before it moves anything, so a move in the
-- same Email/set first flips the old mailboxes here, then unplace() takes the message out in its new state.
CREATE TRIGGER mailbox_counts_seen AFTER UPDATE OF keywords_json ON emails
WHEN (json_extract(OLD.keywords_json, '$."$seen"') IS NULL) != (json_extract(NEW.keywords_json, '$."$seen"') IS NULL)
BEGIN
	UPDATE mailbox_counts SET unread = unread + (CASE WHEN json_extract(NEW.keywords_json, '$."$seen"') IS NULL THEN 1 ELSE -1 END)
	WHERE addressed_to = coalesce(NEW.addressed_to, '') AND mailbox_id IN (SELECT mailbox_id FROM email_mailboxes WHERE email_id = NEW.id);
END;

-- addressed_to filled in or recomputed (the 0025 backfill): move the message's counts to its new address.
-- Assumes keywords_json doesn't change in the same statement; nothing updates both at once.
CREATE TRIGGER mailbox_counts_readdress AFTER UPDATE OF addressed_to ON emails
WHEN coalesce(OLD.addressed_to, '') != coalesce(NEW.addressed_to, '')
BEGIN
	UPDATE mailbox_counts SET total = total - 1, unread = unread - (json_extract(NEW.keywords_json, '$."$seen"') IS NULL)
	WHERE addressed_to = coalesce(OLD.addressed_to, '') AND mailbox_id IN (SELECT mailbox_id FROM email_mailboxes WHERE email_id = NEW.id);
	INSERT INTO mailbox_counts (mailbox_id, addressed_to, total, unread)
	SELECT mailbox_id, coalesce(NEW.addressed_to, ''), 1, json_extract(NEW.keywords_json, '$."$seen"') IS NULL
	FROM email_mailboxes WHERE email_id = NEW.id
	ON CONFLICT (mailbox_id, addressed_to) DO UPDATE SET total = total + 1, unread = unread + excluded.unread;
END;
