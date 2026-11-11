// Forgets one of the signed-in user's push subscriptions.
export default defineEventHandler(async (event) => {
	const { userId, db } = await jmapContext(event);
	const { endpoint } = await readBody<{ endpoint?: string }>(event);
	if (typeof endpoint !== "string") throw createError({ statusCode: 400 });
	await db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?").bind(endpoint, userId).run();
	return { ok: true };
});
