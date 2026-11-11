// Which of your addresses an email reached, stored as emails.addressed_to (migration 0025) so mail
// views can be narrowed to a group of addresses. Mirrors deliveredTo() in app/utils/postmark.ts, which
// draws the postmark on each row; tests/addressed.test.ts checks the two agree.

type Addr = { email: string };
type Parsed = { from?: Addr[] | null; to?: Addr[] | null; cc?: Addr[] | null; deliveredTo?: string[] | null };

/** The first of yours among the recipients, else your From, else the first Delivered-To, else the first recipient. */
export function addressedTo(mine: Set<string>, m: Parsed): string | null {
	for (const a of [...(m.to ?? []), ...(m.cc ?? [])]) if (mine.has(a.email.toLowerCase())) return a.email.toLowerCase();
	for (const a of m.from ?? []) if (mine.has(a.email.toLowerCase())) return a.email.toLowerCase();
	return (m.deliveredTo?.[0] ?? (m.to?.[0] ?? m.cc?.[0])?.email)?.toLowerCase() ?? null;
}

const MINE = "SELECT lower(email) FROM identities WHERE account_id = emails.account_id";
/** The same rule in SQL, for rows stored before the column existed. Run until it changes nothing. */
export const ADDRESSED_BACKFILL = `UPDATE emails SET addressed_to = coalesce(
	(SELECT lower(j.value ->> '$.email') FROM (
		SELECT value, 0 AS o, key AS k FROM json_each(emails.to_json) UNION ALL SELECT value, 1, key FROM json_each(emails.cc_json)
	) j WHERE lower(j.value ->> '$.email') IN (${MINE}) ORDER BY j.o, j.k LIMIT 1),
	(SELECT lower(j.value ->> '$.email') FROM json_each(emails.from_json) j WHERE lower(j.value ->> '$.email') IN (${MINE}) ORDER BY j.key LIMIT 1),
	lower(emails.delivered_json ->> '$[0]'),
	lower(emails.to_json ->> '$[0].email'),
	lower(emails.cc_json ->> '$[0].email'),
	''
) WHERE rowid IN (SELECT rowid FROM emails WHERE addressed_to IS NULL LIMIT ?)`;

/** SQL for "reached one of these": exact addresses, or "@domain" for a domain and its subdomains. */
export function addressedSql(patterns: string[]) {
	const exact = patterns.filter((p) => !p.startsWith("@"));
	const domains = patterns.filter((p) => p.startsWith("@")).map((p) => p.slice(1));
	const parts = [
		...(exact.length ? [`e.addressed_to IN (${exact.map(() => "?").join(",")})`] : []),
		...domains.flatMap(() => ["e.addressed_to LIKE ? ESCAPE '\\'", "e.addressed_to LIKE ? ESCAPE '\\'"]),
	];
	const esc = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
	return {
		// IS NOT NULL spelled out: it's what lets the partial index emails_account_addressed (migration 0029)
		// serve these filters. SQLite infers it from = and IN, but not from LIKE.
		sql: parts.length ? `(e.addressed_to IS NOT NULL AND (${parts.join(" OR ")}))` : "0",
		params: [...exact, ...domains.flatMap((d) => [`%@${esc(d)}`, `%.${esc(d)}`])],
	};
}

/** An address or "@domain", lowercased; null when it's neither. */
export function cleanPattern(p: unknown): string | null {
	if (typeof p !== "string") return null;
	const s = p.trim().toLowerCase();
	return /^(?:[^@\s]+)?@(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(s) ? s : null;
}
