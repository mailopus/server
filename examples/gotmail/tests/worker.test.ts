// The Worker end to end, with KV as a Map and fetch stubbed, so nothing leaves this machine.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Env, handle, handlePublic } from "../src/app.ts";

function setup(secrets: Partial<Env> = {}) {
	const kv = new Map<string, string>();
	const env = {
		PLUGIN_KEY: "test-key",
		GOTMAIL: { get: async (k: string) => (kv.has(k) ? JSON.parse(kv.get(k)!) : null), put: async (k: string, v: string) => void kv.set(k, v) },
		...secrets,
	} as unknown as Env;
	const post = async (path: string, body: unknown, key = "test-key") => {
		const res = await handlePublic(new Request(`https://gotmail.example${path}`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify(body) }), env);
		return { status: res.status, body: (await res.json().catch(() => null)) as any };
	};
	const run = (...args: string[]) => post("/v1/command", { args });
	const mail = (from: string, more: object = {}) =>
		post("/v1/event", { event: "receive", account: "a", message: { from: { name: "", email: from }, to: ["me@example.com"], cc: [], subject: "hi", junk: false }, ...more });
	return { env, run, mail, post };
}

/** Records outgoing requests in place of the real fetch for the length of fn. */
async function outgoing(fn: (sent: { url: string; init: RequestInit }[]) => Promise<void>, status = 200) {
	const real = globalThis.fetch;
	const sent: { url: string; init: RequestInit }[] = [];
	globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
		sent.push({ url: String(url), init: init! });
		return new Response("", { status });
	}) as typeof fetch;
	try {
		await fn(sent);
	} finally {
		globalThis.fetch = real;
	}
}

test("the public address needs the key, and is closed when no key is set", async () => {
	const { post, env } = setup();
	const list = () => new Request("https://plugin.internal/v1/command", { method: "POST", body: JSON.stringify({ args: ["list"] }) });
	assert.equal((await handle(list(), env)).status, 200, "the binding's entrypoint asks for no key");
	assert.equal((await handlePublic(list(), { ...env, PLUGIN_KEY: undefined })).status, 401);
	assert.equal((await setup({ PLUGIN_KEY: undefined }).post("/v1/command", { args: ["list"] }, "undefined")).status, 401);
	assert.equal((await post("/v1/command", { args: ["list"] }, "wrong")).status, 401);
	assert.equal((await post("/v1/event", {}, "wrong")).status, 401);
	assert.equal((await post("/v1/event", { event: "receive" })).status, 400);
	assert.equal((await post("/v1/nope", {})).status, 404);
});

test("a once rule alerts Slack one time, then is gone", async () => {
	const { run, mail } = setup({ SLACK_WEBHOOK_URL: "https://hooks.slack.example/T/B" });
	assert.match((await run("once", "receive", "--from=thedude72", "slack")).body.text, /^added: \w{6}  once receive --from thedude72 slack/);
	await outgoing(async (sent) => {
		assert.deepEqual((await mail("someone@else.example")).body, { alerts: 0 });
		assert.deepEqual((await mail("TheDude72@gmail.com", { test: true })).body, { alerts: 1 });
		assert.deepEqual((await mail("TheDude72@gmail.com")).body, { alerts: 1 });
		assert.deepEqual((await mail("TheDude72@gmail.com")).body, { alerts: 0 }, "spent");
		assert.deepEqual(sent.map((s) => [s.url, JSON.parse(String(s.init.body)).text]), [
			["https://hooks.slack.example/T/B", "[test] You've got mail from TheDude72@gmail.com: hi"],
			["https://hooks.slack.example/T/B", "You've got mail from TheDude72@gmail.com: hi"],
		]);
	});
	assert.match((await run("list")).body.text, /^no rules\n\nchannels set up: slack, sound$/);
});

test("an every rule stays, texts through Twilio, and reports a refusal without failing", async () => {
	const { run, mail } = setup({ TWILIO_ACCOUNT_SID: "ACtest", TWILIO_AUTH_TOKEN: "tok", TWILIO_FROM: "+15550001111", SMS_TO: "+15550002222" });
	await run("every", "receive", "--from", "dude", "sms");
	await run("every", "receive", "--from", "dude", "sms", "+15550003333");
	await outgoing(async (sent) => {
		assert.deepEqual((await mail("dude@x.example")).body, { alerts: 2 });
		assert.equal(sent[0]!.url, "https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages.json");
		assert.equal(new Headers(sent[0]!.init.headers).get("authorization"), `Basic ${btoa("ACtest:tok")}`);
		assert.deepEqual(sent.map((s) => Object.fromEntries(s.init.body as URLSearchParams).To), ["+15550002222", "+15550003333"]);
	});
	await outgoing(async () => {
		const r = await mail("dude@x.example");
		assert.equal(r.status, 200);
		assert.deepEqual(r.body.errors, ["sms answered 500", "sms answered 500"]);
	}, 500);
	assert.equal((await run("list")).body.text.split("\n").filter((l: string) => l.includes("every receive")).length, 2);
});

test("a rule for a channel with no secrets is refused, and so is a bad command", async () => {
	const { run } = setup();
	const r = await run("once", "receive", "--from", "x", "webhook");
	assert.equal(r.status, 400);
	assert.match(r.body.text, /Set WEBHOOK_URL/);
	assert.equal((await run("once", "receive", "pager")).status, 400);
	assert.match((await run("help")).body.text, /^gotmail alerts you/);
	assert.equal((await run("remove", "nope")).status, 400);
});

test("sound alerts wait for listen, which hands them out one at a time", async () => {
	const { run, mail } = setup();
	const added = await run("every", "receive", "--from", "dude", "sound", "youvegotmail.wav");
	assert.match(added.body.text, /mailopus with gotmail listen/);
	assert.deepEqual((await run("listen")).body, { again: 5 });
	await mail("dude@x.example");
	await mail("dude@x.example");
	assert.deepEqual((await run("listen")).body, { text: "You've got mail from dude@x.example: hi", sound: "youvegotmail.wav", again: 1 });
	assert.equal((await run("listen")).body.again, 5);
	assert.deepEqual((await run("listen")).body, { again: 5 });
	const id = added.body.text.match(/added: (\w+)/)[1];
	assert.equal((await run("remove", id)).body.text, `removed ${id}`);
});
