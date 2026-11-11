// The HTTP contract Mailopus relies on (src/protocol.ts). Change these only together with Mailopus.
import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../src/index.ts";
import { MAX_HEADERS, parseRequest } from "../src/protocol.ts";

const KEY = "test-key";
const env = { CLASSIFIER_KEY: KEY };
const check = (body: unknown, init: { key?: string | null; method?: string; path?: string } = {}) => {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (init.key !== null) headers.authorization = `Bearer ${init.key ?? KEY}`;
	const method = init.method ?? "POST";
	return worker.fetch(new Request(`https://classifier.example${init.path ?? "/v1/check"}`, {
		method, headers, ...(method === "POST" && { body: typeof body === "string" ? body : JSON.stringify(body) }),
	}), env);
};

test("a valid request gets {rule}: a name or null", async () => {
	const hit = await check({ headers: "X-Mailer: PHPMailer 6\r\n", ctx: { firstContact: true } });
	assert.equal(hit.status, 200);
	assert.deepEqual(await hit.json(), { rule: "bulk-library-first-contact" });
	const miss = await check({ headers: "From: a@b.example\r\n", ctx: {} });
	assert.deepEqual(await miss.json(), { rule: null });
});

test("no key, a wrong key, or no key configured is 401", async () => {
	const body = { headers: "From: a@b.example", ctx: {} };
	assert.equal((await check(body, { key: null })).status, 401);
	assert.equal((await check(body, { key: "wrong" })).status, 401);
	const unset = await worker.fetch(new Request("https://classifier.example/v1/check", {
		method: "POST", headers: { authorization: "Bearer anything" }, body: JSON.stringify(body),
	}), {});
	assert.equal(unset.status, 401, "a Worker with no CLASSIFIER_KEY accepts nobody");
});

test("malformed bodies are 400, other paths 404, other methods 405", async () => {
	assert.equal((await check("not json")).status, 400);
	assert.equal((await check({ ctx: {} })).status, 400, "headers missing");
	assert.equal((await check({ headers: "x".repeat(MAX_HEADERS + 1), ctx: {} })).status, 400, "too large");
	assert.equal((await check({}, { path: "/" })).status, 404);
	assert.equal((await check(null, { method: "GET" })).status, 405);
});

test("context fields of the wrong type are dropped, never trusted", () => {
	assert.deepEqual(parseRequest({ headers: "", ctx: { firstContact: "yes", senderHasRdns: 0, senderDomainAgeDays: "12", extra: 1 } })?.ctx, {});
	assert.deepEqual(parseRequest({ headers: "", ctx: { firstContact: true, senderDomainAgeDays: 12 } })?.ctx, { firstContact: true, senderDomainAgeDays: 12 });
	assert.deepEqual(parseRequest({ headers: "" })?.ctx, {}, "ctx is optional");
	assert.equal(parseRequest({ headers: "", ctx: { senderDomainAgeDays: Number.NaN } })?.ctx.senderDomainAgeDays, undefined);
});
