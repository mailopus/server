import { markVerified } from "../../../lib/sessions";

// Marks this session verified now, once one of the user's own passkeys has answered a challenge issued to them.
export default defineEventHandler(async (event) => {
	const userId = await requireSessionUser(event);
	const { challengeId, response } = await readBody(event);
	const challenge = await takeChallenge(event, challengeId);
	if (challenge.user_id !== userId) throw createError({ statusCode: 400 });
	await checkAssertion(event, challenge.challenge, response, () => createError({ statusCode: 401, statusMessage: "passkey not verified" }), userId);
	await markVerified(cfEnv(event).DB, await sessionHash(event)).run();
	return { ok: true };
});
