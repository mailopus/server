// Run: pnpm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { inviteStatements } from "../server/lib/invite.ts";
import { ME, testD1 } from "./d1.ts";

const run = (db: ReturnType<typeof testD1>, statements: { sql: string; params: (string | number)[] }[]) => {
	for (const st of statements) db.raw.prepare(st.sql).run(...(st.params as never[]));
};
const routeOf = (db: ReturnType<typeof testD1>, a: string) => (db.raw.prepare("SELECT account_id FROM addresses WHERE address = ?").get(a) as { account_id: string } | undefined)?.account_id;

test("inviting someone new creates them with their exact route and the invite, in one batch", () => {
	const db = testD1();
	const inv = inviteStatements({ name: "Ann", email: "Ann@mailopus.net", tokenHash: "h1", expiresAt: 1 });
	run(db, inv.statements);
	const acct = (db.raw.prepare("SELECT id FROM accounts WHERE user_id = ?").get(inv.userId) as { id: string }).id;
	assert.equal(routeOf(db, "ann@mailopus.net"), acct);
	assert.equal((db.raw.prepare("SELECT user_id FROM invites WHERE token_hash = 'h1'").get() as { user_id: string }).user_id, inv.userId);
	assert.equal((db.raw.prepare("SELECT is_admin FROM users WHERE id = ?").get(inv.userId) as { is_admin: number }).is_admin, 0);
});

test("inviting an existing user routes their address if nothing does, and never takes another account's", () => {
	const db = testD1();
	assert.equal(routeOf(db, ME), undefined, "the test user has only the catch-all");
	run(db, inviteStatements({ userId: "user", email: ME, tokenHash: "h2", expiresAt: 1 }).statements);
	assert.equal(routeOf(db, ME), "acct");
	run(db, inviteStatements({ userId: "user", email: ME, tokenHash: "h3", expiresAt: 1 }).statements);
	assert.equal(db.raw.prepare("SELECT count(*) AS n FROM invites").get()!.n, 2, "a second invite is fine");

	// Someone else's: the invite leaves it alone.
	const bob = inviteStatements({ name: "Bob", email: "bob@mailopus.net", tokenHash: "h4", expiresAt: 1 });
	run(db, bob.statements);
	const bobAcct = routeOf(db, "bob@mailopus.net")!;
	db.raw.exec(`UPDATE addresses SET account_id = '${bobAcct}' WHERE address = 'me@mailopus.net'`);
	run(db, inviteStatements({ userId: "user", email: ME, tokenHash: "h5", expiresAt: 1 }).statements);
	assert.equal(routeOf(db, ME), bobAcct);
});
