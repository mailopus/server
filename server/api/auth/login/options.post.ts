import { generateAuthenticationOptions } from "@simplewebauthn/server";

export default defineEventHandler(async (event) => {
	// Discoverable credentials: no allowCredentials, so nothing here reveals whether an account exists.
	const options = await generateAuthenticationOptions({ rpID: cfEnv(event).RP_ID, challenge: serverChallenge(event), userVerification: "required" });
	return { challengeId: await saveChallenge(event, options.challenge, null), options };
});
