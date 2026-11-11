// What the plugin does, apart from how it is reached (index.ts). Two endpoints:
//   POST /v1/event    your Mailopus server tells it about a received or sent message
//   POST /v1/command  `mailopus with gotmail <words>` runs one of the commands in rules.ts HELP
import { type ChannelEnv, missing, send } from "./channels.ts";
import { CHANNELS, HELP, type MailEvent, type Rule, alertText, describe, matches, parseRule } from "./rules.ts";

export type Env = ChannelEnv & { PLUGIN_KEY?: string; GOTMAIL: KVNamespace };

/** A sound alert waiting for `listen` to pick it up. */
type Pending = { text: string; sound: string | true; at: number };

const sha256 = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

/** Compares hashes, so the comparison takes the same time however much of the key is right. */
async function authorized(header: string | null, key: string | undefined): Promise<boolean> {
	const given = header?.match(/^Bearer (\S+)$/)?.[1];
	if (!key || !given) return false;
	const [a, b] = await Promise.all([sha256(given), sha256(key)]);
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
	return diff === 0;
}

// ponytail: rules and pending alerts are each one KV value, read, changed and written back. Two
// writes in the same second can lose one. Fine for one person's alerts; a Durable Object if not.
const load = async <T>(env: Env, key: string) => ((await env.GOTMAIL.get(key, "json")) as T[] | null) ?? [];
const save = (env: Env, key: string, list: unknown[]) => env.GOTMAIL.put(key, JSON.stringify(list));
const PENDING_TTL_MS = 10 * 60_000;

async function onEvent(env: Env, e: MailEvent): Promise<Response> {
	const rules = await load<Rule>(env, "rules");
	const hits = rules.filter((r) => matches(r, e));
	if (!hits.length) return Response.json({ alerts: 0 });
	const text = alertText(e);
	const sounds: Pending[] = [];
	const errors: string[] = [];
	for (const r of hits) {
		if (r.channel === "sound") sounds.push({ text, sound: r.arg ?? true, at: Date.now() });
		else await send(env, r, text, e).catch((err: Error) => errors.push(err.message));
	}
	if (sounds.length) await save(env, "pending", [...(await load<Pending>(env, "pending")), ...sounds]);
	// A test leaves `once` rules in place, so you can try a rule before the real mail comes.
	const spent = e.test ? [] : hits.filter((r) => r.times === "once").map((r) => r.id);
	if (spent.length) await save(env, "rules", rules.filter((r) => !spent.includes(r.id)));
	for (const err of errors) console.warn("gotmail:", err);
	return Response.json({ alerts: hits.length, ...(errors.length && { errors }) });
}

async function onCommand(env: Env, args: string[]): Promise<Response> {
	const say = (text: string, status = 200, more: object = {}) => Response.json({ text, ...more }, { status });
	const [cmd, ...rest] = args;
	if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") return say(HELP);
	if (cmd === "list") {
		const rules = await load<Rule>(env, "rules");
		const ready = CHANNELS.filter((channel) => !missing(env, { channel, arg: "x" }));
		return say(`${rules.length ? rules.map(describe).join("\n") : "no rules"}\n\nchannels set up: ${ready.join(", ")}`);
	}
	if (cmd === "remove") {
		const rules = await load<Rule>(env, "rules");
		if (!rest[0] || !rules.some((r) => r.id === rest[0])) return say(`No rule with id ${rest[0] ?? ""}. See: list`, 400);
		await save(env, "rules", rules.filter((r) => r.id !== rest[0]));
		return say(`removed ${rest[0]}`);
	}
	if (cmd === "listen") {
		const pending = await load<Pending>(env, "pending");
		const fresh = pending.filter((p) => Date.now() - p.at < PENDING_TTL_MS);
		// One alert per answer, so each plays. Come back at once while more are waiting.
		const [next, ...later] = fresh;
		if (pending.length) await save(env, "pending", later);
		return Response.json(next ? { text: next.text, sound: next.sound, again: later.length ? 1 : 5 } : { again: 5 });
	}
	const rule = parseRule(args);
	if (typeof rule === "string") return say(`${rule}\n\n${HELP}`, 400);
	const not = missing(env, rule);
	if (not) return say(not, 400);
	const id = crypto.randomUUID().slice(0, 6);
	await save(env, "rules", [...(await load<Rule>(env, "rules")), { ...rule, id }]);
	return say(`added: ${describe({ ...rule, id })}${rule.channel === "sound" ? "\nKeep this running where the sound should play: mailopus with gotmail listen" : ""}`);
}

/** Both endpoints, for a caller already known to be your server. */
export async function handle(request: Request, env: Env): Promise<Response> {
	const path = new URL(request.url).pathname;
	if (path !== "/v1/event" && path !== "/v1/command") return new Response("not found\n", { status: 404 });
	if (request.method !== "POST") return new Response(null, { status: 405 });
	const body = (await request.json().catch(() => null)) as { args?: unknown; event?: unknown; message?: unknown } | null;
	if (path === "/v1/command") {
		if (!Array.isArray(body?.args) || !body.args.every((a) => typeof a === "string")) return new Response(null, { status: 400 });
		return onCommand(env, body.args as string[]);
	}
	const m = body?.message as MailEvent["message"] | undefined;
	if ((body?.event !== "receive" && body?.event !== "send") || typeof m?.from?.email !== "string" || !Array.isArray(m.to) || !Array.isArray(m.cc)) return new Response(null, { status: 400 });
	return onEvent(env, body as MailEvent);
}

/** The same, for a caller from the internet: only with PLUGIN_KEY, and never when it isn't set. */
export async function handlePublic(request: Request, env: Env): Promise<Response> {
	if (!(await authorized(request.headers.get("authorization"), env.PLUGIN_KEY))) return new Response(null, { status: 401 });
	return handle(request, env);
}
