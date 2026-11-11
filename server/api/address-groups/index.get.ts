// Your address groups (migration 0025), in order.
export default defineEventHandler(async (event) => {
	const { db, userId } = await jmapContext(event);
	const r = await db
		.prepare("SELECT id, name, patterns_json FROM address_groups WHERE user_id = ? ORDER BY position")
		.bind(userId)
		.all<{ id: string; name: string; patterns_json: string }>();
	return { groups: r.results.map((g) => ({ id: g.id, name: g.name, patterns: JSON.parse(g.patterns_json) as string[] })) };
});
