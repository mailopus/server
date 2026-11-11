import { generateAuthenticationOptions } from "@simplewebauthn/server";

// Step-up: the signed-in user shows a passkey again before something a stolen session token must not do
// alone (requireRecentVerification in server/utils/session.ts). Behind the gate, so there is a session.
export default defineEventHandler(async (event) => {
	const userId = await requireSessionUser(event);
	const env = cfEnv(event);
	// Their own passkeys only. They're signed in, so naming them reveals nothing.
	const own = await env.DB.prepare("SELECT id, transports FROM passkeys WHERE user_id = ?").bind(userId).all<{ id: string; transports: string }>();
	const options = await generateAuthenticationOptions({
		rpID: env.RP_ID,
		challenge: serverChallenge(event),
		userVerification: "required",
		allowCredentials: own.results.map((p) => ({ id: p.id, transports: JSON.parse(p.transports) })),
	});
	return { challengeId: await saveChallenge(event, options.challenge, userId), options };
});
