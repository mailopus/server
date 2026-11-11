// Run: pnpm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { provision, toSql } from "../server/lib/provision.ts";

test("provisioned ids are random hex and never derived from the name or email", () => {
	const a = provision({ name: "Sam", email: "sam@mailopus.net" });
	const b = provision({ name: "Sam", email: "sam@mailopus.net" });
	const ids = [a.userId, a.accountId, a.identityId, ...Object.values(a.mailboxes)];
	assert.ok(ids.every((id) => /^[0-9a-f]{32}$/.test(id)), ids.join(" "));
	assert.equal(new Set(ids).size, ids.length);
	assert.notEqual(a.accountId, b.accountId);
});

test("toSql escapes quotes in operator input", () => {
	const sql = toSql([{ sql: "INSERT INTO users (id, name) VALUES (?, ?)", params: ["x", "O'Brien'); DROP TABLE users;--"] }]);
	assert.equal(sql, "INSERT INTO users (id, name) VALUES ('x', 'O''Brien''); DROP TABLE users;--');");
});
