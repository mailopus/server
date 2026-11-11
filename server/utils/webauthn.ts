import { generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import type { H3Event } from "h3";
import { deviceName } from "../../shared/device";
import { passkeyOrigins, sha256 } from "../lib/auth";
import { boundChallenge } from "../lib/challenge";
import { checkClaimCode } from "../lib/claim";

const CHALLENGE_MS = 5 * 60_000;

/**
 * A challenge naming this server's origin, as the browser reached it (server/lib/challenge.ts). The raw
 * Workers request URL is the source of truth; h3's own URL guesses the scheme from headers.
 */
export const serverChallenge = (event: H3Event) =>
	boundChallenge(new URL((event.context.cloudflare?.request as Request | undefined)?.url ?? getRequestURL(event)).origin);

export async function saveChallenge(event: H3Event, challenge: string, userId: string | null) {
	const id = crypto.randomUUID();
	const db = cfEnv(event).DB;
	await db.batch([
		// Abandoned ceremonies leave rows behind; sweep them here instead of on a cron.
		db.prepare("DELETE FROM challenges WHERE expires_at < ?").bind(Date.now()),
		db.prepare("INSERT INTO challenges (id, challenge, user_id, expires_at) VALUES (?, ?, ?, ?)").bind(id, challenge, userId, Date.now() + CHALLENGE_MS),
	]);
	return id;
}

/** Deletes and returns the challenge, so each one verifies at most once. */
export async function takeChallenge(event: H3Event, id: unknown) {
	if (typeof id !== "string") throw createError({ statusCode: 400 });
	const row = await cfEnv(event)
		.DB.prepare("DELETE FROM challenges WHERE id = ? RETURNING challenge, user_id, expires_at")
		.bind(id)
		.first<{ challenge: string; user_id: string | null; expires_at: number }>();
	if (!row || row.expires_at < Date.now()) throw createError({ statusCode: 400, statusMessage: "challenge expired" });
	return row;
}

export async function inviteUser(event: H3Event, invite: unknown): Promise<string> {
	if (typeof invite !== "string" || !invite) throw createError({ statusCode: 400 });
	const row = await cfEnv(event)
		.DB.prepare("SELECT user_id FROM invites WHERE token_hash = ? AND expires_at > ?")
		.bind(await sha256(invite), Date.now())
		.first<{ user_id: string }>();
	if (!row) throw createError({ statusCode: 403, statusMessage: "invite invalid or expired" });
	return row.user_id;
}

/** Refuses a claim without the instance's CLAIM_CODE secret (server/lib/claim.ts). 428 when none is set. */
export async function requireClaimCode(event: H3Event, given: unknown) {
	const result = await checkClaimCode((cfEnv(event) as Env & { CLAIM_CODE?: string }).CLAIM_CODE, given);
	if (result === "unset") throw createError({ statusCode: 428, statusMessage: "no claim code set" });
	if (result === "wrong") throw createError({ statusCode: 401, statusMessage: "wrong claim code" });
}

/**
 * Registration options for a user who already exists: from an invite, or Settings adding a passkey.
 * Their other passkeys are excluded, so one authenticator never holds two for the same person.
 */
export async function registrationOptions(event: H3Event, userId: string) {
	const env = cfEnv(event);
	const user = await env.DB.prepare("SELECT name FROM users WHERE id = ?").bind(userId).first<{ name: string }>();
	const existing = await env.DB.prepare("SELECT id, transports FROM passkeys WHERE user_id = ?").bind(userId).all<{ id: string; transports: string }>();
	const options = await generateRegistrationOptions({
		rpName: "Mailopus",
		rpID: env.RP_ID,
		userName: user?.name ?? userId,
		userID: new TextEncoder().encode(userId),
		challenge: serverChallenge(event),
		attestationType: "none",
		excludeCredentials: existing.results.map((p) => ({ id: p.id, transports: JSON.parse(p.transports) })),
		authenticatorSelection: { residentKey: "required", userVerification: "required" },
	});
	return { challengeId: await saveChallenge(event, options.challenge, userId), options };
}

/**
 * Checks a registration answer and returns the statement that stores the passkey, for the caller to run
 * or batch. name: what the user called it, else the browser and system it was made on.
 */
export async function passkeyInsert(event: H3Event, userId: string, challenge: string, response: any, name?: unknown) {
	const env = cfEnv(event);
	let result;
	try {
		result = await verifyRegistrationResponse({
			response,
			expectedChallenge: challenge,
			expectedOrigin: passkeyOrigins(env),
			expectedRPID: env.RP_ID,
			requireUserVerification: true,
		});
	} catch {
		throw createError({ statusCode: 400, statusMessage: "passkey not verified" });
	}
	if (!result.verified) throw createError({ statusCode: 400, statusMessage: "passkey not verified" });

	const { credential, credentialBackedUp } = result.registrationInfo;
	const label = (typeof name === "string" && name.trim().slice(0, 80)) || deviceName(getRequestHeader(event, "user-agent"));
	return env.DB.prepare("INSERT INTO passkeys (id, user_id, public_key, counter, transports, created_at, name, backed_up) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(
		credential.id,
		userId,
		isoBase64URL.fromBuffer(credential.publicKey),
		credential.counter,
		JSON.stringify(credential.transports ?? []),
		Date.now(),
		label,
		credentialBackedUp ? 1 : 0,
	);
}

/**
 * Checks a passkey assertion and records the use: the counter, last_used_at, and whether the passkey is
 * synced now. Returns whose passkey it was. userId: only that user's passkey will do, for a signed-in
 * user proving they're still there. Throws `fail()` whatever went wrong, so the answer tells an attacker nothing.
 */
export async function checkAssertion(event: H3Event, challenge: string, response: any, fail: () => Error, userId?: string): Promise<string> {
	const env = cfEnv(event);
	const key = typeof response?.id === "string"
		? await env.DB.prepare("SELECT id, user_id, public_key, counter, transports FROM passkeys WHERE id = ?")
				.bind(response.id)
				.first<{ id: string; user_id: string; public_key: string; counter: number; transports: string }>()
		: null;
	if (!key || (userId && key.user_id !== userId)) throw fail();

	let result;
	try {
		result = await verifyAuthenticationResponse({
			response,
			expectedChallenge: challenge,
			expectedOrigin: passkeyOrigins(env),
			expectedRPID: env.RP_ID,
			requireUserVerification: true,
			credential: {
				id: key.id,
				publicKey: isoBase64URL.toBuffer(key.public_key),
				counter: key.counter,
				transports: JSON.parse(key.transports),
			},
		});
	} catch {
		throw fail();
	}
	if (!result.verified) throw fail();

	const { newCounter, credentialBackedUp } = result.authenticationInfo;
	await env.DB.prepare("UPDATE passkeys SET counter = ?, last_used_at = ?, backed_up = ? WHERE id = ?")
		.bind(newCounter, Date.now(), credentialBackedUp ? 1 : 0, key.id)
		.run();
	return key.user_id;
}
