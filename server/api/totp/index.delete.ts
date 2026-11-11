// Turns the authenticator off. The passkey is asked for first. Someone who lost the authenticator signs in
// with a recovery code and a new passkey (api/auth/recover), which skips this step, then turns it off here.
export default defineEventHandler(async (event) => {
	const userId = await requireRecentVerification(event);
	await cfEnv(event).DB.prepare("UPDATE users SET totp_secret = NULL, totp_pending = NULL WHERE id = ?").bind(userId).run();
	return { enabled: false };
});
