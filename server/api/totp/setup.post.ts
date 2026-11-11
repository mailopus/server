import { newTotpSecret, otpauthUri } from "../../lib/totp";

// Starts turning the authenticator on: a new secret, held as pending until enable.post.ts gets a code from it.
// The passkey is asked for first, so a stolen session token can't put its own authenticator on the account.
export default defineEventHandler(async (event) => {
	const userId = await requireRecentVerification(event);
	const db = cfEnv(event).DB;
	const secret = newTotpSecret();
	await db.prepare("UPDATE users SET totp_pending = ? WHERE id = ?").bind(secret, userId).run();
	const email = await db.prepare("SELECT i.email FROM identities i JOIN accounts a ON a.id = i.account_id WHERE a.user_id = ? ORDER BY i.rowid LIMIT 1")
		.bind(userId).first<string>("email");
	return { secret, uri: otpauthUri(secret, email ?? "account", new URL(cfEnv(event).APP_ORIGIN).hostname) };
});
