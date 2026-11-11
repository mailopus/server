import { generateRegistrationOptions } from "@simplewebauthn/server";
import { claimant, isClaimable } from "../../../lib/claim";
import { newId } from "../../../lib/provision";

// Registration options for the owner-to-be. The new user id lives only in the challenge until verify.
export default defineEventHandler(async (event) => {
	const { name, email, code } = await readBody(event);
	const who = claimant(name, email);
	if (!who) throw createError({ statusCode: 400, statusMessage: "name and email address needed" });
	const env = cfEnv(event);
	if (!(await isClaimable(env.DB))) throw createError({ statusCode: 403, statusMessage: "already claimed" });
	await requireClaimCode(event, code);
	const userId = newId();
	const options = await generateRegistrationOptions({
		rpName: "Mailopus",
		rpID: env.RP_ID,
		userName: who.email,
		userDisplayName: who.name,
		userID: new TextEncoder().encode(userId),
		challenge: serverChallenge(event),
		attestationType: "none",
		authenticatorSelection: { residentKey: "required", userVerification: "required" },
	});
	return { challengeId: await saveChallenge(event, options.challenge, userId), options };
});
