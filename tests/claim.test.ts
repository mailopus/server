// Run: pnpm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkClaimCode, claim, claimant, isClaimable } from "../server/lib/claim.ts";
import { testD1 } from "./d1.ts";

const pk = (id: string) => ({ id, publicKey: "pub", counter: 0, transports: ["internal"] });

test("claimant trims and lowercases, and refuses what can't be an owner", () => {
	assert.deepEqual(claimant(" Ann ", "Ann@Example.COM "), { name: "Ann", email: "ann@example.com" });
	for (const [n, e] of [["", "a@b.co"], ["Ann", "nope"], ["Ann", "a@b"], ["x".repeat(81), "a@b.co"], [1, "a@b.co"], ["Ann", "<a@b.co>"]]) {
		assert.equal(claimant(n, e), null, `${n} ${e}`);
	}
});

test("the first claim provisions the owner and their passkey; after that claiming is closed", async () => {
	const db = testD1({ empty: true });
	assert.equal(await isClaimable(db), true);
	const p = await claim(db, "owner", { name: "Ann", email: "ann@example.com" }, pk("cred1"));
	assert.equal(await isClaimable(db), false);
	const row = (sql: string) => db.raw.prepare(sql).get() as Record<string, unknown>;
	assert.equal(row("SELECT name FROM users WHERE id = 'owner'").name, "Ann");
	assert.equal(row("SELECT user_id FROM passkeys WHERE id = 'cred1'").user_id, "owner");
	assert.equal(row(`SELECT email FROM identities WHERE account_id = '${p.accountId}'`).email, "ann@example.com");
	assert.equal(row(`SELECT count(*) AS n FROM mailboxes WHERE account_id = '${p.accountId}'`).n, 7);
	// Only the claimer's own address routes; the rest of the domain bounces until the admin says otherwise.
	assert.deepEqual(db.raw.prepare("SELECT address, account_id FROM addresses").all().map((r) => ({ ...r })), [{ address: "ann@example.com", account_id: p.accountId }]);
	assert.equal(row("SELECT is_admin FROM users WHERE id = 'owner'").is_admin, 1);
	// A claim racing the first one fails on the 'claimed' row; in D1 that rolls the batch back.
	await assert.rejects(claim(db, "second", { name: "Eve", email: "eve@example.com" }, pk("cred2")));
});

test("an instance that already has users is not claimable", async () => {
	assert.equal(await isClaimable(testD1()), false);
});

test("claiming needs the instance's claim code, and refuses everyone when none is set", async () => {
	assert.equal(await checkClaimCode(undefined, "anything"), "unset");
	assert.equal(await checkClaimCode("", "anything"), "unset");
	assert.equal(await checkClaimCode("3f9a0c", "3f9a0c"), "ok");
	assert.equal(await checkClaimCode("3f9a0c", " 3f9a0c\n"), "ok", "pasted whitespace is fine");
	for (const given of ["3f9a0d", "3f9a0", "", undefined, null, 42, ["3f9a0c"]]) {
		assert.equal(await checkClaimCode("3f9a0c", given), "wrong", String(given));
	}
});
