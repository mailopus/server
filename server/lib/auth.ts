// Plain module (no h3/Nitro auto-imports) so the Worker entry's gate can use it before Nitro runs.

export const SESSION_COOKIE = "__Host-mo_session";
export const SESSION_DAYS = 30;

export const b64url = (bytes: Uint8Array) =>
	btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

export async function sha256(s: string) {
	const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function readCookie(header: string | null, name: string): string | null {
	for (const part of header?.split(";") ?? []) {
		const i = part.indexOf("=");
		if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
	}
	return null;
}

// The WebSocket API can't set headers, so the UI offers the token as a second subprotocol next to "jmap".
// Base64url characters are all valid in a subprotocol name. The Durable Object answers "jmap".
export const WS_TOKEN_PREFIX = "mailopus.token.";

/**
 * A one-time ticket for opening the live socket, offered the same way. Request logs keep the
 * Sec-WebSocket-Protocol header in clear, so the UI sends this in place of the session token: it works
 * once, within a minute, and only opens a socket. The token form above stays for a UI older than tickets.
 */
export const WS_TICKET_PREFIX = "mailopus.ticket.";
const TICKET_MS = 60_000;
const TICKET_MARK = "socket ";

export function socketTicket(headers: Headers): string | null {
	for (const p of headers.get("sec-websocket-protocol")?.split(",") ?? []) {
		if (p.trim().startsWith(WS_TICKET_PREFIX)) return p.trim().slice(WS_TICKET_PREFIX.length);
	}
	return null;
}

/** Kept with the passkey challenges: the same single-use, short-lived rows. The mark keeps one from passing as the other. */
export async function issueSocketTicket(db: D1Database, userId: string, tokenHash: string, now = Date.now()): Promise<string> {
	const id = randomToken();
	await db.prepare("INSERT INTO challenges (id, challenge, user_id, expires_at) VALUES (?, ?, ?, ?)").bind(id, TICKET_MARK + tokenHash, userId, now + TICKET_MS).run();
	return id;
}

/** Spends the ticket. The user and the hash of the session that asked for it, or null. */
export async function takeSocketTicket(db: D1Database, id: string, now = Date.now()): Promise<{ userId: string; tokenHash: string } | null> {
	const row = await db.prepare("DELETE FROM challenges WHERE id = ? AND challenge LIKE 'socket %' RETURNING challenge, user_id, expires_at").bind(id).first<{ challenge: string; user_id: string | null; expires_at: number }>();
	if (!row?.user_id || row.expires_at < now) return null;
	// The session may have ended in the minute since: a ticket must not outlive it.
	const tokenHash = row.challenge.slice(TICKET_MARK.length);
	const live = await db.prepare("SELECT 1 FROM sessions WHERE token_hash = ? AND user_id = ? AND expires_at > ?").bind(tokenHash, row.user_id, now).first();
	return live ? { userId: row.user_id, tokenHash } : null;
}

/**
 * The session token: the cookie when the UI shares this Worker's origin, otherwise a bearer token. That's
 * the UI at mailopus.net calling a customer's own Worker, where Safari would drop a cross-site cookie.
 */
export function sessionToken(headers: Headers): string | null {
	const bearer = headers.get("authorization")?.match(/^Bearer\s+(\S+)\s*$/i)?.[1];
	if (bearer) return bearer;
	for (const p of headers.get("sec-websocket-protocol")?.split(",") ?? []) {
		if (p.trim().startsWith(WS_TOKEN_PREFIX)) return p.trim().slice(WS_TOKEN_PREFIX.length);
	}
	return readCookie(headers.get("cookie"), SESSION_COOKIE);
}

// A page load fires dozens of asset requests; don't hit D1 for each.
// ponytail: per-isolate cache, so a revoked session can live up to CACHE_MS longer on a warm isolate.
const CACHE_MS = 60_000;
const cache = new Map<string, { userId: string; hash: string; until: number }>();
const SEEN_MS = 3_600_000;

export async function lookupSession(db: D1Database, token: string | null): Promise<string | null> {
	if (!token) return null;
	const hit = cache.get(token);
	if (hit && hit.until > Date.now()) return hit.userId;
	const hash = await sha256(token);
	const now = Date.now();
	const row = await db
		.prepare("SELECT user_id, expires_at, last_seen_at FROM sessions WHERE token_hash = ? AND expires_at > ?")
		.bind(hash, now)
		.first<{ user_id: string; expires_at: number; last_seen_at: number | null }>();
	if (!row) {
		cache.delete(token);
		return null;
	}
	// For Settings > Signed-in devices. Written only here, where D1 was read anyway, and at most once an
	// hour per session, so cached requests never pay for it. A failed write must not fail the request.
	if (!(row.last_seen_at && row.last_seen_at > now - SEEN_MS)) {
		try {
			await db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").bind(now, hash).run();
		} catch {}
	}
	cache.set(token, { userId: row.user_id, hash, until: Math.min(now + CACHE_MS, row.expires_at) });
	return row.user_id;
}

export const forgetSession = (token: string) => cache.delete(token);

/**
 * Drops sessions ended from another device (Settings > Signed-in devices), known only by their hashes.
 * This isolate only: on any other warm isolate they keep working until CACHE_MS runs out, 60 s at most.
 */
export function forgetSessionHashes(hashes: string[]) {
	for (const [token, s] of cache) if (hashes.includes(s.hash)) cache.delete(token);
}

export type AccountRow = { id: string; name: string };

// Every JMAP request needs the user's accounts; re-reading them cost a D1 round trip (~30 ms) each time.
// Accounts are only inserted, together with their user (server/lib/provision.ts), and never move or go away.
// ponytail: per-isolate cache like sessions above. Add invalidation if accounts ever get renamed or removed.
const accountCache = new Map<string, { rows: AccountRow[]; until: number }>();

export async function userAccounts(db: D1Database, userId: string): Promise<AccountRow[]> {
	const hit = accountCache.get(userId);
	if (hit && hit.until > Date.now()) return hit.rows;
	const rows = (await db.prepare("SELECT id, name FROM accounts WHERE user_id = ?").bind(userId).all<AccountRow>()).results;
	// An empty answer isn't cached, so a user provisioned a moment later is seen at once.
	if (rows.length) accountCache.set(userId, { rows, until: Date.now() + CACHE_MS });
	return rows;
}

/**
 * Origins a passkey ceremony may come from. Locally the preview config adds DEV_ORIGIN, the `nuxt dev`
 * server on another port; production sets only APP_ORIGIN.
 */
export function passkeyOrigins(env: Env): string[] {
	const dev = (env as { DEV_ORIGIN?: string }).DEV_ORIGIN;
	return dev ? [env.APP_ORIGIN, dev] : [env.APP_ORIGIN];
}

// ---------- app passwords (IMAP and SMTP clients, via the imap/ proxy) ----------

const B62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** 32 characters of upper, lower and digits, about 190 random bits. Pasted, never typed. */
export function newAppPassword(): string {
	let s = "";
	while (s.length < 32) {
		// Rejection sampling: 248 is the largest multiple of 62 under 256, so every character is equally likely.
		for (const b of crypto.getRandomValues(new Uint8Array(40))) if (b < 248 && s.length < 32) s += B62[b % 62];
	}
	return s;
}

/** Drops whitespace and dashes a client or a paste might add. Case matters. */
export const normalizeAppPassword = (p: string) => p.replace(/[\s-]/g, "");

/** The hashes a typed password may be stored under: exact, and for the first 20-character base32 ones (case didn't matter), uppercase. */
async function appPasswordHashes(pass: string): Promise<string[]> {
	const p = normalizeAppPassword(pass);
	return /^[A-Za-z2-7]{20}$/.test(p) ? [...new Set([await sha256(p), await sha256(p.toUpperCase())])] : [await sha256(p)];
}

/** App passwords reach JMAP and nothing else: not /api/*, so they can't manage passkeys or themselves. */
export const isAppPasswordPath = (path: string) => path.startsWith("/jmap/") || path === "/.well-known/jmap";

export function basicAuth(header: string | null): { user: string; pass: string } | null {
	const m = header?.match(/^Basic\s+([A-Za-z0-9+/=]+)\s*$/i);
	if (!m) return null;
	let s: string;
	try {
		s = atob(m[1]!);
	} catch {
		return null;
	}
	const i = s.indexOf(":");
	if (i < 1) return null;
	return { user: s.slice(0, i).trim().toLowerCase(), pass: s.slice(i + 1) };
}

/** Who signed in, and for an app password limited to some addresses, those address patterns. */
export type Auth = { userId: string; scope: string[] | null; /** The app password's id, when that's what signed in. */ appPassword?: string; /** Set once when an app password turns up on a network it hasn't used before. */ newNetwork?: { name: string; network: string } };

const NETWORKS_KEPT = 30;
const ALERT_EVERY_MS = 86_400_000;

// ponytail: per-isolate cache like sessions, so a revoked app password can work up to CACHE_MS longer.
const appCache = new Map<string, Auth & { until: number }>();

/** One sign-in for Settings (migrations/0036): counted per password, address, network and outcome. */
export const signin = (db: D1Database, userId: string, passwordId: string, address: string, network: string | null, ok: boolean, now = Date.now()) =>
	db.prepare(
		`INSERT INTO app_password_signins (user_id, password_id, address, network, ok, count, first_at, last_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6)
		ON CONFLICT (user_id, password_id, address, network, ok) DO UPDATE SET count = count + 1, last_at = ?6`,
	).bind(userId, passwordId, address.toLowerCase(), network ?? "", ok ? 1 : 0, now);

/** A wrong app password for an address, counted for whoever owns it. An address nobody here owns writes nothing. */
export const signinFailed = (db: D1Database, address: string, network: string | null, now = Date.now()) =>
	db.prepare(
		`INSERT INTO app_password_signins (user_id, password_id, address, network, ok, count, first_at, last_at)
		SELECT DISTINCT a.user_id, '', ?1, ?2, 0, 1, ?3, ?3 FROM accounts a
		WHERE a.id IN (SELECT account_id FROM addresses WHERE address = ?1) OR a.id IN (SELECT account_id FROM identities WHERE lower(email) = ?1)
		ON CONFLICT (user_id, password_id, address, network, ok) DO UPDATE SET count = count + 1, last_at = ?3`,
	).bind(address.toLowerCase(), network ?? "", now).run();

/**
 * The network an address is on: its /24 (IPv4) or /48 (IPv6). Settings shows where an app password was
 * last used, and a network says that without keeping anyone's full address. Null when it isn't an IP.
 */
export function ipPrefix(ip: string | null | undefined): string | null {
	const s = (ip ?? "").trim().toLowerCase();
	// "::ffff:1.2.3.4" is an IPv4 client seen through an IPv6 socket.
	const v4 = s.match(/^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (v4) return v4.slice(1).every((n) => +n < 256) ? `${+v4[1]!}.${+v4[2]!}.${+v4[3]!}.0/24` : null;
	if (!/^[0-9a-f:]+$/.test(s)) return null;
	const [head, tail, more] = s.split("::");
	const h = head ? head.split(":") : [];
	const t = tail ? tail.split(":") : [];
	if (more !== undefined || h.length + t.length > (tail === undefined ? 8 : 7)) return null;
	// "::" stands for as many zero groups as it takes to make eight.
	const groups = tail === undefined ? h : [...h, ...Array<string>(8 - h.length - t.length).fill("0"), ...t];
	if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
	return `${groups.slice(0, 3).map((g) => parseInt(g, 16).toString(16)).join(":")}::/48`;
}

/**
 * The user an app password belongs to, and its scope. The username must be one of that user's addresses
 * (exact, a catch-all on its domain, or a sending identity), so a client's "email address" field just works.
 * clientIp: where the request came from, when the caller knows (the gate does). Its network is stored as
 * last_ip, only here where D1 was read anyway, so cached requests never pay for the write.
 */
export async function lookupAppPassword(db: D1Database, cred: { user: string; pass: string }, clientIp?: string | null): Promise<Auth | null> {
	const hashes = await appPasswordHashes(cred.pass);
	const key = `${cred.user}\n${hashes[0]}`;
	const hit = appCache.get(key);
	if (hit && hit.until > Date.now()) return { userId: hit.userId, scope: hit.scope, appPassword: hit.appPassword };
	const domain = cred.user.split("@")[1] ?? "";
	const now = Date.now();
	const row = await db
		.prepare(
			`SELECT p.id, p.user_id, p.scope_json, p.expires_at, p.name, p.last_ip, p.seen_networks, p.alerted_at FROM app_passwords p WHERE p.token_hash IN (${hashes.map(() => "?").join(",")})
				AND (p.expires_at IS NULL OR p.expires_at > ?) AND p.user_id IN (
				SELECT a.user_id FROM accounts a
				WHERE a.id IN (SELECT account_id FROM addresses WHERE address = ? OR address = ?)
					OR a.id IN (SELECT account_id FROM identities WHERE lower(email) = ?))`,
		)
		.bind(...hashes, now, cred.user, `*@${domain}`, cred.user)
		.first<{ id: string; user_id: string; scope_json: string | null; expires_at: number | null; name: string; last_ip: string | null; seen_networks: string | null; alerted_at: number | null }>();
	if (!row) {
		appCache.delete(key);
		return null;
	}
	// A network this password hasn't been used from. Phones move between a few, so the last NETWORKS_KEPT are
	// remembered and each is announced once. The first one ever is where you set the app up: no alert. At
	// most one alert a day per password, so a phone roaming across carrier networks doesn't flood you.
	const network = ipPrefix(clientIp);
	const seen: string[] = row.seen_networks ? JSON.parse(row.seen_networks) : row.last_ip ? [row.last_ip] : [];
	const fresh = !!network && !seen.includes(network);
	const alert = fresh && seen.length > 0 && now - (row.alerted_at ?? 0) > ALERT_EVERY_MS;
	// coalesce: a caller that doesn't know the client (requestAuth, behind the gate) leaves the network as it was.
	await db.batch([
		db.prepare("UPDATE app_passwords SET last_used_at = ?, last_ip = coalesce(?, last_ip), seen_networks = ?, alerted_at = ? WHERE id = ?")
			.bind(now, network, JSON.stringify(fresh ? [...seen, network].slice(-NETWORKS_KEPT) : seen), alert ? now : row.alerted_at, row.id),
		signin(db, row.user_id, row.id, cred.user, network, true, now),
	]);
	const auth: Auth = { userId: row.user_id, scope: row.scope_json ? (JSON.parse(row.scope_json) as string[]) : null, appPassword: row.id };
	if (alert) return (appCache.set(key, { ...auth, until: Math.min(now + CACHE_MS, row.expires_at ?? Infinity) }), { ...auth, newNetwork: { name: row.name, network: network! } });
	// Never cached past its expiry.
	appCache.set(key, { ...auth, until: Math.min(now + CACHE_MS, row.expires_at ?? Infinity) });
	return auth;
}

/** Who a request is from: a session (all mail), or on JMAP paths an app password. */
export async function requestAuth(db: D1Database, headers: Headers, path: string): Promise<Auth | null> {
	const session = await lookupSession(db, sessionToken(headers));
	if (session) return { userId: session, scope: null };
	const cred = isAppPasswordPath(path) ? basicAuth(headers.get("authorization")) : null;
	return cred ? lookupAppPassword(db, cred) : null;
}

export const requestUser = async (db: D1Database, headers: Headers, path: string) => (await requestAuth(db, headers, path))?.userId ?? null;
