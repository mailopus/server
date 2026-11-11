// Recovery codes: the way back in when no passkey works, without a terminal (docs/sign-in.md).
// A code never signs anyone in. With the address it belongs to, it opens passkey registration once
// (server/api/auth/recover). Plain module so tests can run it.
import { sha256 } from "./auth.ts";

// 32 characters, so each is 5 random bits with no bias. No 0, 1, I or O: nothing typed can be read two ways.
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const RECOVERY_CODES = 10;

/** 16 characters in four groups, 80 random bits: "K7QM-2XHD-9TLP-B4WN". */
export function newRecoveryCode(): string {
	const s = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => ALPHABET[b & 31]).join("");
	return s.match(/.{4}/g)!.join("-");
}

/** What a person types or pastes: any case, with or without the dashes or spaces. */
export const normalizeRecoveryCode = (code: string) => code.replace(/[\s-]/g, "").toUpperCase();

const hashOf = (code: string) => sha256(normalizeRecoveryCode(code));

/** Replaces the user's codes with ten new ones and returns them. The only time they exist in plain text. */
export async function generateRecoveryCodes(db: D1Database, userId: string): Promise<string[]> {
	const codes = Array.from({ length: RECOVERY_CODES }, newRecoveryCode);
	const now = Date.now();
	const hashes = await Promise.all(codes.map(hashOf));
	// One batch: the old set stops working in the same transaction that starts the new one.
	await db.batch([
		db.prepare("DELETE FROM recovery_codes WHERE user_id = ?").bind(userId),
		...hashes.map((h) => db.prepare("INSERT INTO recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)").bind(userId, h, now)),
	]);
	return codes;
}

/** For Settings: how many codes still work and when the set was made. Never the codes or their hashes. */
export async function recoveryStatus(db: D1Database, userId: string): Promise<{ remaining: number; createdAt: number | null }> {
	const r = await db
		.prepare("SELECT count(CASE WHEN used_at IS NULL THEN 1 END) AS remaining, max(created_at) AS createdAt FROM recovery_codes WHERE user_id = ?")
		.bind(userId)
		.first<{ remaining: number; createdAt: number | null }>();
	return { remaining: r?.remaining ?? 0, createdAt: r?.createdAt ?? null };
}

/**
 * The user an unused code belongs to, when `email` is one of that user's addresses. Null otherwise.
 * One query whatever is wrong (no such address, no such code, a used code, someone else's code), so the
 * answer and its timing say nothing about which. A catch-all doesn't count: the address must be theirs.
 */
export async function recoveryUser(db: D1Database, email: unknown, code: unknown): Promise<string | null> {
	if (typeof email !== "string" || typeof code !== "string") return null;
	const address = email.trim().toLowerCase();
	const row = await db
		.prepare(
			`SELECT c.user_id FROM recovery_codes c WHERE c.code_hash = ? AND c.used_at IS NULL AND c.user_id IN (
				SELECT a.user_id FROM accounts a
				WHERE a.id IN (SELECT account_id FROM addresses WHERE address = ?)
					OR a.id IN (SELECT account_id FROM identities WHERE lower(email) = ?))`,
		)
		.bind(await hashOf(code), address, address)
		.first<{ user_id: string }>();
	return row?.user_id ?? null;
}

/**
 * Spends the code and stores the new passkey. False when the code was already spent, and then nothing is
 * stored. The code goes first, as invites do (server/api/auth/register/verify.post.ts): of two requests
 * racing with one code, only one gets the row back, so only one passkey is added.
 */
export async function redeemRecoveryCode(db: D1Database, userId: string, code: string, passkey: D1PreparedStatement): Promise<boolean> {
	const taken = await db
		.prepare("UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL RETURNING code_hash")
		.bind(Date.now(), userId, await hashOf(code))
		.first();
	if (!taken) return false;
	await passkey.run();
	return true;
}
