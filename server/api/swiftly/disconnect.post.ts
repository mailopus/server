// Forgets the Swiftly connection and turns Swiftly off for addresses that relied on it. Signatures stay
// as they are; an address with its own pasted token keeps syncing with that.
// ponytail: doesn't revoke the token at Swiftly; revoke it in the Swiftly console (it's labeled Mailopus).
export default defineEventHandler(async (event) => {
	const ctx = await jmapContext(event);
	const account = ctx.accountRows[0]?.id;
	if (!account) throw createError({ statusCode: 404 });
	await ctx.db.batch([
		ctx.db.prepare("DELETE FROM signature_connections WHERE account_id = ? AND provider = 'swiftly'").bind(account),
		ctx.db.prepare("UPDATE identities SET signature_provider = NULL, signature_status = NULL WHERE account_id = ? AND signature_provider = 'swiftly' AND json_extract(signature_config, '$.token') IS NULL").bind(account),
	]);
	return { ok: true };
});
