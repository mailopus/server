import { sha256 } from "../../../lib/auth";

export default defineEventHandler(async (event) => {
	const { invite, challengeId, response } = await readBody(event);
	const userId = await inviteUser(event, invite);
	const challenge = await takeChallenge(event, challengeId);
	if (challenge.user_id !== userId) throw createError({ statusCode: 400 });
	const env = cfEnv(event);
	const insert = await passkeyInsert(event, userId, challenge.challenge, response);
	// Invites are single use. Taking it before the insert means two requests racing with one invite can't
	// both add a passkey: only one gets the row back.
	const taken = await env.DB.prepare("DELETE FROM invites WHERE token_hash = ? RETURNING token_hash").bind(await sha256(invite)).first();
	if (!taken) throw createError({ statusCode: 400, statusMessage: "invite already used" });
	await insert.run();
	return { ok: true, token: await startSession(event, userId) };
});
