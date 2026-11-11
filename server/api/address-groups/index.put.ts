// Replaces your address groups with the list sent, in that order. A pattern is an address or "@domain";
// anything else is dropped. A group needs a name.
import { cleanPattern } from "../../lib/addressed";

const MAX_GROUPS = 50;
const MAX_PATTERNS = 200;

export default defineEventHandler(async (event) => {
	const { db, userId } = await jmapContext(event);
	const { groups } = await readBody<{ groups?: unknown }>(event);
	if (!Array.isArray(groups) || groups.length > MAX_GROUPS) throw createError({ statusCode: 400 });
	const clean = groups.map((g: { id?: unknown; name?: unknown; patterns?: unknown }) => {
		const name = typeof g?.name === "string" ? g.name.trim().slice(0, 60) : "";
		const id = typeof g?.id === "string" && /^[a-z0-9-]{1,40}$/.test(g.id) ? g.id : crypto.randomUUID();
		const patterns = Array.isArray(g?.patterns) ? [...new Set(g.patterns.slice(0, MAX_PATTERNS).map(cleanPattern).filter((p): p is string => !!p))] : [];
		if (!name) throw createError({ statusCode: 400, statusMessage: "every group needs a name" });
		return { id, name, patterns };
	});
	await db.batch([
		db.prepare("DELETE FROM address_groups WHERE user_id = ?").bind(userId),
		...clean.map((g, i) =>
			db.prepare("INSERT INTO address_groups (user_id, id, name, patterns_json, position) VALUES (?, ?, ?, ?, ?)").bind(userId, g.id, g.name, JSON.stringify(g.patterns), i),
		),
	]);
	return { groups: clean };
});
