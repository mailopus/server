// The sender patterns this user's accounts have blocked. See migration 0021 for the two shapes.
export default defineEventHandler(async (event) => {
	const { db, accountRows } = await jmapContext(event);
	const ids = accountRows.map((a) => a.id);
	if (!ids.length) return { patterns: [] };
	const r = await db
		.prepare(`SELECT DISTINCT pattern FROM blocked_senders WHERE account_id IN (${ids.map(() => "?").join(", ")}) ORDER BY pattern`)
		.bind(...ids)
		.all<{ pattern: string }>();
	return { patterns: (r.results ?? []).map((x) => x.pattern) };
});
