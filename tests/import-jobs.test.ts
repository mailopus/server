// Run: pnpm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { ImportError, controlImport, importOverview, requireAdmin, startImport, workspaces } from "../server/lib/import-jobs.ts";
import { inviteStatements } from "../server/lib/invite.ts";
import { testD1 } from "./d1.ts";

// Shaped like the secret, built here so no file holds anything that looks like a key.
const KEY = JSON.stringify({ client_email: "sa@p.iam.gserviceaccount.com", private_key: "SECRET-KEY-MATERIAL" });
const ENV = { GOOGLE_SA_WORK: KEY, GOOGLE_SA_ACME2: KEY, GOOGLE_SA_EMPTY: "", GOOGLE_SA_lower: KEY, GOOGLE_SA_: KEY, OTHER_GOOGLE_SA_X: KEY, DB: {} };
const JOB = { workspace: "work", sourceEmail: "sam@company.example", accountId: "acct" };
const refused = (status: number, text?: RegExp) => (e: unknown) => e instanceof ImportError && e.status === status && (!text || text.test(e.message));

type Db = ReturnType<typeof testD1>;
const row = (db: Db, id: string) => db.raw.prepare("SELECT * FROM import_jobs WHERE id = ?").get(id) as Record<string, unknown>;
const set = (db: Db, id: string, sql: string) => db.raw.prepare(`UPDATE import_jobs SET ${sql} WHERE id = ?`).run(id);

test("workspaces: the names of the set GOOGLE_SA_ secrets, lowercased, and nothing of the keys", async () => {
	assert.deepEqual(workspaces(ENV), ["acme2", "work"]);
	assert.deepEqual(workspaces({ DB: {} }), []);
	const db = testD1();
	await startImport(db, ENV, JOB);
	const all = JSON.stringify(await importOverview(db, ENV));
	assert.ok(!all.includes("SECRET-KEY-MATERIAL") && !all.includes("gserviceaccount"));
});

test("only the admin passes", async () => {
	const db = testD1();
	const bob = inviteStatements({ name: "Bob", email: "bob@mailopus.net", tokenHash: "inv", expiresAt: 1 });
	for (const st of bob.statements) db.raw.prepare(st.sql).run(...(st.params as never[]));
	await requireAdmin(db, "user");
	await assert.rejects(requireAdmin(db, bob.userId), refused(403, /Only the admin/));
	await assert.rejects(requireAdmin(db, "nobody"), refused(403));
});

test("startImport validates the workspace, the address and the account", async () => {
	const db = testD1();
	for (const workspace of ["nokey", "empty", "lower", "wo rk", "work'--", "", 7]) await assert.rejects(startImport(db, ENV, { ...JOB, workspace }), refused(400, /service account key/), String(workspace));
	for (const sourceEmail of ["sam", "sam@", "@company.example", "a b@company.example", null]) await assert.rejects(startImport(db, ENV, { ...JOB, sourceEmail }), refused(400, /email address/), String(sourceEmail));
	for (const accountId of ["nobody", "", null]) await assert.rejects(startImport(db, ENV, { ...JOB, accountId }), refused(400, /No such account/), String(accountId));
	await assert.rejects(startImport(db, ENV, null), refused(400));
	assert.equal((db.raw.prepare("SELECT count(*) AS n FROM import_jobs").get() as { n: number }).n, 0);
});

test("startImport inserts the row the script does, and the overview lists it", async () => {
	const db = testD1();
	const id = await startImport(db, ENV, { workspace: "WORK", sourceEmail: " Sam@Company.Example ", accountId: "acct" }, 1000);
	const { page_token, labels_json, messages_total, last_error, ...r } = row(db, id);
	assert.deepEqual([page_token, labels_json, messages_total, last_error], [null, null, null, null]);
	assert.deepEqual({ ...r }, { id, account_id: "acct", workspace: "work", source_email: "sam@company.example", status: "pending", pages: 0, imported: 0, merged: 0, skipped: 0, failed: 0, created_at: 1000, updated_at: 1000 });
	const { jobs } = await importOverview(db, ENV);
	assert.deepEqual(jobs, [{
		id, sourceEmail: "sam@company.example", account: { id: "acct", name: jobs[0]!.account.name }, status: "pending", pages: 0,
		imported: 0, merged: 0, skipped: 0, failed: 0, messagesTotal: null, lastError: null, createdAt: 1000, updatedAt: 1000,
	}]);
	assert.ok(jobs[0]!.account.name);
});

test("a second active job for the same mailbox and account is refused", async () => {
	const db = testD1();
	const id = await startImport(db, ENV, JOB);
	for (const status of ["pending", "running", "paused"]) {
		set(db, id, `status = '${status}'`);
		await assert.rejects(startImport(db, ENV, { ...JOB, sourceEmail: "SAM@company.example" }), refused(409, /already under way/), status);
	}
	// Another mailbox into the same account is a different job.
	await startImport(db, ENV, { ...JOB, sourceEmail: "pat@company.example" });
	set(db, id, "status = 'done'");
	await startImport(db, ENV, JOB);
	assert.equal((await importOverview(db, ENV)).jobs.length, 3);
});

test("pause, resume and rescan do what the script's SQL does", async () => {
	const db = testD1();
	const id = await startImport(db, ENV, JOB, 1000);
	const other = await startImport(db, ENV, { ...JOB, sourceEmail: "pat@company.example" }, 1000);
	set(db, id, "status = 'running', page_token = 'p7', failed = 3, imported = 40, last_error = 'x'");

	await controlImport(db, id, "pause", 2000);
	assert.deepEqual([row(db, id).status, row(db, id).updated_at, row(db, id).page_token], ["paused", 2000, "p7"]);
	await controlImport(db, id, "resume", 3000);
	assert.deepEqual([row(db, id).status, row(db, id).updated_at, row(db, id).page_token, row(db, id).failed], ["pending", 3000, "p7", 3]);

	// A job on its way can't be rescanned. A finished one can't be paused or resumed, only rescanned.
	await assert.rejects(controlImport(db, id, "rescan"), refused(409));
	set(db, id, "status = 'done'");
	await assert.rejects(controlImport(db, id, "pause"), refused(409));
	await assert.rejects(controlImport(db, id, "resume"), refused(409));
	await controlImport(db, id, "rescan", 4000);
	const r = row(db, id);
	assert.deepEqual([r.status, r.page_token, r.failed, r.last_error, r.imported, r.updated_at], ["pending", null, 0, null, 40, 4000]);

	// Exact ids only: a prefix or a pattern moves nothing, and neither did any of the above touch the other job.
	for (const bad of [id.slice(0, 8), "%", "", null]) await assert.rejects(controlImport(db, bad, "pause"), refused(409), String(bad));
	for (const bad of ["delete", "toString", "", null]) await assert.rejects(controlImport(db, id, bad), refused(400), String(bad));
	assert.deepEqual([row(db, other).status, row(db, other).updated_at], ["pending", 1000]);
});

test("the last error is its first line, never the stack", async () => {
	const db = testD1();
	const id = await startImport(db, ENV, JOB);
	set(db, id, `last_error = 'GmailError: 403 Delegation denied for sam@company.example\n    at listPage (index.mjs:1:2)\n    at runPage (index.mjs:3:4)'`);
	assert.equal((await importOverview(db, ENV)).jobs[0]!.lastError, "GmailError: 403 Delegation denied for sam@company.example");
	set(db, id, `last_error = '${"x".repeat(900)}'`);
	assert.equal((await importOverview(db, ENV)).jobs[0]!.lastError!.length, 200);
});
