import { CALLBACK_PATH, authorizeUrl, pkce, savePending } from "../../lib/swiftly-connect";

// Starts "Connect Swiftly". ?identity=<id> turns Swiftly on for that address; ?all=1 for every address
// on the account. The verifier and choice wait in D1 under the state for the callback (savePending).
export default defineEventHandler(async (event) => {
	const ctx = await jmapContext(event);
	// This GET writes a pending row, so it answers page navigations only. An <img> in a message pointing
	// here would otherwise add a row each time the message was opened.
	// "empty" is the service worker forwarding a navigation to a customer's own Worker (app/sw.ts), which
	// forwards this path for navigations only.
	const dest = getRequestHeader(event, "sec-fetch-dest");
	if (dest && dest !== "document" && dest !== "empty") throw createError({ statusCode: 400 });
	const q = getQuery(event);
	const account = ctx.accountRows[0]?.id;
	if (!account) throw createError({ statusCode: 404 });
	const identity = typeof q.identity === "string" ? q.identity : "";
	if (identity && !(await ctx.db.prepare("SELECT 1 FROM identities WHERE id = ? AND account_id = ?").bind(identity, account).first())) throw createError({ statusCode: 404 });
	const env = cfEnv(event);
	// The callback must come back to the origin you started from: production, or the `nuxt dev` server
	// (whose proxy rewrites Host and Origin, so the page's Referer is what tells them apart).
	const allowed = [env.APP_ORIGIN, (env as { DEV_ORIGIN?: string }).DEV_ORIGIN].filter(Boolean) as string[];
	let from = "";
	try {
		from = new URL(getRequestHeader(event, "referer") ?? "").origin;
	} catch {}
	const base = allowed.includes(from) ? from : env.APP_ORIGIN;
	const swiftly = (env as { SWIFTLY_BASE?: string }).SWIFTLY_BASE || undefined;
	const { verifier, challenge, state } = await pkce();
	await savePending(ctx.db, state, { verifier, account, identity, all: q.all === "1", base, swiftly });
	return sendRedirect(event, authorizeUrl(`${base}${CALLBACK_PATH}`, state, challenge, swiftly));
});
