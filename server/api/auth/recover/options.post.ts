import { recoveryUser } from "../../../lib/recovery";

// Lost every passkey: an address and one of its user's recovery codes open passkey registration, and
// nothing else. No session starts here or anywhere without the new passkey (verify.post.ts).
export default defineEventHandler(async (event) => {
	const { email, code } = await readBody(event);
	if (typeof email !== "string" || typeof code !== "string") throw createError({ statusCode: 400 });
	const env = cfEnv(event);
	// Every attempt counts against the address typed, right or wrong, on top of the gate's limit per IP.
	// Counting only failures would let a correct guess through, and limit() can't check without counting.
	if (!(await env.AUTH_LIMIT.limit({ key: `recover:${email.trim().toLowerCase().slice(0, 254)}` })).success) throw createError({ statusCode: 429 });
	const userId = await recoveryUser(env.DB, email, code);
	// The same answer for an unknown address and a wrong, used or someone else's code.
	if (!userId) throw createError({ statusCode: 403, statusMessage: "recovery failed" });
	return registrationOptions(event, userId);
});
