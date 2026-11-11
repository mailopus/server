// Ground truth for the writer-maintained mailbox counts and placement dates. The backfill script uses it
// once after migration 0009; the tests use it to check the writer never drifts from it.

/** Fills received_at on placements that don't have it yet (rows from before 0009). */
export const BACKFILL_DATES_SQL = `UPDATE email_mailboxes SET received_at = (SELECT received_at FROM emails WHERE emails.id = email_mailboxes.email_id)
	WHERE rowid IN (SELECT rowid FROM email_mailboxes WHERE received_at IS NULL LIMIT ?)`;

/** Recomputes every mailbox's counts for one account from the rows. */
export const RECOUNT_SQL = `UPDATE mailboxes SET
	total_emails = (SELECT count(*) FROM email_mailboxes em JOIN emails e ON e.id = em.email_id
		WHERE em.mailbox_id = mailboxes.id AND e.destroyed_modseq IS NULL),
	unread_emails = (SELECT count(*) FROM email_mailboxes em JOIN emails e ON e.id = em.email_id
		WHERE em.mailbox_id = mailboxes.id AND e.destroyed_modseq IS NULL AND json_extract(e.keywords_json, '$."$seen"') IS NULL)
	WHERE account_id = ?`;

/** The same counts as RECOUNT_SQL, read-only, for comparing. */
export const COUNTS_SQL = `SELECT m.id, m.total_emails AS stored_total, m.unread_emails AS stored_unread,
	(SELECT count(*) FROM email_mailboxes em JOIN emails e ON e.id = em.email_id WHERE em.mailbox_id = m.id AND e.destroyed_modseq IS NULL) AS total,
	(SELECT count(*) FROM email_mailboxes em JOIN emails e ON e.id = em.email_id WHERE em.mailbox_id = m.id AND e.destroyed_modseq IS NULL
		AND json_extract(e.keywords_json, '$."$seen"') IS NULL) AS unread
	FROM mailboxes m WHERE m.account_id = ?`;

/** Per-address counts (mailbox_counts, migration 0030) for one account recomputed from the rows, and what's
 * stored, side by side. The triggers keep them equal; tests check that, and a mismatch means rebuild. */
export const ADDRESS_COUNTS_SQL = `WITH truth AS (
		SELECT em.mailbox_id, coalesce(e.addressed_to, '') AS addressed_to, count(*) AS total,
			sum(json_extract(e.keywords_json, '$."$seen"') IS NULL) AS unread
		FROM email_mailboxes em JOIN emails e ON e.id = em.email_id JOIN mailboxes m ON m.id = em.mailbox_id
		WHERE m.account_id = ?1 GROUP BY 1, 2)
	SELECT coalesce(t.mailbox_id, c.mailbox_id) AS mailbox_id, coalesce(t.addressed_to, c.addressed_to) AS addressed_to,
		coalesce(t.total, 0) AS total, coalesce(t.unread, 0) AS unread, coalesce(c.total, 0) AS stored_total, coalesce(c.unread, 0) AS stored_unread
	FROM truth t FULL JOIN (SELECT mc.* FROM mailbox_counts mc JOIN mailboxes m ON m.id = mc.mailbox_id WHERE m.account_id = ?1) c
		ON c.mailbox_id = t.mailbox_id AND c.addressed_to = t.addressed_to`;

/** Rebuilds mailbox_counts for one account from the rows. */
export const REBUILD_ADDRESS_COUNTS_SQL = [
	`DELETE FROM mailbox_counts WHERE mailbox_id IN (SELECT id FROM mailboxes WHERE account_id = ?1)`,
	`INSERT INTO mailbox_counts (mailbox_id, addressed_to, total, unread)
	SELECT em.mailbox_id, coalesce(e.addressed_to, ''), count(*), sum(json_extract(e.keywords_json, '$."$seen"') IS NULL)
	FROM email_mailboxes em JOIN emails e ON e.id = em.email_id JOIN mailboxes m ON m.id = em.mailbox_id
	WHERE m.account_id = ?1 GROUP BY em.mailbox_id, coalesce(e.addressed_to, '')`,
];
