import { verifyRegistrationResponse } from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { deviceName } from "../../../../shared/device";
import { passkeyOrigins } from "../../../lib/auth";
import { claim, claimant, isClaimable } from "../../../lib/claim";

export default defineEventHandler(async (event) => {
	const { name, email, code, challengeId, response } = await readBody(event);
	const who = claimant(name, email);
	if (!who) throw createError({ statusCode: 400 });
	const challenge = await takeChallenge(event, challengeId);
	if (!challenge.user_id) throw createError({ statusCode: 400 });
	const env = cfEnv(event);
	if (!(await isClaimable(env.DB))) throw createError({ statusCode: 403, statusMessage: "already claimed" });
	await requireClaimCode(event, code);

	let result;
	try {
		result = await verifyRegistrationResponse({
			response,
			expectedChallenge: challenge.challenge,
			expectedOrigin: passkeyOrigins(env),
			expectedRPID: env.RP_ID,
			requireUserVerification: true,
		});
	} catch {
		throw createError({ statusCode: 400, statusMessage: "passkey not verified" });
	}
	if (!result.verified) throw createError({ statusCode: 400, statusMessage: "passkey not verified" });

	const { credential, credentialBackedUp } = result.registrationInfo;
	try {
		await claim(env.DB, challenge.user_id, who, {
			id: credential.id,
			publicKey: isoBase64URL.fromBuffer(credential.publicKey),
			counter: credential.counter,
			transports: credential.transports ?? [],
			name: deviceName(getRequestHeader(event, "user-agent")),
			backedUp: credentialBackedUp,
		});
	} catch (e) {
		// Most likely lost a race with another claim: its 'claimed' row was there first.
		console.warn("claim: batch failed:", (e as Error).message);
		throw createError({ statusCode: 403, statusMessage: "already claimed" });
	}
	return { ok: true, token: await startSession(event, challenge.user_id) };
});
