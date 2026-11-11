// Whether sign-in asks for an authenticator code after the passkey.
export default defineEventHandler(async (event) => {
	const userId = await requireSessionUser(event);
	const secret = await cfEnv(event).DB.prepare("SELECT totp_secret FROM users WHERE id = ?").bind(userId).first<string | null>("totp_secret");
	return { enabled: !!secret };
});
