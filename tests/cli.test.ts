// The mailopus command: finding the command in argv, its options, help, and the unknown-command list.
// Nothing here reaches wrangler.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { COMMANDS, bindService, main, pluginEntry, resolve } from "../cli/cli.mjs";

test("resolve finds one-word and two-word commands", () => {
	assert.deepEqual({ ...resolve(["import", "status"]) }, { key: "import status", values: { __proto__: null }, positionals: [] });
	const r = resolve(["identity", "add", "sam@example.com", "Sam", "sam@second.example", "*@second.example"]);
	assert.equal(r.key, "identity add");
	assert.deepEqual(r.positionals, ["sam@example.com", "Sam", "sam@second.example", "*@second.example"]);
});

test("-c is accepted before or after the command, and options keep their defaults", () => {
	for (const argv of [
		["-c", "wrangler.app.jsonc", "invite", "sam@example.com", "--name", "Sam Lee"],
		["invite", "--name", "Sam Lee", "sam@example.com", "--config", "wrangler.app.jsonc"],
	]) {
		const r = resolve(argv);
		assert.equal(r.key, "invite");
		assert.deepEqual(r.positionals, ["sam@example.com"]);
		assert.equal(r.values.config, "wrangler.app.jsonc");
		assert.equal(r.values.name, "Sam Lee");
		assert.equal(r.values.hours, "24");
	}
});

test("an unknown command prints the list and fails", async (t) => {
	const err = t.mock.method(console, "error", () => {});
	assert.equal(await main(["import", "bogus"]), 1);
	const out = err.mock.calls[0].arguments[0];
	assert.match(out, /unknown command: import bogus/);
	for (const key of Object.keys(COMMANDS)) assert.ok(out.includes(`  ${key} `), key);
});

test("every command answers --help without running", async (t) => {
	const log = t.mock.method(console, "log", () => {});
	for (const [key, cmd] of Object.entries(COMMANDS)) {
		assert.equal(await main([...key.split(" "), "--help"]), 0);
		assert.ok(log.mock.calls.at(-1).arguments[0].startsWith(`usage: mailopus ${cmd.usage}`), key);
	}
	assert.equal(await main([]), 0);
	assert.match(log.mock.calls.at(-1).arguments[0], /^usage: mailopus <command>/);
});

test("bad arguments fail with the command's usage before anything runs", async (t) => {
	const err = t.mock.method(console, "error", () => {});
	assert.equal(await main(["invite"]), 1);
	assert.match(err.mock.calls.at(-1).arguments[0], /^usage: mailopus invite /);
	assert.equal(await main(["import", "start", "work", "not-an-address"]), 1);
	assert.equal(await main(["secret", "put"]), 1);
	assert.equal(await main(["address", "add", "orders@example.com"]), 1);
	assert.equal(await main(["address", "add", "not-an-address", "sam@example.com"]), 1);
	assert.equal(await main(["junk", "sam@example.com", "--limit", "5000"]), 1);
	assert.equal(await main(["import", "status", "--nope"]), 1);
	assert.match(err.mock.calls.at(-1).arguments[0], /--nope[\s\S]*usage: mailopus import status/);
});

test("with hands the rest of the line to the plugin untouched", () => {
	const r = resolve(["-c", "wrangler.app.jsonc", "with", "gotmail", "once", "receive", "--from=thedude72", "sound", "youvegotmail.wav", "-c", "x"]);
	assert.equal(r.key, "with");
	assert.equal(r.values.config, "wrangler.app.jsonc");
	assert.deepEqual(r.positionals, ["gotmail", "once", "receive", "--from=thedude72", "sound", "youvegotmail.wav", "-c", "x"]);
	assert.ok(!resolve(["with", "gotmail", "--help"]).values.help, "the plugin's own --help");
	assert.equal(resolve(["with", "--help"]).values.help, true);
	assert.equal(resolve(["invite", "with"]).key, "invite", "only as the command word");
});

test("pluginEntry defaults to a watcher of the envelope and refuses bad arguments", () => {
	assert.deepEqual(pluginEntry("got-mail", undefined, {}), { name: "got-mail", binding: "PLUGIN_GOT_MAIL", events: ["receive", "send"], wants: "envelope", act: false }, "bound, and no key");
	assert.equal(pluginEntry("gotmail", undefined, { binding: "ALERTS" }).binding, "ALERTS");
	assert.throws(() => pluginEntry("gotmail", "https://x.example", { binding: "ALERTS" }));
	assert.throws(() => pluginEntry("gotmail", undefined, { binding: "lower" }));
	const e = pluginEntry("gotmail", "https://gotmail.example.workers.dev/", {});
	assert.deepEqual({ ...e, key: "" }, { name: "gotmail", url: "https://gotmail.example.workers.dev", key: "", events: ["receive", "send"], wants: "envelope", act: false });
	assert.ok(e.key.length >= 32);
	assert.deepEqual(pluginEntry("f", "https://f.example", { events: "send", wants: "body", act: true, key: "k" }), { name: "f", url: "https://f.example", key: "k", events: ["send"], wants: "body", act: true });
	for (const bad of [["Bad Name", "https://x.example", {}], ["x", "http://x.example", {}], ["x", "https://x.example", { events: "read" }], ["x", "https://x.example", { wants: "everything" }]] as const)
		assert.throws(() => pluginEntry(...bad), JSON.stringify(bad));
});

test("bindService adds the binding to a wrangler config once, and the result still parses", () => {
	const parse = (s: string) => JSON.parse(s.replace(/^\s*\/\/.*$/gm, ""));
	const entry = { binding: "PLUGIN_GOTMAIL", service: "mailopus-gotmail", entrypoint: "Plugin" };
	const bare = '{\n\t// A comment that stays.\n\t"name": "mailopus",\n\t"vars": { "A": "{" }\n}\n';
	const once = bindService(bare, "PLUGIN_GOTMAIL", "mailopus-gotmail");
	assert.match(once, /A comment that stays/);
	assert.deepEqual(parse(once), { services: [entry], name: "mailopus", vars: { A: "{" } });
	assert.equal(bindService(once, "PLUGIN_GOTMAIL", "mailopus-gotmail"), once, "adding it again changes nothing");
	assert.deepEqual(parse(bindService(once, "PLUGIN_TWO", "two")).services, [{ ...entry, binding: "PLUGIN_TWO", service: "two" }, entry]);
	const spam = { binding: "SPAM", service: "mailopus-spam", entrypoint: "SpamFilter" };
	assert.deepEqual(parse(bindService(`{\n\t"services": [${JSON.stringify(spam)}],\n\t"name": "x"\n}`, "PLUGIN_GOTMAIL", "mailopus-gotmail")).services, [entry, spam]);
	assert.deepEqual(parse(bindService('{\n\t"services": [],\n\t"name": "x"\n}', "PLUGIN_GOTMAIL", "mailopus-gotmail")).services, [entry]);
	assert.deepEqual(parse(bindService(readFileSync("wrangler.jsonc", "utf8"), "PLUGIN_GOTMAIL", "mailopus-gotmail")).services, [entry], "the template");
	assert.throws(() => bindService(bare, "PLUGIN_X", "not a name"));
});
