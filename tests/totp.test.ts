// The authenticator code step (server/lib/totp.ts). Run: pnpm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { base32, checkTotp, newTotpSecret, otpauthUri, spendStep, stepAt, totpCode, unbase32 } from "../server/lib/totp.ts";
import { testD1 } from "./d1.ts";

// RFC 6238 appendix B: the SHA-1 secret is the ASCII "12345678901234567890"; 8-digit codes end in these 6.
const RFC = base32(new TextEncoder().encode("12345678901234567890"));

test("codes match RFC 6238's test vectors", async () => {
	assert.equal(await totpCode(RFC, stepAt(59_000)), "287082");
	assert.equal(await totpCode(RFC, stepAt(1_111_111_109_000)), "081804");
	assert.equal(await totpCode(RFC, stepAt(2_000_000_000_000)), "279037");
});

test("base32 round-trips, and a new secret is 160 bits", () => {
	const bytes = crypto.getRandomValues(new Uint8Array(20));
	assert.deepEqual(unbase32(base32(bytes)), bytes);
	assert.equal(unbase32(newTotpSecret()).length, 20);
	assert.deepEqual(unbase32("gezd gnbv-gy3t qojq"), unbase32("GEZDGNBVGY3TQOJQ"), "spaces, dashes and case are ignored");
});

test("a code is good one step either side of now, once, and nothing else is", async () => {
	const now = 1_800_000_000_000;
	const at = stepAt(now);
	const code = await totpCode(RFC, at);
	assert.equal(await checkTotp(RFC, code, 0, now), at);
	assert.equal(await checkTotp(RFC, ` ${code.slice(0, 3)} ${code.slice(3)} `, 0, now), at, "spaces are fine");
	assert.equal(await checkTotp(RFC, await totpCode(RFC, at - 1), 0, now), at - 1, "the previous step, for a slow clock");
	assert.equal(await checkTotp(RFC, await totpCode(RFC, at + 1), 0, now), at + 1, "the next step, for a fast one");
	assert.equal(await checkTotp(RFC, await totpCode(RFC, at - 2), 0, now), null, "two steps out is too far");
	assert.equal(await checkTotp(RFC, code, at, now), null, "a step already used");
	for (const bad of ["", "12345", "1234567", "abcdef", null, 123456]) assert.equal(await checkTotp(RFC, bad, 0, now), null, String(bad));
});

test("spending a step works once, so two requests with one code can't both sign in", async () => {
	const db = testD1();
	assert.equal(await spendStep(db, "user", 100), true);
	assert.equal(await spendStep(db, "user", 100), false);
	assert.equal(await spendStep(db, "user", 99), false, "nor an older one");
	assert.equal(await spendStep(db, "user", 101), true);
});

test("the otpauth URI names the issuer and account the way authenticator apps read them", () => {
	assert.equal(otpauthUri("ABC", "me@mailopus.net", "app.mailopus.net"),
		"otpauth://totp/app.mailopus.net%3Ame%40mailopus.net?secret=ABC&issuer=app.mailopus.net&algorithm=SHA1&digits=6&period=30");
});
