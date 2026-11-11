// Stop (excluded: true) or resume highlighting one sender address.
export default defineEventHandler(async (event) => {
	const { userId, db } = await jmapContext(event);
	const { address, excluded } = await readBody<{ address?: unknown; excluded?: unknown }>(event);
	if (typeof address !== "string" || !/^[^@\s]+@[^@\s]+$/.test(address) || typeof excluded !== "boolean") throw createError({ statusCode: 400 });
	const a = address.toLowerCase();
	await (excluded
		? db.prepare("INSERT OR IGNORE INTO highlight_exclusions (user_id, address, created_at) VALUES (?, ?, ?)").bind(userId, a, Date.now())
		: db.prepare("DELETE FROM highlight_exclusions WHERE user_id = ? AND address = ?").bind(userId, a)
	).run();
	return { ok: true };
});
