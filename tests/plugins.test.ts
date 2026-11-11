// Plugins on the receive path (server/lib/plugin-hooks.ts through ingestRaw). The send path is in
// compose-server.test.ts, and the CLI side in cli.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ingestRaw } from "../server/lib/ingest.ts";
import type { IngestInput } from "../server/lib/jmap/write.ts";
import { cliPluginCall, parsePlugins } from "../server/lib/plugin-hooks.ts";
import { testD1 } from "./d1.ts";

const raw = () => new TextEncoder().encode("From: Ann <ann@y.co>\r\nTo: me@mailopus.net\r\nSubject: the update\r\nMessage-ID: <p1@y.co>\r\n\r\nsecret body\r\n").buffer as ArrayBuffer;

/** ingestRaw with these plugins installed. answers: what each plugin host replies, or a status. */
async function receive(plugins: unknown, answers: Record<string, unknown>, bindings: object = {}) {
	const db = testD1();
	if (plugins !== undefined) db.raw.prepare("INSERT INTO instance_settings (key, value) VALUES ('plugins', ?)").run(typeof plugins === "string" ? plugins : JSON.stringify(plugins));
	const stored: IngestInput[] = [];
	const asked: { host: string; auth: string | null; body: any; storedYet: boolean }[] = [];
	const env = {
		DB: db,
		MAIL: { put: async () => {} },
		ACCOUNT: { idFromName: (n: string) => n, get: () => ({ ingest: async (_a: string, m: IngestInput) => void stored.push(m) ?? { id: m.id } }) },
		...bindings,
	} as unknown as Env;
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		// Anything else is the sender-domain lookup the spam path makes.
		if (!(url.host in answers)) return new Response("", { status: 404 });
		assert.equal(url.pathname, "/v1/event");
		asked.push({ host: url.host, auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)), storedYet: stored.length > 0 });
		const a = answers[url.host];
		if (a === "throw") throw new Error("down");
		return typeof a === "number" ? new Response("", { status: a }) : typeof a === "string" ? new Response(a) : Response.json(a);
	}) as typeof fetch;
	try {
		const result = await ingestRaw(env, { from: "ann@y.co", to: "me@mailopus.net", raw: raw() }, async () => null);
		return { result, stored, asked };
	} finally {
		globalThis.fetch = realFetch;
	}
}

const p = (name: string, extra: Record<string, unknown> = {}) => ({ name, url: `https://${name}.example/`, key: `key-${name}`, events: ["receive"], ...extra });

test("parsePlugins keeps well-formed entries and defaults them to watching the envelope", () => {
	assert.deepEqual(parsePlugins(JSON.stringify([p("gotmail"), { name: "Bad Name", url: "https://x.example", key: "k" }, { name: "plain", url: "http://x.example", key: "k" }, { name: "nokey", url: "https://x.example" }])), [
		{ name: "gotmail", url: "https://gotmail.example", key: "key-gotmail", events: ["receive"], wants: "envelope", act: false },
	]);
	assert.deepEqual(parsePlugins("not json"), []);
	assert.deepEqual(parsePlugins(null), []);
});

test("a watching plugin hears about stored mail, and sees only what it asked for", async () => {
	const { stored, asked } = await receive([p("env"), p("hdr", { wants: "headers" }), p("all", { wants: "body" }), p("sendonly", { events: ["send"] })], { "env.example": {}, "hdr.example": {}, "all.example": {}, "sendonly.example": {} });
	assert.equal(stored.length, 1);
	assert.deepEqual(asked.map((a) => a.host).sort(), ["all.example", "env.example", "hdr.example"]);
	const by = Object.fromEntries(asked.map((a) => [a.host, a]));
	assert.ok(asked.every((a) => a.storedYet), "told after the mail is stored");
	assert.equal(by["env.example"]!.auth, "Bearer key-env");
	assert.deepEqual(by["env.example"]!.body, {
		event: "receive",
		account: "acct",
		message: { from: { name: "Ann", email: "ann@y.co" }, to: ["me@mailopus.net"], cc: [], subject: "the update", messageId: "<p1@y.co>", date: null, rcpt: "me@mailopus.net", junk: false },
	});
	assert.match(by["hdr.example"]!.body.headers, /Subject: the update/);
	assert.equal(by["hdr.example"]!.body.body, undefined);
	assert.match(by["all.example"]!.body.body, /secret body/);
});

test("a plugin that acts is asked first and can junk the message or set keywords", async () => {
	const { stored, asked } = await receive([p("filer", { act: true }), p("watch")], { "filer.example": { junk: true, keywords: ["$seen", "bad keyword", 7] }, "watch.example": {} });
	assert.deepEqual(asked.map((a) => [a.host, a.storedYet]), [["filer.example", false], ["watch.example", true]]);
	assert.equal(stored[0]!.spamRule, "plugin:filer");
	assert.deepEqual(stored[0]!.keywords, { $seen: true });
	assert.equal(asked[1]!.body.message.junk, true, "the watcher hears where it went");
});

test("a broken plugin or a broken list never stops delivery", async () => {
	for (const answer of [500, "throw", "not json"]) {
		const { result, stored } = await receive([p("filer", { act: true }), p("watch")], { "filer.example": answer, "watch.example": answer });
		assert.ok(result, String(answer));
		assert.equal(stored[0]!.spamRule, null);
		assert.deepEqual(stored[0]!.keywords, {});
	}
	const { stored, asked } = await receive("{not json", {});
	assert.equal(stored.length, 1);
	assert.equal(asked.length, 0);
	assert.equal((await receive(undefined, {})).stored.length, 1, "no plugins installed");
});

test("a bound plugin is reached through its binding, with no key and no public request", async () => {
	const seen: { url: string; auth: string | null; body: any }[] = [];
	const PLUGIN_BOUND = {
		fetch: async (url: string, init: RequestInit) => {
			seen.push({ url, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
			return Response.json({ junk: true });
		},
	};
	const bound = { name: "bound", binding: "PLUGIN_BOUND", url: "https://ignored.example", key: "unused", events: ["receive"], act: true };
	assert.deepEqual(parsePlugins(JSON.stringify([bound, { name: "lower", binding: "plugin_lower" }])), [{ name: "bound", binding: "PLUGIN_BOUND", events: ["receive"], wants: "envelope", act: true }]);
	const { stored, asked } = await receive([bound], { "ignored.example": {} }, { PLUGIN_BOUND });
	assert.equal(asked.length, 0, "nothing went over the internet");
	assert.deepEqual(seen.map((s) => [s.url, s.auth, s.body.event]), [["https://plugin.internal/v1/event", null, "receive"]]);
	assert.equal(stored[0]!.spamRule, "plugin:bound");
	// The binding isn't deployed yet: the mail is delivered as if the plugin had said nothing.
	const missing = await receive([bound], {});
	assert.equal(missing.stored[0]!.spamRule, null);
});

test("the command line reaches a plugin through the server only with a token it wrote to D1", async () => {
	const db = testD1();
	const args: unknown[] = [];
	const env = { DB: db, PLUGIN_BOUND: { fetch: async (url: string, init: RequestInit) => void args.push([url, JSON.parse(String(init.body))]) ?? Response.json({ text: "added" }, { status: 201 }) } };
	db.raw.prepare("INSERT INTO instance_settings (key, value) VALUES ('plugins', ?)").run(JSON.stringify([{ name: "bound", binding: "PLUGIN_BOUND" }, { name: "undeployed", binding: "PLUGIN_NOPE" }]));
	const hash = async (s: string) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))).toString("hex");
	const grant = async (token: string, expires: number) => void db.raw.prepare("INSERT INTO instance_settings (key, value) VALUES (?, ?)").run(`cli-token:${await hash(token)}`, String(expires));
	const call = (token: unknown, name = "bound") => cliPluginCall(env, { token, name, path: "command", body: { args: ["list"] } });

	assert.equal((await call("never-written")).status, 401);
	assert.equal((await cliPluginCall(env, null)).status, 400);
	await grant("expired", Date.now() - 1);
	await grant("too-long", Date.now() + 86_400_000);
	await grant("good", Date.now() + 60_000);
	assert.equal((await call("expired")).status, 401);
	assert.equal((await call("too-long")).status, 401, "a token can't outlive five minutes");
	assert.equal(args.length, 0);

	const ok = await call("good");
	assert.deepEqual([ok.status, await ok.json()], [201, { text: "added" }]);
	assert.deepEqual(args, [["https://plugin.internal/v1/command", { args: ["list"] }]]);
	assert.equal((await call("good", "nobody")).status, 404);
	const down = await call("good", "undeployed");
	assert.equal(down.status, 502);
	assert.match(((await down.json()) as { text: string }).text, /no PLUGIN_NOPE binding/);
	const left = db.raw.prepare("SELECT count(*) AS n FROM instance_settings WHERE key LIKE 'cli-token:%'").get() as { n: number };
	assert.equal(left.n, 2, "the expired token was swept");
});
