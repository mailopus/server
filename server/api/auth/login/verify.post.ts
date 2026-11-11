export default defineEventHandler(async (event) => {
	const { challengeId, response } = await readBody(event);
	const challenge = await takeChallenge(event, challengeId);
	const userId = await checkAssertion(event, challenge.challenge, response, () => createError({ statusCode: 401, statusMessage: "sign-in failed" }));
	// With an authenticator turned on, the passkey earns a five-minute ticket for the code step (login/totp), not a session.
	const totp = await cfEnv(event).DB.prepare("SELECT totp_secret FROM users WHERE id = ?").bind(userId).first<string>("totp_secret");
	if (totp) return { ok: true, totp: await saveChallenge(event, "totp", userId) };
	return { ok: true, token: await startSession(event, userId) };
});
