// Run: pnpm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { userAccounts } from "../server/lib/auth.ts";
import { testD1 } from "./d1.ts";

test("a user's accounts are read from D1 once, then cached; an empty answer isn't cached", async () => {
	const db = testD1();
	let reads = 0;
	const counting = { prepare: (sql: string) => (reads++, db.prepare(sql)) } as unknown as D1Database;
	assert.deepEqual((await userAccounts(counting, "user")).map((a) => a.id), ["acct"]);
	await userAccounts(counting, "user");
	assert.equal(reads, 1);
	await userAccounts(counting, "nobody");
	await userAccounts(counting, "nobody");
	assert.equal(reads, 3);
});
