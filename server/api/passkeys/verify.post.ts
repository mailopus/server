import { listPasskeys } from "../../lib/sessions";

export default defineEventHandler(async (event) => {
	const userId = await requireRecentVerification(event);
	const { challengeId, response, name } = await readBody(event);
	const challenge = await takeChallenge(event, challengeId);
	if (challenge.user_id !== userId) throw createError({ statusCode: 400 });
	await (await passkeyInsert(event, userId, challenge.challenge, response, name)).run();
	return { passkeys: await listPasskeys(cfEnv(event).DB, userId) };
});
