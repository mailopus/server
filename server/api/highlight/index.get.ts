import { highlightSets } from "../../lib/highlight";

// What the list highlights: senders at domains you've written to, minus the addresses you excluded.
export default defineEventHandler(async (event) => {
	const { userId, db, accountRows } = await jmapContext(event);
	const ids = accountRows.map((a) => a.id);
	if (!ids.length) return { domains: [], addresses: [], excluded: [] };
	const marks = ids.map(() => "?").join(", ");
	const [sent, own, excluded] = await db.batch([
		db.prepare(`SELECT DISTINCT address FROM correspondents WHERE account_id IN (${marks})`).bind(...ids),
		db.prepare(`SELECT address FROM addresses WHERE account_id IN (${marks})`).bind(...ids),
		db.prepare("SELECT address FROM highlight_exclusions WHERE user_id = ?").bind(userId),
	]);
	const col = (r: D1Result) => (r.results as { address: string }[]).map((x) => x.address.toLowerCase());
	return { ...highlightSets(col(sent!), col(own!)), excluded: col(excluded!) };
});
