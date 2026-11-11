// Passkeys and sessions as Settings manages them (server/api/passkeys, server/api/sessions).
// Plain module so tests can run it. Every query is scoped to the user: an id alone finds nothing.

/** How Settings names a session: the start of its token hash. It tells one user's sessions apart and opens nothing. */
export const sessionId = (tokenHash: string) => tokenHash.slice(0, 16);

export type PasskeyInfo = { id: string; name: string | null; createdAt: number; lastUsedAt: number | null; backedUp: boolean | null };

/** Never the public keys: the UI has no use for them. */
export async function listPasskeys(db: D1Database, userId: string): Promise<PasskeyInfo[]> {
	const r = await db
		.prepare("SELECT id, name, created_at AS createdAt, last_used_at AS lastUsedAt, backed_up FROM passkeys WHERE user_id = ? ORDER BY created_at")
		.bind(userId)
		.all<Omit<PasskeyInfo, "backedUp"> & { backed_up: number | null }>();
	return r.results.map(({ backed_up, ...p }) => ({ ...p, backedUp: backed_up === null ? null : !!backed_up }));
}

/** "last": refused, since removing a user's only passkey locks them out. One statement, so two removals racing can't both pass the count. */
export async function removePasskey(db: D1Database, userId: string, id: string): Promise<"ok" | "last" | "missing"> {
	const r = await db
		.prepare("DELETE FROM passkeys WHERE id = ?1 AND user_id = ?2 AND (SELECT count(*) FROM passkeys WHERE user_id = ?2) > 1 RETURNING id")
		.bind(id, userId)
		.first();
	if (r) return "ok";
	return (await db.prepare("SELECT 1 FROM passkeys WHERE id = ? AND user_id = ?").bind(id, userId).first()) ? "last" : "missing";
}

export type SessionInfo = { id: string; createdAt: number; lastSeenAt: number | null; userAgent: string | null; current: boolean };

export async function listSessions(db: D1Database, userId: string, currentHash: string): Promise<SessionInfo[]> {
	const r = await db
		.prepare("SELECT token_hash, created_at AS createdAt, last_seen_at AS lastSeenAt, user_agent AS userAgent FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC")
		.bind(userId, Date.now())
		.all<Omit<SessionInfo, "id" | "current"> & { token_hash: string }>();
	return r.results.map(({ token_hash, ...s }) => ({ id: sessionId(token_hash), ...s, current: token_hash === currentHash }));
}

/**
 * Ends one of the user's sessions by id, or every one except `except`. Returns the token hashes that went,
 * so the caller can close their sockets.
 */
export async function removeSessions(db: D1Database, userId: string, which: { id: string } | { except: string }): Promise<string[]> {
	const st = "id" in which
		? db.prepare("DELETE FROM sessions WHERE user_id = ? AND substr(token_hash, 1, 16) = ? RETURNING token_hash").bind(userId, which.id)
		: db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ? RETURNING token_hash").bind(userId, which.except);
	return (await st.all<{ token_hash: string }>()).results.map((r) => r.token_hash);
}

/** Whether this session did a passkey ceremony in the last `seconds`. Signing in counts. Read from D1 each time, never cached. */
export async function verifiedWithin(db: D1Database, tokenHash: string, seconds: number): Promise<boolean> {
	const row = await db
		.prepare("SELECT coalesce(verified_at, created_at) AS at FROM sessions WHERE token_hash = ? AND expires_at > ?")
		.bind(tokenHash, Date.now())
		.first<{ at: number }>();
	return !!row && row.at > Date.now() - seconds * 1000;
}

export const markVerified = (db: D1Database, tokenHash: string) =>
	db.prepare("UPDATE sessions SET verified_at = ? WHERE token_hash = ?").bind(Date.now(), tokenHash);
