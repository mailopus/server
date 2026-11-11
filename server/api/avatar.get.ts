// Your avatar for the user menu: the Gravatar of the first of your addresses that has one, fetched here
// so Gravatar sees Cloudflare instead of your IP, and the app's CSP can stay img-src 'self'.
// One 160px image (the avatar shows at 32px; 160 stays sharp on high-density screens).
// 404 when none of your addresses has one; the menu shows initials then.
export default defineEventHandler(async (event) => {
	// The dev server runs on your machine: asking Gravatar from there would show it your IP.
	if (import.meta.dev) throw createError({ statusCode: 404 });
	const { db, accountRows } = await jmapContext(event);
	const ids = accountRows.map((a) => a.id);
	if (!ids.length) throw createError({ statusCode: 404 });
	const rows = await db
		.prepare(`SELECT address FROM addresses WHERE account_id IN (${ids.map(() => "?").join(", ")}) ORDER BY rowid`)
		.bind(...ids)
		.all<{ address: string }>();

	// ponytail: one Gravatar lookup per address, in parallel; fine for dozens of addresses, cache the winner if it grows.
	const tries = await Promise.all(
		(rows.results ?? []).map(async ({ address }) => {
			const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(address.trim().toLowerCase()));
			const hash = [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
			return fetch(`https://www.gravatar.com/avatar/${hash}?s=160&d=404`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
		}),
	);
	const hit = tries.find((r) => r?.ok && r.headers.get("content-type")?.startsWith("image/") && !r.headers.get("content-type")?.startsWith("image/svg"));
	for (const r of tries) if (r && r !== hit) r.body?.cancel();
	if (!hit) {
		setResponseHeader(event, "cache-control", "private, max-age=3600");
		throw createError({ statusCode: 404 });
	}
	setResponseHeaders(event, {
		"content-type": hit.headers.get("content-type")!,
		"x-content-type-options": "nosniff",
		"cache-control": "private, max-age=86400",
	});
	return hit.body;
});
