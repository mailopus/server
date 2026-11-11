import { checkTotp, stepAt } from "../../lib/totp";

// Finishes turning the authenticator on, once a code from the pending secret proves it was saved.
export default defineEventHandler(async (event) => {
	const userId = await requireRecentVerification(event);
	const { code } = await readBody(event);
	const db = cfEnv(event).DB;
	const pending = await db.prepare("SELECT totp_pending FROM users WHERE id = ?").bind(userId).first<string | null>("totp_pending");
	if (!pending) throw createError({ statusCode: 400, statusMessage: "start again" });
	const step = await checkTotp(pending, code, 0);
	if (step === null) throw createError({ statusCode: 400, statusMessage: "wrong code" });
	// The code just entered counts as used, so it can't also sign in.
	await db.prepare("UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_last_step = ? WHERE id = ?").bind(Math.max(step, stepAt(Date.now())), userId).run();
	return { enabled: true };
});
