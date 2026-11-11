// Run: pnpm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { AddressError, addAddress, listAddresses, removeAddress, setCatchAll, updateAddress } from "../server/lib/addresses.ts";
import { routeCandidates } from "../server/lib/ingest.ts";
import { ME, testD1 } from "./d1.ts";

test("add, rename, stop receiving, and remove addresses, with the guards", async () => {
	const db = testD1();
	const first = await listAddresses(db, "acct");
	assert.deepEqual(first.domains, ["mailopus.net"]);
	assert.deepEqual(first.catchAll, ["mailopus.net"]);
	assert.equal(first.addresses.find((a) => a.email === ME)?.receives, true, "the catch-all covers it");

	await assert.rejects(addAddress(db, "acct", { email: "x@other.com", name: "Me" }), /isn't set up for Mailopus/);
	await assert.rejects(addAddress(db, "acct", { email: ME, name: "Me" }), /already yours/);
	await assert.rejects(addAddress(db, "acct", { email: "new@mailopus.net", name: " " }), AddressError);
	await addAddress(db, "acct", { email: "New@Mailopus.net", name: "Me Too" });
	let a = (await listAddresses(db, "acct")).addresses.find((x) => x.email === "new@mailopus.net")!;
	assert.deepEqual([a.name, a.routed, a.receives, !!a.identityId], ["Me Too", true, true, true]);

	await updateAddress(db, "acct", { email: "new@mailopus.net", name: "Renamed", receive: false });
	a = (await listAddresses(db, "acct")).addresses.find((x) => x.email === "new@mailopus.net")!;
	assert.deepEqual([a.name, a.routed, a.receives], ["Renamed", false, true], "the catch-all still delivers it");

	db.raw.exec("INSERT INTO scheduled_submissions (id, account_id, email_id, identity_id, rcpts_json, send_at, created_at) SELECT 's', 'acct', 'e', id, '[]', 1, 1 FROM identities WHERE email = 'new@mailopus.net'");
	await assert.rejects(removeAddress(db, "acct", "new@mailopus.net"), /scheduled/);
	db.raw.exec("DELETE FROM scheduled_submissions");
	await removeAddress(db, "acct", "new@mailopus.net");
	assert.equal((await listAddresses(db, "acct")).addresses.some((x) => x.email === "new@mailopus.net"), false);
	await assert.rejects(removeAddress(db, "acct", ME), /last address you send as/);
});

/** A second person on the same domain, not the admin. */
async function addBob(db: ReturnType<typeof testD1>) {
	const { provision } = await import("../server/lib/provision.ts");
	const p = provision({ name: "Bob", email: "bob@mailopus.net" });
	for (const st of p.statements) db.raw.prepare(st.sql).run(...(st.params as never[]));
	return p.accountId;
}

test("only the admin adds or removes addresses or sets a catch-all; everyone can rename theirs", async () => {
	const db = testD1();
	const bob = await addBob(db);
	const listed = await listAddresses(db, bob);
	assert.equal(listed.admin, false);
	assert.equal("accounts" in listed, false, "a non-admin doesn't see other accounts");
	await assert.rejects(addAddress(db, bob, { email: "bob2@mailopus.net", name: "Bob" }), (e: AddressError) => e.status === 403);
	await assert.rejects(removeAddress(db, bob, "bob@mailopus.net"), /Only the admin/);
	await assert.rejects(setCatchAll(db, bob, { domain: "mailopus.net", to: bob }), /Only the admin/);
	await updateAddress(db, bob, { email: "bob@mailopus.net", name: "Robert" });
	assert.equal((await listAddresses(db, bob)).addresses[0]!.name, "Robert");
	// The admin can.
	await addAddress(db, "acct", { email: "sales@mailopus.net", name: "Sales" });
	await removeAddress(db, "acct", "sales@mailopus.net");
});

test("the catch-all is per domain: off bounces unknown addresses, on sends them to the chosen account", async () => {
	const db = testD1();
	const bob = await addBob(db);
	const route = (to: string) => {
		const [exact, base, any] = routeCandidates(to);
		return (db.raw.prepare("SELECT account_id FROM addresses WHERE address IN (?, ?, ?) ORDER BY CASE address WHEN ? THEN 0 WHEN ? THEN 1 ELSE 2 END LIMIT 1")
			.get(exact, base, any, exact, base) as { account_id: string } | undefined)?.account_id ?? null;
	};
	const admin = await listAddresses(db, "acct");
	assert.equal(admin.admin, true);
	assert.deepEqual(admin.catchAllTo, { "mailopus.net": "acct" });
	assert.equal(admin.accounts?.length, 2);

	await setCatchAll(db, "acct", { domain: "mailopus.net", to: null });
	assert.equal(route("nobody@mailopus.net"), null, "unknown addresses bounce");
	assert.equal(route("bob@mailopus.net"), bob);
	assert.equal(route("bob+news@mailopus.net"), bob, "+ aliases still work");
	assert.equal(route(ME), "acct", "the admin's own address, routed only by the old catch-all, keeps receiving");
	assert.deepEqual((await listAddresses(db, "acct")).catchAllTo, {});

	await setCatchAll(db, "acct", { domain: "mailopus.net", to: bob });
	assert.equal(route("nobody@mailopus.net"), bob);
	assert.deepEqual((await listAddresses(db, bob)).catchAll, ["mailopus.net"]);
	assert.deepEqual((await listAddresses(db, "acct")).catchAll, []);
	await assert.rejects(setCatchAll(db, "acct", { domain: "other.com", to: bob }), /isn't set up/);
	await assert.rejects(setCatchAll(db, "acct", { domain: "mailopus.net", to: "nope" }), /No such account/);
});

test("migration 0031 makes the earliest user of an existing instance the admin", async () => {
	const { DatabaseSync } = await import("node:sqlite");
	const { readFileSync, readdirSync } = await import("node:fs");
	const raw = new DatabaseSync(":memory:");
	const files = readdirSync("migrations").sort();
	for (const f of files.filter((f) => f < "0031")) raw.exec(readFileSync(`migrations/${f}`, "utf8"));
	raw.exec("INSERT INTO users (id, name) VALUES ('zzz', 'First'), ('aaa', 'Second')");
	raw.exec(readFileSync("migrations/0031_admin.sql", "utf8"));
	assert.deepEqual(raw.prepare("SELECT id FROM users WHERE is_admin = 1").all().map((r) => r.id), ["zzz"]);
});
