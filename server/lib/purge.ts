// Purges tombstones: rows of destroyed emails, kept so Email/changes can tell a client what went.
// Nothing prunes them otherwise, and they outnumber live mail after a big cleanup or a deduplicated import
// (146k of 211k rows on one instance), which makes every cold read of the table slower.
//
// Off unless PURGE_TOMBSTONES_DAYS is set (wrangler.jsonc vars). Each cron run walks a slice of every
// account in updated_modseq order, which is also the order emails were destroyed in, deletes the tombstones
// older than that many days, and stops at the first younger one. accounts.purged_modseq records the newest
// state a tombstone was removed for: Email/changes refuses an older sinceState, and the client resyncs.
// Plain module so tests can run it.

/** Rows read per account per run. A run is every 5 minutes, so about 140k rows a day per account. */
export const PURGE_SLICE = 500;

type Row = { id: string; updated_modseq: number; destroyed_modseq: number | null; destroyed_at: number | null };

/** The setting as days, or null when purging is off. 0 purges every tombstone. */
export function purgeDays(env: object): number | null {
	const raw = (env as { PURGE_TOMBSTONES_DAYS?: string | number }).PURGE_TOMBSTONES_DAYS;
	const n = Number(raw);
	return raw === undefined || raw === "" || !Number.isFinite(n) || n < 0 ? null : n;
}

/** One slice of one account. Returns how many tombstones went. */
export async function purgeAccount(db: D1Database, account: string, cursor: number, days: number, now = Date.now(), slice = PURGE_SLICE): Promise<number> {
	const rows = await db
		.prepare("SELECT id, updated_modseq, destroyed_modseq, destroyed_at FROM emails WHERE account_id = ? AND updated_modseq > ? ORDER BY updated_modseq LIMIT ?")
		.bind(account, cursor, slice)
		.all<Row>();
	const cutoff = now - days * 86_400_000;
	const gone: Row[] = [];
	let reached = cursor;
	for (const r of rows.results) {
		// A tombstone from before destroyed_at existed has none, and is older than any setting.
		if (r.destroyed_modseq !== null && (r.destroyed_at ?? 0) > cutoff) break;
		if (r.destroyed_modseq !== null) gone.push(r);
		reached = r.updated_modseq;
	}
	if (reached === cursor) return 0;
	const stmts: D1PreparedStatement[] = [];
	// 90 ids a statement: D1 allows 100 bound parameters.
	for (let i = 0; i < gone.length; i += 90) {
		const ids = gone.slice(i, i + 90).map((r) => r.id);
		const marks = ids.map(() => "?").join(",");
		// A destroyed email has no placements left; this is for a row an old bug might have stranded.
		stmts.push(db.prepare(`DELETE FROM email_mailboxes WHERE email_id IN (${marks})`).bind(...ids));
		// destroyed_modseq again in the WHERE: nothing here may ever delete a live message.
		stmts.push(db.prepare(`DELETE FROM emails WHERE account_id = ? AND destroyed_modseq IS NOT NULL AND id IN (${marks})`).bind(account, ...ids));
	}
	const floor = gone.length ? gone.at(-1)!.destroyed_modseq! : 0;
	stmts.push(db.prepare("UPDATE accounts SET purge_cursor = ?, purged_modseq = max(purged_modseq, ?) WHERE id = ?").bind(reached, floor, account));
	await db.batch(stmts);
	return gone.length;
}

/** Uploads are scratch space: a file waits there until the draft it's attached to is saved, which copies it into the message. */
export const UPLOAD_DAYS = 7;

/** Deletes uploads older than UPLOAD_DAYS, a page of the bucket's upload/ prefix each run. Returns how many went. */
export async function sweepUploads(mail: R2Bucket, now = Date.now()): Promise<number> {
	const page = await mail.list({ prefix: "upload/", limit: 500 });
	const old = page.objects.filter((o) => o.uploaded.getTime() < now - UPLOAD_DAYS * 86_400_000).map((o) => o.key);
	if (old.length) await mail.delete(old);
	return old.length;
}

/** For the cron. Does nothing unless the setting is there. */
export async function purgeTombstones(env: { DB: D1Database }): Promise<number> {
	const days = purgeDays(env);
	if (days === null) return 0;
	const accounts = await env.DB.prepare("SELECT id, purge_cursor FROM accounts").all<{ id: string; purge_cursor: number }>();
	let n = 0;
	for (const a of accounts.results) n += await purgeAccount(env.DB, a.id, a.purge_cursor, days);
	return n;
}
