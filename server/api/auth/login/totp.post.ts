import { checkTotp, spendStep } from "../../../lib/totp";

// The second step: the ticket from login/verify (a passkey that already checked out) and a code from the
// user's authenticator. A wrong code keeps the ticket, so a typo isn't a new passkey prompt; every try
// counts against the user, so the ticket's five minutes allow a few dozen guesses at a million codes.
export default defineEventHandler(async (event) => {
	const { ticket, code } = await readBody(event);
	if (typeof ticket !== "string") throw createError({ statusCode: 400 });
	const db = cfEnv(event).DB;
	const row = await db.prepare(
		"SELECT c.user_id, c.expires_at, u.totp_secret, u.totp_last_step FROM challenges c JOIN users u ON u.id = c.user_id WHERE c.id = ? AND c.challenge = 'totp'",
	).bind(ticket).first<{ user_id: string; expires_at: number; totp_secret: string | null; totp_last_step: number }>();
	if (!row || row.expires_at < Date.now() || !row.totp_secret) throw createError({ statusCode: 400, statusMessage: "expired" });
	if (!(await cfEnv(event).AUTH_LIMIT.limit({ key: `totp:${row.user_id}` })).success) throw createError({ statusCode: 429 });
	const step = await checkTotp(row.totp_secret, code, row.totp_last_step);
	if (step === null || !(await spendStep(db, row.user_id, step))) throw createError({ statusCode: 401, statusMessage: "wrong code" });
	await db.prepare("DELETE FROM challenges WHERE id = ?").bind(ticket).run();
	return { ok: true, token: await startSession(event, row.user_id) };
});
