import { recoveryUser, redeemRecoveryCode } from "../../../lib/recovery";

export default defineEventHandler(async (event) => {
	const { email, code, challengeId, response } = await readBody(event);
	const env = cfEnv(event);
	const fail = () => createError({ statusCode: 403, statusMessage: "recovery failed" });
	const userId = await recoveryUser(env.DB, email, code);
	if (!userId) throw fail();
	const challenge = await takeChallenge(event, challengeId);
	if (challenge.user_id !== userId) throw createError({ statusCode: 400 });
	// The passkey is checked before the code is spent, so a failed ceremony doesn't cost a code.
	const insert = await passkeyInsert(event, userId, challenge.challenge, response);
	if (!(await redeemRecoveryCode(env.DB, userId, code, insert))) throw fail();
	// Only now, with the new passkey stored: the session comes from the passkey, never from the code alone.
	return { ok: true, token: await startSession(event, userId) };
});
