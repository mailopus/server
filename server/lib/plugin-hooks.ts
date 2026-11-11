// Plugins: Workers the owner deploys that hear about mail as it arrives and leaves (docs/plugins.md).
// The list lives in D1, in instance_settings under 'plugins', written by `mailopus plugin add`
// (cli/cli.mjs). Each entry says how to reach the plugin, which events it gets, how much of the
// message it may see, and whether the server waits for its answer.
//
// A plugin is reached through a service binding to a Worker in the same account, which has no
// public address and needs no key. One at an https URL with a key is the fallback, for a plugin
// that can't live in this account.
//
// A plugin can never lose mail. Every call has a timeout, and a slow, broken or malformed plugin
// counts as one that said nothing.

export type PluginEventName = "receive" | "send";

export type Plugin = {
	name: string;
	/** The service binding on this Worker that reaches the plugin. Wins over url. */
	binding?: string;
	/** Without a binding: the base URL, and the key sent as a bearer token. */
	url?: string;
	key?: string;
	events: PluginEventName[];
	/** envelope: who, to whom, subject. headers: plus the header block. body: plus the text. */
	wants: "envelope" | "headers" | "body";
	/** true: asked before the mail moves, and its answer can file or block it. false: told after. */
	act: boolean;
};

export type PluginMessage = {
	from: { name: string; email: string };
	to: string[];
	cc: string[];
	subject: string | null;
	messageId: string | null;
	/** The Date header, ms since the epoch. */
	date: number | null;
	/** receive: the address the mail was delivered to. */
	rcpt?: string;
	/** receive: whether it went to Junk. Plugins that act are asked before that is final. */
	junk?: boolean;
};

/** What the server knows about one message. headers and body go only to plugins that want them. */
export type MailEvent = {
	event: PluginEventName;
	account: string;
	message: PluginMessage;
	headers: () => string;
	body: () => string | Promise<string>;
};

/** What the acting plugins decided, merged. */
export type PluginVerdict = {
	/** receive: the plugin that said junk. */
	junk?: string;
	/** receive: keywords to set, such as $seen or $flagged. */
	keywords: Record<string, true>;
	/** send: why it must not go, as "<plugin>: <reason>". */
	block?: string;
};

export const PLUGIN_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const BINDING = /^[A-Z][A-Z0-9_]{0,63}$/;
const KEYWORD = /^\$?[a-z0-9_-]{1,32}$/i;
/** Whatever holds this Worker's bindings: env. */
export type Bindings = object | undefined;
const TIMEOUT_MS = 1500;

/** The stored list, checked. Anything malformed is dropped, never thrown. */
export function parsePlugins(value: string | null | undefined): Plugin[] {
	if (!value) return [];
	try {
		const list = JSON.parse(value) as Partial<Plugin>[];
		return list
			.map((p) => ({ ...p, binding: typeof p?.binding === "string" && BINDING.test(p.binding) ? p.binding : undefined }))
			.filter((p) => typeof p.name === "string" && PLUGIN_NAME.test(p.name) && (p.binding || (typeof p.url === "string" && p.url.startsWith("https://") && typeof p.key === "string" && p.key.length > 0)))
			.map((p) => ({
				name: p.name!,
				...(p.binding ? { binding: p.binding } : { url: p.url!.replace(/\/+$/, ""), key: p.key! }),
				events: (Array.isArray(p.events) ? p.events : []).filter((e) => e === "receive" || e === "send"),
				wants: p.wants === "headers" || p.wants === "body" ? p.wants : "envelope",
				act: p.act === true,
			}));
	} catch {
		console.warn("plugins: the stored list is not valid JSON, ignoring it");
		return [];
	}
}

/** Every connected plugin. One primary-key read. */
export async function allPlugins(db: D1Database): Promise<Plugin[]> {
	const row = await db.prepare("SELECT value FROM instance_settings WHERE key = 'plugins'").first<{ value: string }>();
	return parsePlugins(row?.value);
}

/** The plugins that get this event. */
export const pluginsFor = async (db: D1Database, event: PluginEventName) => (await allPlugins(db)).filter((p) => p.events.includes(event));

/** POSTs JSON to one of a plugin's two endpoints, over its binding when it has one. */
export async function postPlugin(env: Bindings, p: Plugin, path: "event" | "command", body: unknown, timeoutMs = TIMEOUT_MS): Promise<Response> {
	const init = { method: "POST", headers: { "content-type": "application/json", ...(!p.binding && { authorization: `Bearer ${p.key}` }) }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) };
	if (!p.binding) return fetch(`${p.url}/v1/${path}`, init);
	const service = (env as Record<string, { fetch?: typeof fetch } | undefined> | undefined)?.[p.binding];
	if (typeof service?.fetch !== "function") throw new Error(`no ${p.binding} binding on this Worker. Add it to wrangler.jsonc and deploy.`);
	// The host is never looked up. A binding goes straight to the plugin's Worker.
	return service.fetch(`https://plugin.internal/v1/${path}`, init);
}

/** Posts the event, cut down to what the plugin may see. Its JSON answer, or null on any failure. */
async function call(env: Bindings, p: Plugin, e: MailEvent): Promise<Record<string, unknown> | null> {
	try {
		const res = await postPlugin(env, p, "event", {
			event: e.event,
			account: e.account,
			message: e.message,
			...(p.wants !== "envelope" && { headers: e.headers() }),
			...(p.wants === "body" && { body: await e.body() }),
		});
		if (!res.ok) {
			console.warn("plugin:", p.name, "answered", res.status);
			return null;
		}
		const answer = await res.json().catch(() => null);
		return answer && typeof answer === "object" ? (answer as Record<string, unknown>) : {};
	} catch (err) {
		console.warn("plugin:", p.name, "failed:", (err as Error).message);
		return null;
	}
}

/**
 * Asks the plugins that act, one after another, before the mail moves. On receive an answer of
 * {"junk": true} files it in Junk and {"keywords": ["$seen"]} sets keywords. On send
 * {"block": "<reason>"} stops it, and no later plugin is asked.
 */
export async function askPlugins(env: Bindings, plugins: Plugin[], e: MailEvent): Promise<PluginVerdict> {
	const verdict: PluginVerdict = { keywords: {} };
	for (const p of plugins.filter((x) => x.act)) {
		const a = await call(env, p, e);
		if (!a) continue;
		if (e.event === "send") {
			if (typeof a.block === "string" && a.block) return { ...verdict, block: `${p.name}: ${a.block.slice(0, 200)}` };
			continue;
		}
		if (a.junk === true) verdict.junk ??= p.name;
		if (Array.isArray(a.keywords)) for (const k of a.keywords.slice(0, 8)) if (typeof k === "string" && KEYWORD.test(k)) verdict.keywords[k.toLowerCase()] = true;
	}
	return verdict;
}

/** Tells the plugins that only watch, all at once, after the mail has moved. Never throws. */
export async function tellPlugins(env: Bindings, plugins: Plugin[], e: MailEvent): Promise<void> {
	await Promise.all(plugins.filter((p) => !p.act).map((p) => call(env, p, e)));
}

// ---------- calls from the command line ----------

const CLI_TOKEN_MS = 5 * 60_000;
const hex = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * `mailopus with <plugin>` and `mailopus plugin test` reach a bound plugin through this server,
 * since only this Worker has the binding. The credential is a token whose hash the CLI wrote to D1
 * moments before, which it can do only with the owner's cloud login, the same root of trust as an
 * invite. A token works for five minutes, so a command that keeps asking doesn't mint one per call.
 */
export async function cliPluginCall(env: Bindings & { DB: D1Database }, input: { token?: unknown; name?: unknown; path?: unknown; body?: unknown } | null): Promise<Response> {
	const say = (status: number, text: string) => Response.json({ text }, { status });
	if (typeof input?.token !== "string" || typeof input.name !== "string" || (input.path !== "event" && input.path !== "command")) return say(400, "bad request");
	const now = Date.now();
	await env.DB.prepare("DELETE FROM instance_settings WHERE key LIKE 'cli-token:%' AND CAST(value AS INTEGER) < ?").bind(now).run();
	const row = await env.DB.prepare("SELECT value FROM instance_settings WHERE key = ?").bind(`cli-token:${await hex(input.token)}`).first<{ value: string }>();
	if (!row || !(Number(row.value) > now) || Number(row.value) > now + CLI_TOKEN_MS) return say(401, "That token isn't valid here. Check that the command line and this server use the same database.");
	const p = (await allPlugins(env.DB)).find((x) => x.name === input.name);
	if (!p) return say(404, `no plugin named ${input.name}`);
	try {
		const res = await postPlugin(env, p, input.path, input.body, 15_000);
		return new Response(res.body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });
	} catch (e) {
		return say(502, `${p.name} didn't answer: ${(e as Error).message}`);
	}
}
