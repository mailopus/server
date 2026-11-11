import type { H3Event } from "h3";
import { SESSION_COOKIE, SESSION_DAYS, forgetSession, forgetSessionHashes, lookupSession, randomToken, requestAuth, sessionToken, sha256 } from "../lib/auth";
import { closeSockets } from "../lib/live";
import { removeSessions, verifiedWithin } from "../lib/sessions";
import { sessionCred } from "../lib/socket";

const headersOf = (event: H3Event) => new Headers(getRequestHeaders(event) as Record<string, string>);

export const cfEnv = (event: H3Event) => event.context.cloudflare.env as Env;

/**
 * Signs the user in. Returns the token only when the UI is on another origin (mailopus.net calling a
 * customer's Worker), where it becomes a bearer token. Same-origin UIs get only the httpOnly cookie.
 */
export async function startSession(event: H3Event, userId: string): Promise<string | undefined> {
	const token = randomToken();
	const now = Date.now();
	await cfEnv(event)
		// verified_at: every caller just checked a passkey, so the session starts out verified.
		.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, verified_at, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)")
		.bind(await sha256(token), userId, now, now + SESSION_DAYS * 86_400_000, now, now, getRequestHeader(event, "user-agent")?.slice(0, 300) ?? null)
		.run();
	if (getRequestURL(event).origin !== cfEnv(event).APP_ORIGIN) return token;
	setCookie(event, SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: SESSION_DAYS * 86_400 });
}

/** A passkey session only, never an app password: for managing app passwords themselves. */
export async function requireSessionUser(event: H3Event): Promise<string> {
	const userId = await lookupSession(cfEnv(event).DB, sessionToken(headersOf(event)));
	if (!userId) throw createError({ statusCode: 401 });
	return userId;
}

/** The current session's token hash. Call after requireSessionUser, which proved there is one. */
export const sessionHash = async (event: H3Event) => sha256(sessionToken(headersOf(event))!);

/**
 * requireSessionUser, plus a passkey ceremony on this session in the last `seconds`: signing in, or
 * /api/auth/verify. For what a stolen session token must not do alone, such as adding a passkey or making
 * an app password. The UI answers the 403 by asking for the passkey and trying again (app/stores/passkeys.ts).
 */
export async function requireRecentVerification(event: H3Event, seconds = 300): Promise<string> {
	const userId = await requireSessionUser(event);
	if (!(await verifiedWithin(cfEnv(event).DB, await sessionHash(event), seconds))) {
		throw createError({ statusCode: 403, statusMessage: "verification required", data: { verification: "required" } });
	}
	return userId;
}

/**
 * Signs out other sessions of this user: one by its id, or all but `except`. Their sockets close now.
 * Their requests can still pass for up to 60 s on another warm isolate (lookupSession's cache).
 */
export async function endSessions(event: H3Event, userId: string, which: { id: string } | { except: string }) {
	const hashes = await removeSessions(cfEnv(event).DB, userId, which);
	forgetSessionHashes(hashes);
	await Promise.all(hashes.map((h) => closeSockets(cfEnv(event), userId, sessionCred(h))));
	return hashes.length;
}

export async function endSession(event: H3Event) {
	const token = sessionToken(headersOf(event));
	if (token) {
		const hash = await sha256(token);
		const userId = await lookupSession(cfEnv(event).DB, token);
		forgetSession(token);
		await cfEnv(event).DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(hash).run();
		if (userId) await closeSockets(cfEnv(event), userId, sessionCred(hash));
	}
	deleteCookie(event, SESSION_COOKIE, { path: "/", secure: true });
}

/**
 * The signed-in user. The Worker gate already refused requests without a session (or, on /jmap/*,
 * an app password); this resolves who it is.
 */
export async function requireUser(event: H3Event): Promise<string> {
	return (await requireAuth(event)).userId;
}

/** requireUser, plus the address scope of a limited app password (null for all mail). */
export async function requireAuth(event: H3Event) {
	const auth = await requestAuth(cfEnv(event).DB, headersOf(event), event.path.split("?")[0]!);
	if (!auth) throw createError({ statusCode: 401 });
	return auth;
}
