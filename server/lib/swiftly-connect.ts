// "Connect Swiftly": OAuth-style authorization code with PKCE (S256). Mailopus sends you to
// swiftly.biz/connect; Swiftly sends you back to /api/swiftly/callback with a one-time code, and the
// server swaps it (with the verifier it kept under the state) for an agent token. The token never
// reaches the browser.
import { syncSignature } from "./signatures.ts";

export const SWIFTLY_BASE = "https://swiftly.biz";
export const CALLBACK_PATH = "/api/swiftly/callback";

// The state, verifier and choice wait in D1 between connect and callback, not in a cookie: under BYOC the
// service worker forwards both requests to the customer's Worker, and a cross-origin fetch() there never
// stores cookies. The callback still needs a session that owns the account, which ties the state to you.
export type Pending = { verifier: string; account: string; identity: string; all: boolean; base: string; swiftly?: string };
const TTL = 10 * 60_000;
const key = (state: string) => `swiftly-connect:${state}`;

export async function savePending(db: D1Database, state: string, p: Pending, now = Date.now()) {
	await db.batch([
		db.prepare("DELETE FROM instance_settings WHERE key LIKE 'swiftly-connect:%' AND json_extract(value, '$.expires') < ?").bind(now),
		db.prepare("INSERT INTO instance_settings (key, value) VALUES (?, ?)").bind(key(state), JSON.stringify({ ...p, expires: now + TTL })),
	]);
}

/** One use: the row goes whether or not it's still fresh. */
export async function takePending(db: D1Database, state: string, now = Date.now()): Promise<Pending | null> {
	const row = await db.prepare("DELETE FROM instance_settings WHERE key = ? RETURNING value").bind(key(state)).first<{ value: string }>();
	const p = row ? (JSON.parse(row.value) as Pending & { expires: number }) : null;
	return p && p.expires >= now ? p : null;
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function pkce() {
	const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
	const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
	return { verifier, challenge, state: b64url(crypto.getRandomValues(new Uint8Array(16))) };
}

/** base: SWIFTLY_BASE from the environment (a local Swiftly in dev), else swiftly.biz. */
export function authorizeUrl(redirectUri: string, state: string, challenge: string, base = SWIFTLY_BASE) {
	const u = new URL("/connect", base);
	u.search = new URLSearchParams({ client: "mailopus", redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: "S256" }).toString();
	return u.toString();
}

export type Connected = { token: string; memberEmail: string; org: { id: string; name: string } };

export async function exchange(code: string, verifier: string, redirectUri: string, base = SWIFTLY_BASE): Promise<Connected & { base: string }> {
	const res = await fetch(new URL("/api/agent/token", base), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: redirectUri, client: "mailopus" }),
		signal: AbortSignal.timeout(8000),
	});
	const body = (await res.json().catch(() => ({}))) as Partial<Connected>;
	if (!res.ok || typeof body.token !== "string" || !body.token.startsWith("swa_")) throw new Error(`Swiftly didn't connect (${res.status})`);
	return { ...(body as Connected), base };
}

/**
 * Stores the connection for the account and turns Swiftly on for the chosen identities (one, or all of
 * the account's), syncing each. Identities keep any block they had; a token pasted on one identity
 * earlier is dropped so the connection's token is the one used.
 */
export async function saveConnection(db: D1Database, account: string, c: Connected & { base?: string }, identityIds: string[] | "all") {
	await db.prepare("INSERT INTO signature_connections (account_id, provider, config, info, created_at) VALUES (?, 'swiftly', ?, ?, ?) ON CONFLICT (account_id, provider) DO UPDATE SET config = excluded.config, info = excluded.info")
		.bind(account, JSON.stringify({ token: c.token, ...(c.base && c.base !== SWIFTLY_BASE && { base: c.base }) }), JSON.stringify({ memberEmail: c.memberEmail, org: c.org?.name ?? null }), Date.now()).run();
	const rows = (await db.prepare("SELECT id, account_id, email, html_signature, signature_provider, signature_config FROM identities WHERE account_id = ?").bind(account)
		.all<{ id: string; account_id: string; email: string; html_signature: string; signature_provider: string | null; signature_config: string }>()).results
		.filter((r) => identityIds === "all" || identityIds.includes(r.id));
	let failed = 0;
	for (const r of rows) {
		const { token: _drop, ...keep } = r.signature_provider === "swiftly" ? JSON.parse(r.signature_config || "{}") : {};
		const config = JSON.stringify(keep);
		await db.prepare("UPDATE identities SET signature_provider = 'swiftly', signature_config = ? WHERE id = ?").bind(config, r.id).run();
		const result = await syncSignature(db, { ...r, signature_provider: "swiftly", signature_config: config });
		if (result === "error" || result === "refuse") failed++;
	}
	return { count: rows.length, failed };
}

export async function connectionInfo(db: D1Database, account: string) {
	const row = await db.prepare("SELECT info, created_at FROM signature_connections WHERE account_id = ? AND provider = 'swiftly'").bind(account).first<{ info: string; created_at: number }>();
	return row ? { ...(JSON.parse(row.info) as { memberEmail: string; org: string | null }), connectedAt: new Date(row.created_at).toISOString() } : null;
}
