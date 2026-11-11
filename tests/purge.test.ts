// Run: pnpm test
// Tombstone purge (server/lib/purge.ts), the new-network alert for app passwords, and the ingest replay guard.
import assert from "node:assert/strict";
import { test } from "node:test";
import { lookupAppPassword, newAppPassword, sha256 } from "../server/lib/auth.ts";
import { dispatch } from "../server/lib/jmap/core.ts";
import { type Ctx, mailMethods } from "../server/lib/jmap/mail.ts";
import { UPLOAD_DAYS, purgeAccount, purgeDays, purgeTombstones, sweepUploads } from "../server/lib/purge.ts";
import { ME, testD1 } from "./d1.ts";

const DAY = 86_400_000;

function seeded() {
	const db = testD1();
	// modseq 1..6. e2 and e4 were destroyed long ago (e2 before destroyed_at existed), e6 yesterday.
	const add = (id: string, modseq: number, destroyed: number | null, at: number | null) =>
		db.raw.prepare(`INSERT INTO emails (id, account_id, thread_id, blob_key, subject, from_json, received_at, size, keywords_json, created_modseq, updated_modseq, destroyed_modseq, destroyed_at)
			VALUES (?, 'acct', ?, 'k', 's', '[]', 1, 1, '{}', 0, ?, ?, ?)`).run(id, id, modseq, destroyed, at);
	const now = 100 * DAY;
	add("e1", 1, null, null);
	add("e2", 2, 2, null);
	add("e3", 3, null, null);
	add("e4", 4, 4, now - 40 * DAY);
	add("e5", 5, null, null);
	add("e6", 6, 6, now - DAY);
	add("e7", 7, null, null);
	db.raw.exec("UPDATE accounts SET modseq = 7");
	const ids = () => (db.raw.prepare("SELECT id FROM emails ORDER BY updated_modseq").all() as { id: string }[]).map((r) => r.id).join(" ");
	const acct = () => db.raw.prepare("SELECT purge_cursor AS cursor, purged_modseq AS floor FROM accounts WHERE id = 'acct'").get() as { cursor: number; floor: number };
	return { db, now, ids, acct };
}

test("purgeDays: off unless the setting is a number", () => {
	for (const off of [{}, { PURGE_TOMBSTONES_DAYS: "" }, { PURGE_TOMBSTONES_DAYS: "soon" }, { PURGE_TOMBSTONES_DAYS: "-1" }]) assert.equal(purgeDays(off), null);
	assert.equal(purgeDays({ PURGE_TOMBSTONES_DAYS: "30" }), 30);
	assert.equal(purgeDays({ PURGE_TOMBSTONES_DAYS: 0 }), 0);
});

test("with no setting the cron purges nothing", async () => {
	const { db, ids } = seeded();
	assert.equal(await purgeTombstones({ DB: db }), 0);
	assert.equal(ids(), "e1 e2 e3 e4 e5 e6 e7");
});

test("a purge removes old tombstones only, in slices, stops at a young one, and never touches live mail", async () => {
	const { db, now, ids, acct } = seeded();
	// Two rows a run: e1 is live, e2 is an old tombstone.
	assert.equal(await purgeAccount(db, "acct", 0, 30, now, 2), 1);
	assert.equal(ids(), "e1 e3 e4 e5 e6 e7");
	assert.deepEqual({ ...acct() }, { cursor: 2, floor: 2 });
	assert.equal(await purgeAccount(db, "acct", acct().cursor, 30, now, 2), 1);
	assert.deepEqual({ ...acct() }, { cursor: 4, floor: 4 });
	// e5 is live, e6 was destroyed yesterday: the walk stops in front of it and comes back another day.
	assert.equal(await purgeAccount(db, "acct", acct().cursor, 30, now, 10), 0);
	assert.equal(ids(), "e1 e3 e5 e6 e7");
	assert.deepEqual({ ...acct() }, { cursor: 5, floor: 4 });
	assert.equal(await purgeAccount(db, "acct", acct().cursor, 30, now, 10), 0, "nothing new: no write, same cursor");
	// A month on, e6 is old enough.
	assert.equal(await purgeAccount(db, "acct", acct().cursor, 30, now + 31 * DAY, 10), 1);
	assert.equal(ids(), "e1 e3 e5 e7");
	assert.deepEqual({ ...acct() }, { cursor: 7, floor: 6 });
});

test("Email/changes refuses a state from before a purged tombstone, and answers one after it", async () => {
	const { db, now } = seeded();
	const ctx: Ctx = { db, mail: {} as R2Bucket, accounts: new Set(["acct"]), writer: () => { throw new Error("read-only"); }, createdIds: {} };
	const changes = (sinceState: string) => dispatch({ using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"], methodCalls: [["Email/changes", { accountId: "acct", sinceState }, "c"]] }, mailMethods, ctx).then((r) => r.methodResponses[0]!);
	assert.deepEqual((await changes("1"))[1].destroyed, ["e2", "e4", "e6"], "before any purge every destroy is reported");
	await purgeAccount(db, "acct", 0, 30, now);
	for (const old of ["0", "1", "3"]) assert.deepEqual(await changes(old), ["error", { type: "cannotCalculateChanges" }, "c"], old);
	assert.deepEqual((await changes("4"))[1].destroyed, ["e6"], "from the floor on, nothing is missing");
});

test("an app password on a network it hasn't used before is flagged once, not the first time and not twice a day", async () => {
	const db = testD1();
	const pass = newAppPassword();
	db.raw.prepare("INSERT INTO app_passwords (id, user_id, name, token_hash, created_at) VALUES ('p1', 'user', 'Phone', ?, 1)").run(await sha256(pass));
	// Each call uses a different username so the per-isolate cache doesn't answer for D1.
	let n = 0;
	const use = (ip: string) => lookupAppPassword(db, { user: `u${n++}@mailopus.net`, pass }, ip);
	assert.equal((await use("203.0.113.5"))?.newNetwork, undefined, "the first network is where it was set up");
	assert.equal((await use("203.0.113.99"))?.newNetwork, undefined, "same /24");
	assert.deepEqual((await use("198.51.100.7"))?.newNetwork, { name: "Phone", network: "198.51.100.0/24" });
	assert.equal((await use("198.51.100.8"))?.newNetwork, undefined, "known now");
	assert.equal((await use("192.0.2.1"))?.newNetwork, undefined, "a third network the same day is remembered but not announced");
	db.raw.exec("UPDATE app_passwords SET alerted_at = alerted_at - 2 * 86400000");
	assert.equal((await use("192.0.2.2"))?.newNetwork, undefined, "and it was remembered");
	assert.equal((await use("2001:db8:5::1"))?.newNetwork?.network, "2001:db8:5::/48");
	assert.equal(ME.includes("@"), true);
});

test("uploads older than a week are swept; newer ones and stored mail are left", async () => {
	const now = 100 * DAY;
	const deleted: string[] = [];
	const mail = {
		list: async (o: { prefix: string }) => {
			assert.equal(o.prefix, "upload/", "only the upload prefix is ever listed");
			return { objects: [{ key: "upload/acct/uold", uploaded: new Date(now - (UPLOAD_DAYS + 1) * DAY) }, { key: "upload/acct/unew", uploaded: new Date(now - DAY) }] };
		},
		delete: async (keys: string[]) => void deleted.push(...keys),
	} as unknown as R2Bucket;
	assert.equal(await sweepUploads(mail, now), 1);
	assert.deepEqual(deleted, ["upload/acct/uold"]);
});
