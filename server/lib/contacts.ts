// Addresses for compose autocomplete, best first. People you've written to (Sent: To and Cc) count
// three times as much as people who wrote to you (From), over your newest 5,000 messages. The client
// loads this once and filters as you type.
// ponytail: computed per request from the newest 5,000 emails; keep a contacts table updated at insert
// if this gets slow or misses people you haven't heard from in a while.
export type Contact = { email: string; name: string | null; score: number; last: number };

export async function contacts(db: D1Database, account: string) {
	const rows = await db.prepare(`
		WITH sent AS (SELECT id FROM mailboxes WHERE account_id = ?1 AND role = 'sent'),
		recent AS (
		SELECT e.from_json, e.to_json, e.cc_json, e.received_at,
			EXISTS (SELECT 1 FROM email_mailboxes m WHERE m.email_id = e.id AND m.mailbox_id IN sent) AS mine
		FROM emails e WHERE e.account_id = ?1 AND e.destroyed_modseq IS NULL
		ORDER BY e.received_at DESC LIMIT 5000
		),
		people AS (
		SELECT j.value AS v, 3 AS w, r.received_at AS t FROM recent r, json_each(r.to_json) j WHERE r.mine
		UNION ALL SELECT j.value, 3, r.received_at FROM recent r, json_each(r.cc_json) j WHERE r.mine
		UNION ALL SELECT j.value, 1, r.received_at FROM recent r, json_each(r.from_json) j WHERE NOT r.mine
		)
		SELECT lower(json_extract(v, '$.email')) AS email, max(nullif(json_extract(v, '$.name'), '')) AS name, sum(w) AS score, max(t) AS last
		FROM people WHERE json_extract(v, '$.email') LIKE '%@%'
		AND lower(json_extract(v, '$.email')) NOT IN (SELECT email FROM identities WHERE account_id = ?1)
		GROUP BY 1 ORDER BY score DESC, last DESC LIMIT 1000`).bind(account).all<Contact>();
	return rows.results;
}
