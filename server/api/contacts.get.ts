import { type Contact, contacts } from "../lib/contacts";

// Compose autocomplete across all your accounts. See server/lib/contacts.ts for the ranking.
export default defineEventHandler(async (event) => {
	const ctx = await jmapContext(event);
	const out = new Map<string, Contact>();
	for (const { id } of ctx.accountRows) {
		for (const r of await contacts(ctx.db, id)) {
			const cur = out.get(r.email);
			out.set(r.email, cur ? { ...cur, score: cur.score + r.score, last: Math.max(cur.last, r.last), name: cur.name ?? r.name } : r);
		}
	}
	setResponseHeader(event, "cache-control", "private, max-age=300");
	return [...out.values()].sort((a, b) => b.score - a.score || b.last - a.last).slice(0, 1000).map(({ email, name }) => ({ email, name }));
});
