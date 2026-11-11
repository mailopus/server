// The rules against real-shaped header blocks. To add a case: drop a header block in tests/fixtures/
// and add it to tests/fixtures/expected.json with the context and the rule you expect.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import type { Context } from "../src/protocol.ts";
import { RULES, classify } from "../src/rules.ts";

const dir = new URL("./fixtures/", import.meta.url);
const { cases } = JSON.parse(readFileSync(new URL("expected.json", dir), "utf8")) as {
	cases: { fixture: string; ctx: Context; rule: string | null }[];
};
const fixture = (name: string) => readFileSync(new URL(`${name}.txt`, dir), "utf8");

for (const c of cases) {
	test(`${c.fixture} with ${JSON.stringify(c.ctx)} -> ${c.rule}`, () => {
		assert.equal(classify(fixture(c.fixture), c.ctx), c.rule);
	});
}

test("every fixture file has at least one expectation", () => {
	const files = readdirSync(dir).filter((f) => f.endsWith(".txt")).map((f) => f.slice(0, -4));
	const covered = new Set(cases.map((c) => c.fixture));
	assert.deepEqual(files.filter((f) => !covered.has(f)), []);
});

test("an unknown context fact never fires a rule", () => {
	// Mailopus leaves a fact out when its lookup failed. Failing to look something up must not junk mail.
	for (const r of RULES) {
		if (r.needs) assert.equal(r.needs({}), false, `${r.name} fires with no context`);
		assert.ok(r.all.length > 0 || r.needs, `${r.name} has neither patterns nor needs, so it would junk everything`);
	}
});

test("rule names are unique, lowercase-with-dashes and short enough for Mailopus", () => {
	const names = RULES.map((r) => r.name);
	assert.equal(new Set(names).size, names.length, "duplicate rule name");
	for (const n of names) assert.match(n, /^[a-z0-9]+(-[a-z0-9]+)*$/, n);
	for (const n of names) assert.ok(n.length <= 64, n);
});

test("patterns stay fast on a large hostile header block", () => {
	// A catastrophic-backtracking regex would blow the Worker's CPU limit on one crafted message.
	const hostile = `X-Junk: ${"a".repeat(200_000)}!\n`.repeat(1);
	const start = performance.now();
	classify(hostile, { firstContact: true, senderHasRdns: true, senderDomainAgeDays: 1 });
	assert.ok(performance.now() - start < 50, "classify took over 50 ms");
});
