// Sign out everywhere else: every session of this user but the one asking. Needs a recent passkey check,
// or a stolen token could sign the owner out of every device and keep itself.
export default defineEventHandler(async (event) => {
	const userId = await requireRecentVerification(event);
	return { ok: true, ended: await endSessions(event, userId, { except: await sessionHash(event) }) };
});
