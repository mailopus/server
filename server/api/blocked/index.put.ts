// Block (blocked: true) or unblock one sender pattern across this user's accounts.
// Mail from a blocked sender lands in Junk from the next delivery on; nothing already
// delivered moves, because rewriting history on a block would be a surprise.
export default defineEventHandler(async (event) => {
	const { db, accountRows } = await jmapContext(event);
	const { pattern, blocked } = await readBody<{ pattern?: unknown; blocked?: unknown }>(event);
	// Either "someone@host.example" or "@host.example". A bare TLD is refused: "@com" would
	// block most of the internet from one stray click.
	if (typeof pattern !== "string" || typeof blocked !== "boolean") throw createError({ statusCode: 400 });
	const p = pattern.trim().toLowerCase();
	if (!/^(?:[^@\s]+)?@(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(p)) throw createError({ statusCode: 400, statusMessage: "bad pattern" });
	const ids = accountRows.map((a) => a.id);
	if (!ids.length) throw createError({ statusCode: 404 });
	await db.batch(
		ids.map((id) =>
			blocked
				? db.prepare("INSERT OR IGNORE INTO blocked_senders (account_id, pattern, created_at) VALUES (?, ?, ?)").bind(id, p, Date.now())
				: db.prepare("DELETE FROM blocked_senders WHERE account_id = ? AND pattern = ?").bind(id, p),
		),
	);
	return { ok: true, pattern: p };
});
