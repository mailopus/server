// Signature providers: extensions that keep an identity's stored signature up to date.
//
// An identity names one in identities.signature_provider, with its settings in signature_config (JSON).
// A sync reports the identity's current html signature to the provider and gets back one of: write
// these exact bytes, nothing to do, or don't touch it (with a sentence saying why). Mailopus never
// splices a provider's content into the signature itself; the provider decides the whole signature,
// so it can find and replace its own part and keep a copy of what was there first.
//
// Settings may hold secrets (tokens), so Identity/get returns only the keys listed in `public`.
// To add a provider, add an entry to PROVIDERS.

export type SyncResult =
	| { action: "write"; html: string; ack?: (stored: string) => Promise<void> }
	| { action: "noop" }
	| { action: "refuse"; message: string };

type Provider = {
	label: string;
	/** Config keys the client may see and edit. Everything else is write-only. */
	public: string[];
	/** Config keys a client must send when it picks this provider. */
	required: string[];
	sync(identity: { email: string }, config: Record<string, string>, current: string): Promise<SyncResult>;
};

const SWIFTLY = "https://swiftly.biz";

export const PROVIDERS: Record<string, Provider> = {
	// Swiftly (swiftly.biz), as a write-head client: POST /api/agent/compose with the address and the
	// exact bytes in the signature now, then POST /api/agent/applied with what was stored. The agent
	// token comes from the Swiftly console and names one member; any of that member's addresses can sync.
	swiftly: {
		label: "Swiftly",
		public: ["block"],
		required: ["token"],
		async sync(identity, config, current) {
			// base is set only for a connection made against a local Swiftly (SWIFTLY_BASE in dev).
			const post = (path: string, body: object) => fetch(`${config.base || SWIFTLY}${path}`, {
				method: "POST",
				headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(8000),
			});
			const block = config.block || undefined;
			const res = await post("/api/agent/compose", { address: identity.email, reported: current, block });
			const body = (await res.json().catch(() => ({}))) as { action?: string; html?: string; hash?: string; message?: string; reason?: string; statusMessage?: string; data?: { reason?: string } };
			if (res.status === 401 || res.status === 403) return { action: "refuse", message: "Swiftly didn't accept the agent token. Make a new one in the Swiftly console." };
			if (!res.ok) throw new Error(`Swiftly returned ${res.status}${body.statusMessage ? ` (${body.statusMessage})` : ""}`);
			if (body.action === "write" && typeof body.html === "string") {
				return {
					action: "write",
					html: body.html,
					ack: async (stored) => {
						const r = await post("/api/agent/applied", { address: identity.email, hash: body.hash, status: "ok", readBack: stored, block });
						if (!r.ok) throw new Error(`Swiftly didn't record the write (${r.status})`);
					},
				};
			}
			if (body.action === "refuse") return { action: "refuse", message: body.message ?? `Swiftly won't update this signature (${body.reason}).` };
			return { action: "noop" };
		},
	},
};

/** Crude html-to-text for the text/plain signature. */
export const htmlText = (html: string) =>
	html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
		.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();

type Row = { id: string; account_id?: string; email: string; html_signature: string; signature_provider: string | null; signature_config: string };

/** The account's connection settings for a provider (from Connect), or {}. */
export async function connectionConfig(db: D1Database, account: string | undefined, provider: string) {
	if (!account) return {};
	const row = await db.prepare("SELECT config FROM signature_connections WHERE account_id = ? AND provider = ?").bind(account, provider).first<{ config: string }>();
	return row ? (JSON.parse(row.config) as Record<string, string>) : {};
}

/** One sync for one identity. Records the outcome on the row; never throws. */
export async function syncSignature(db: D1Database, row: Row, now = Date.now()) {
	const provider = row.signature_provider ? PROVIDERS[row.signature_provider] : undefined;
	if (!provider) return null;
	const done = (status: string | null) =>
		db.prepare("UPDATE identities SET signature_status = ?, signature_synced_at = ? WHERE id = ?").bind(status, now, row.id).run();
	try {
		// The identity's own settings (a pasted token, a block) win over the account's connection.
		const config = { ...(await connectionConfig(db, row.account_id, row.signature_provider!)), ...JSON.parse(row.signature_config || "{}") };
		if (provider.required.some((k) => !config[k])) return await done(`Connect ${provider.label} first.`), "error";
		const r = await provider.sync(row, config, row.html_signature);
		if (r.action === "write") {
			await db.prepare("UPDATE identities SET html_signature = ?, text_signature = ?, signature_status = NULL, signature_synced_at = ? WHERE id = ?")
				.bind(r.html, htmlText(r.html), now, row.id).run();
			await r.ack?.(r.html);
			return r.action;
		}
		await done(r.action === "refuse" ? r.message : null);
		return r.action;
	} catch (e) {
		const message = `Couldn't sync with ${provider.label}: ${(e as Error).message}`;
		console.error("signature sync", row.id, message);
		await done(message);
		return "error";
	}
}

/** For the cron: every provider-backed identity not synced in the last `every` ms. */
export async function syncDue(db: D1Database, every = 30 * 60_000, now = Date.now()) {
	const rows = await db.prepare("SELECT id, account_id, email, html_signature, signature_provider, signature_config FROM identities WHERE signature_provider IS NOT NULL AND coalesce(signature_synced_at, 0) < ?")
		.bind(now - every).all<Row>();
	for (const row of rows.results) await syncSignature(db, row, now);
	return rows.results.length;
}

export function publicConfig(provider: string | null, config: string) {
	const p = provider ? PROVIDERS[provider] : undefined;
	if (!p) return null;
	const all = JSON.parse(config || "{}") as Record<string, string>;
	return { name: provider, ...Object.fromEntries(p.public.filter((k) => k in all).map((k) => [k, all[k]])) };
}
