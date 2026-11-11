import { oneClick } from "../lib/unsubscribe";

// One-click unsubscribe (RFC 8058) for a message you can read. Always 200 with { ok, status, error? },
// so the UI can say what the list answered.
export default defineEventHandler(async (event) => {
	const ctx = await jmapContext(event);
	const { accountId, emailId } = await readBody<{ accountId?: unknown; emailId?: unknown }>(event);
	if (typeof accountId !== "string" || typeof emailId !== "string") throw createError({ statusCode: 400 });
	if (!ctx.accounts.has(accountId)) throw createError({ statusCode: 404 });
	return oneClick(ctx, accountId, emailId);
});
