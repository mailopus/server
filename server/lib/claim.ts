// First-run claim: on an instance with no users, the first visitor becomes the owner by registering a
// passkey (public/auth/claim.html). Nothing is written until the passkey verifies, so an abandoned
// claim leaves the instance open. Afterwards claiming is closed for good.
//
// The claim code closes the race between deploying and claiming. Without it, anyone who found a new
// Worker (its _mailopus TXT record is public on purpose) could claim it first and get the domain's mail.
// `pnpm run deploy` sets CLAIM_CODE as a Worker secret on a first deploy and prints it. With no code set,
// claiming is refused, so a server is never open to everyone.
import { newId, provision } from "./provision.ts";

export const isClaimable = async (db: D1Database) => !(await db.prepare("SELECT 1 FROM users LIMIT 1").first());

const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

/** "unset" when the instance has no CLAIM_CODE, else whether `given` matches it. Compares digests in constant time. */
export async function checkClaimCode(expected: string | undefined, given: unknown): Promise<"ok" | "wrong" | "unset"> {
	if (!expected) return "unset";
	if (typeof given !== "string") return "wrong";
	const [a, b] = await Promise.all([digest(expected.trim()), digest(given.trim())]);
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
	return diff === 0 ? "ok" : "wrong";
}


/** The owner's name and address, or null when they aren't usable. */
export function claimant(name: unknown, email: unknown): { name: string; email: string } | null {
	if (typeof name !== "string" || typeof email !== "string") return null;
	const n = name.trim();
	const e = email.trim().toLowerCase();
	if (!n || n.length > 80 || !/^[^\s@"<>]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e)) return null;
	return { name: n, email: e };
}

export type ClaimPasskey = { id: string; publicKey: string; counter: number; transports: string[]; name?: string; /** Synced between devices. */ backedUp?: boolean };

/**
 * Creates the owner, their account, mailboxes and identity, and stores the passkey, in one batch.
 * The 'claimed' row goes first: a second claim racing this one fails on its primary key, and D1
 * rolls the whole batch back. The owner is the instance's admin. Only their own address routes to
 * them: other addresses at the domain bounce until the admin adds them or turns on the catch-all.
 */
export async function claim(db: D1Database, userId: string, who: { name: string; email: string }, pk: ClaimPasskey) {
	const p = provision({ ...who, makeId: (kind) => (kind === "user" ? userId : newId()) });
	await db.batch([
		db.prepare("INSERT INTO instance_settings (key, value) VALUES ('claimed', ?)").bind(String(Date.now())),
		...p.statements.map((s) => db.prepare(s.sql).bind(...s.params)),
		db.prepare("UPDATE users SET is_admin = 1 WHERE id = ?").bind(userId),
		db.prepare("INSERT INTO passkeys (id, user_id, public_key, counter, transports, created_at, name, backed_up) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
			.bind(pk.id, userId, pk.publicKey, pk.counter, JSON.stringify(pk.transports), Date.now(), pk.name ?? null, pk.backedUp == null ? null : +pk.backedUp),
	]);
	return p;
}
