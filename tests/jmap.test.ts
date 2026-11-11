// Run: pnpm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { MethodError, dispatch, evalPointer } from "../server/lib/jmap/core.ts";
import { type Ctx, FTS_CAP, FTS_FEW, compileFilter, ftsQuery, mailMethods } from "../server/lib/jmap/mail.ts";
import { testD1 } from "./d1.ts";
import { RECOUNT_SQL } from "../server/lib/recount.ts";

const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];

function seeded() {
	const db = testD1();
	const add = (id: string, thread: string, at: number, subject: string, body: string, opts: { box?: string; seen?: boolean; from?: string } = {}) => {
		db.raw.prepare(`INSERT INTO emails (id, account_id, thread_id, blob_key, subject, from_json, received_at, size, keywords_json, created_modseq, updated_modseq)
			VALUES (?, 'acct', ?, 'k', ?, ?, ?, 100, ?, ?, ?)`).run(id, thread, subject,
			JSON.stringify([{ name: "", email: opts.from ?? "ann@x.com" }]), at, JSON.stringify(opts.seen ? { $seen: true } : {}), at, at);
		db.raw.prepare("INSERT INTO email_mailboxes (email_id, mailbox_id, uid, received_at) VALUES (?, ?, ?, ?)").run(id, opts.box ?? "box-inbox", at, at);
		db.raw.prepare("INSERT INTO emails_fts (email_id, subject, addresses, body) VALUES (?, ?, '', ?)").run(id, subject, body);
	};
	add("e1", "t1", 1, "Lunch plans", "tacos on friday");
	add("e2", "t1", 2, "Re: Lunch plans", "make it saturday", { seen: true });
	add("e3", "t2", 3, "Invoice", "please pay", { from: "billing@corp.com" });
	add("e4", "t3", 4, "Spammy", "buy now", { box: "box-junk" });
	db.raw.exec("UPDATE accounts SET modseq = 4");
	db.raw.prepare(RECOUNT_SQL).run("acct");
	const ctx: Ctx = { db, mail: {} as R2Bucket, accounts: new Set(["acct"]), writer: () => { throw new Error("read-only test"); }, createdIds: {} };
	return ctx;
}

const call = (ctx: Ctx, ...calls: [string, Record<string, unknown>, string][]) =>
	dispatch({ using: USING, methodCalls: calls }, mailMethods, ctx).then((r) => r.methodResponses);

test("evalPointer handles * by flattening", () => {
	assert.deepEqual(evalPointer({ list: [{ ids: ["a", "b"] }, { ids: ["c"] }] }, "/list/*/ids"), ["a", "b", "c"]);
	assert.throws(() => evalPointer({}, "/nope"), MethodError);
});

test("ftsQuery quotes tokens so FTS operators in input are inert", () => {
	assert.equal(ftsQuery('a" OR b*'), '"a""" "OR" "b*"');
	assert.equal(ftsQuery("x y", "subject"), 'subject : ("x" "y")');
	assert.equal(ftsQuery("   "), null);
});

test("compileFilter rejects unknown props and bad keywords", () => {
	assert.throws(() => compileFilter({ header: ["x"] }), { type: "unsupportedFilter" });
	assert.throws(() => compileFilter({ hasKeyword: 'x"y' }), MethodError);
});

test("query newest-first, then get via result reference, with mailbox and keywords", async () => {
	const ctx = seeded();
	const [q, g] = await call(ctx,
		["Email/query", { accountId: "acct", filter: { inMailbox: "box-inbox" }, calculateTotal: true }, "q"],
		["Email/get", { accountId: "acct", "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties: ["subject", "mailboxIds", "keywords"] }, "g"],
	);
	assert.deepEqual(q![1].ids, ["e3", "e2", "e1"]);
	assert.equal(q![1].total, 3);
	assert.equal(q![1].queryState, "4");
	assert.deepEqual((g![1].list as any[]).map((e) => e.id), ["e3", "e2", "e1"], "Email/get keeps request order");
	const e2 = (g![1].list as any[]).find((e) => e.id === "e2");
	assert.deepEqual(e2, { id: "e2", subject: "Re: Lunch plans", mailboxIds: { "box-inbox": true }, keywords: { $seen: true } });
});

test("collapseThreads keeps the newest email per thread", async () => {
	const [q] = await call(seeded(), ["Email/query", { accountId: "acct", filter: { inMailbox: "box-inbox" }, collapseThreads: true }, "q"]);
	assert.deepEqual(q![1].ids, ["e3", "e2"]);
});

test("a common word in a mailbox is found by walking the mailbox, with the same answer as the general query", async () => {
	const ctx = seeded();
	const db = (ctx.db as unknown as { raw: import("node:sqlite").DatabaseSync }).raw;
	const n = FTS_FEW * 2;
	db.exec("BEGIN");
	// Indexed newest first, as a Gmail import does, so search rowids run against arrival.
	for (let i = n; i > 0; i--) {
		const at = 1000 + i, id = `c${i}`;
		db.prepare(`INSERT INTO emails (id, account_id, thread_id, blob_key, subject, from_json, received_at, size, keywords_json, created_modseq, updated_modseq)
			VALUES (?, 'acct', ?, 'k', ?, '[]', ?, 100, '{}', ?, ?)`).run(id, `ct${Math.floor(i / 3)}`, i % 7 ? "Note" : "Common subject", at, at, at);
		db.prepare("INSERT INTO email_mailboxes (email_id, mailbox_id, uid, received_at) VALUES (?, ?, ?, ?)").run(id, i % 5 ? "box-inbox" : "box-junk", at, at);
		db.prepare("INSERT INTO emails_fts (email_id, subject, addresses, body) VALUES (?, ?, '', ?)").run(id, i % 7 ? "Note" : "Common subject", i % 4 ? "a common word" : "nothing here");
	}
	db.exec("COMMIT");
	let walked = 0;
	const prepare = ctx.db.prepare.bind(ctx.db);
	ctx.db.prepare = ((sql: string) => (/CROSS JOIN emails_fts_content c ON c\.c0 = em\.email_id/.test(sql) && walked++, prepare(sql))) as typeof ctx.db.prepare;
	const ids = async (args: Record<string, unknown>) => (await call(ctx, ["Email/query", { accountId: "acct", ...args }, "q"]))[0]![1].ids as string[];
	for (const filter of [{ inMailbox: "box-inbox", text: "common" }, { inMailbox: "box-junk", text: "common" }, { inMailbox: "box-inbox", text: "common", subject: "common" }])
		for (const page of [{ collapseThreads: true, limit: 50 }, { collapseThreads: true, limit: 50, position: 50 }, { limit: 30 }]) {
			const before = walked;
			const fast = await ids({ filter, ...page });
			// "common" has few matches in subjects, so the search with both starts from the matches instead.
			assert.equal(walked, before + ("subject" in filter ? 0 : 1), JSON.stringify(filter));
			// calculateTotal sends the same search down the general query.
			assert.deepEqual(fast, await ids({ filter, ...page, calculateTotal: true }), JSON.stringify({ filter, page }));
			assert.ok(fast.length > 0);
		}
	const before = walked;
	assert.deepEqual(await ids({ filter: { inMailbox: "box-inbox", text: "saturday" } }), ["e2"]);
	assert.equal(walked, before, "a rare word starts from its matches");
});

test("a rare word in a mailbox starts from its matches, with the same answer as the general query", async () => {
	const ctx = seeded();
	const db = (ctx.db as unknown as { raw: import("node:sqlite").DatabaseSync }).raw;
	db.exec("BEGIN");
	for (let i = 400; i > 0; i--) {
		const at = 1000 + i, id = `r${i}`;
		db.prepare(`INSERT INTO emails (id, account_id, thread_id, blob_key, subject, from_json, received_at, size, keywords_json, created_modseq, updated_modseq, destroyed_modseq)
			VALUES (?, 'acct', ?, 'k', 'Note', '[]', ?, 100, '{}', ?, ?, ?)`).run(id, `rt${Math.floor(i / 4)}`, at, at, at, i % 50 === 0 ? at : null);
		// A destroyed email has no placement or search row, as after Email/set destroy.
		if (i % 50 === 0) continue;
		db.prepare("INSERT INTO email_mailboxes (email_id, mailbox_id, uid, received_at) VALUES (?, ?, ?, ?)").run(id, i % 5 ? "box-inbox" : "box-junk", at, at);
		db.prepare("INSERT INTO emails_fts (email_id, subject, addresses, body) VALUES (?, 'Note', '', ?)").run(id, i % 3 ? "an unusual word" : "nothing here");
	}
	db.exec("COMMIT");
	let direct = 0;
	const prepare = ctx.db.prepare.bind(ctx.db);
	ctx.db.prepare = ((sql: string) => (/INDEXED BY emails_fts_content_id/.test(sql) && direct++, prepare(sql))) as typeof ctx.db.prepare;
	const ids = async (args: Record<string, unknown>) => (await call(ctx, ["Email/query", { accountId: "acct", ...args }, "q"]))[0]![1].ids as string[];
	for (const box of ["box-inbox", "box-junk"])
		for (const page of [{ collapseThreads: true, limit: 20 }, { collapseThreads: true, limit: 20, position: 40 }, { collapseThreads: true, limit: 256 }, { limit: 30 }, { limit: 30, position: 200 }]) {
			const before = direct;
			const fast = await ids({ filter: { inMailbox: box, text: "unusual" }, ...page });
			assert.ok(direct > before, "took the direct path");
			// calculateTotal sends the same search down the general query.
			assert.deepEqual(fast, await ids({ filter: { inMailbox: box, text: "unusual" }, ...page, calculateTotal: true }), JSON.stringify({ box, page }));
		}
	assert.deepEqual(await ids({ filter: { inMailbox: "box-inbox", text: "nosuchword" } }), []);
});

test("a text search reads a bounded number of matches, the most recently indexed first", () => {
	for (const f of [{ text: "the" }, { subject: "the" }, { body: "the" }])
		assert.ok(compileFilter(f).sql.includes(`MATCH ? ORDER BY rowid DESC LIMIT ${FTS_CAP}`), JSON.stringify(f));
});

test("text search, from, keywords and NOT filters", async () => {
	const ctx = seeded();
	const ids = async (filter: unknown) => (await call(ctx, ["Email/query", { accountId: "acct", filter }, "q"]))[0]![1].ids;
	// The app's search: a mailbox and text, collapsed. The mailbox is probed per match, and still filters.
	assert.deepEqual(await ids({ inMailbox: "box-inbox", text: "saturday" }), ["e2"]);
	assert.deepEqual(await ids({ inMailbox: "box-junk", text: "saturday" }), []);
	assert.deepEqual((await call(ctx, ["Email/query", { accountId: "acct", filter: { inMailbox: "box-inbox", subject: "lunch" }, collapseThreads: true }, "q"]))[0]![1].ids, ["e2"]);
	assert.match(compileFilter({ inMailbox: "b", text: "x" }).sql, /^EXISTS \(SELECT 1 FROM email_mailboxes x WHERE x\.email_id = e\.id/);
	assert.match(compileFilter({ inMailbox: "b", from: "x" }).sql, /^e\.id IN \(SELECT email_id FROM email_mailboxes/, "without text the mailbox still drives");
	assert.deepEqual(await ids({ text: "saturday" }), ["e2"]);
	assert.deepEqual(await ids({ subject: "lunch" }), ["e2", "e1"]);
	assert.deepEqual(await ids({ from: "billing@" }), ["e3"]);
	assert.deepEqual(await ids({ notKeyword: "$seen", inMailbox: "box-inbox" }), ["e3", "e1"]);
	assert.deepEqual(await ids({ operator: "NOT", conditions: [{ inMailbox: "box-junk" }, { from: "billing" }] }), ["e2", "e1"]);
});

test("Mailbox/get counts emails, unread and threads; empty mailboxes count zero", async () => {
	const [r] = await call(seeded(), ["Mailbox/get", { accountId: "acct", ids: ["box-inbox", "box-trash"] }, "m"]);
	const trash = (r![1].list as any[])[1];
	assert.deepEqual([trash.totalEmails, trash.unreadEmails, trash.totalThreads, trash.unreadThreads], [0, 0, 0, 0]);
	const inbox = (r![1].list as any[])[0];
	assert.equal(inbox.role, "inbox");
	assert.deepEqual([inbox.totalEmails, inbox.unreadEmails, inbox.totalThreads, inbox.unreadThreads], [3, 2, 2, 2]);
});

test("Thread/get orders emails oldest first", async () => {
	const [r] = await call(seeded(), ["Thread/get", { accountId: "acct", ids: ["t1", "nope"] }, "t"]);
	assert.deepEqual(r![1].list, [{ id: "t1", emailIds: ["e1", "e2"] }]);
	assert.deepEqual(r![1].notFound, ["nope"]);
});

test("Email/changes splits created and updated, pages with hasMoreChanges", async () => {
	const ctx = seeded();
	ctx.db.raw.exec("UPDATE emails SET updated_modseq = 5 WHERE id = 'e1'; UPDATE accounts SET modseq = 5");
	const [all] = await call(ctx, ["Email/changes", { accountId: "acct", sinceState: "2" }, "c"]);
	assert.deepEqual([all![1].created, all![1].updated, all![1].newState], [["e3", "e4"], ["e1"], "5"]);
	const [page] = await call(ctx, ["Email/changes", { accountId: "acct", sinceState: "2", maxChanges: 1 }, "c"]);
	assert.deepEqual([page![1].created, page![1].hasMoreChanges, page![1].newState], [["e3"], true, "3"]);
	const [bad] = await call(ctx, ["Email/changes", { accountId: "acct", sinceState: "99" }, "c"]);
	assert.deepEqual(bad, ["error", { type: "cannotCalculateChanges" }, "c"]);
});

test("other accounts, unknown methods and bad references are method errors, not crashes", async () => {
	const ctx = seeded();
	const r = await call(ctx,
		["Mailbox/get", { accountId: "someone-else" }, "a"],
		["Nope/get", {}, "b"],
		["Email/get", { accountId: "acct", "#ids": { resultOf: "zz", name: "Email/query", path: "/ids" } }, "c"],
	);
	assert.deepEqual(r.map((x) => [x[0], (x[1] as any).type]), [["error", "accountNotFound"], ["error", "unknownMethod"], ["error", "invalidResultReference"]]);
	await assert.rejects(dispatch({ using: ["urn:x"], methodCalls: [] }, mailMethods, ctx), { type: "urn:ietf:params:jmap:error:unknownCapability" });
	// What a standard client sends before EmailSubmission/set.
	assert.deepEqual((await dispatch({ using: [...USING, "urn:ietf:params:jmap:submission"], methodCalls: [] }, mailMethods, ctx)).methodResponses, []);
});

test("Email/get and Thread/get accept more ids than D1's 100-parameter limit", async () => {
	const ids = ["e1", "e2", ...Array.from({ length: 148 }, (_, i) => `nope${i}`)];
	const [g, t] = await call(seeded(),
		["Email/get", { accountId: "acct", ids, properties: ["subject"] }, "g"],
		["Thread/get", { accountId: "acct", ids: ["t1", ...Array.from({ length: 149 }, (_, i) => `x${i}`)] }, "t"],
	);
	assert.deepEqual((g![1] as any).list.map((e: any) => e.id), ["e1", "e2"]);
	assert.equal((g![1] as any).notFound.length, 148);
	assert.deepEqual((t![1] as any).list, [{ id: "t1", emailIds: ["e1", "e2"] }]);
});

test("the indexed newest-in-mailbox path returns exactly what the general query returns", async () => {
	const ctx = seeded();
	for (const collapseThreads of [true, false]) {
		for (const [position, limit] of [[0, 10], [1, 1], [0, 2], [5, 10]]) {
			const [fast, slow] = await call(ctx,
				["Email/query", { accountId: "acct", filter: { inMailbox: "box-inbox" }, collapseThreads, position, limit }, "f"],
				// An AND wrapper takes the general path.
				["Email/query", { accountId: "acct", filter: { operator: "AND", conditions: [{ inMailbox: "box-inbox" }] }, collapseThreads, position, limit }, "s"],
			);
			assert.deepEqual(fast![1].ids, slow![1].ids, JSON.stringify({ collapseThreads, position, limit }));
		}
	}
});

// Each sequential D1 call is a network round trip (~30 ms in production), so the app's common requests
// pin how many they make in a row. Calls that overlap (one batch, or Promise.all) count once.
function roundTrips(ctx: Ctx) {
	const db = ctx.db as any;
	let inFlight = 0;
	let waves = 0;
	const track = async <T>(f: () => Promise<T>) => {
		if (inFlight++ === 0) waves++;
		try {
			await new Promise((r) => setTimeout(r, 1));
			return await f();
		} finally {
			inFlight--;
		}
	};
	const wrap = (st: any): any => ({
		inner: st,
		bind: (...p: unknown[]) => wrap(st.bind(...p)),
		all: () => track(() => st.all()),
		first: () => track(() => st.first()),
		run: () => track(() => st.run()),
	});
	ctx.db = { prepare: (sql: string) => wrap(db.prepare(sql)), batch: (list: any[]) => track(() => db.batch(list.map((s) => s.inner))) } as any;
	return () => waves;
}

test("the app's list, thread and mailbox requests each take the fewest D1 round trips", async () => {
	const shapes: [string, number, [string, Record<string, unknown>, string][]][] = [
		["mailbox list", 1, [["Mailbox/get", { accountId: "acct", properties: ["name", "role", "sortOrder", "unreadEmails", "totalEmails", "isSubscribed"] }, "m"]]],
		["a page of threads", 3, [
			["Email/query", { accountId: "acct", filter: { inMailbox: "box-inbox" }, collapseThreads: true, limit: 40 }, "q"],
			["Email/get", { accountId: "acct", "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties: ["threadId", "subject", "keywords", "mailboxIds"] }, "g"],
			["Thread/get", { accountId: "acct", "#ids": { resultOf: "g", name: "Email/get", path: "/list/*/threadId" } }, "t"],
		]],
		["a search in a mailbox", 1, [["Email/query", { accountId: "acct", filter: { inMailbox: "box-inbox", text: "saturday" }, collapseThreads: true, limit: 40 }, "q"]]],
		["opening a thread", 2, [
			["Thread/get", { accountId: "acct", ids: ["t1"] }, "t"],
			["Email/get", { accountId: "acct", "#ids": { resultOf: "t", name: "Thread/get", path: "/list/*/emailIds" }, properties: ["subject", "keywords"] }, "g"],
		]],
	];
	for (const [what, max, calls] of shapes) {
		const ctx = seeded();
		const trips = roundTrips(ctx);
		const r = await call(ctx, ...calls);
		assert.ok(r.every(([name]) => name !== "error"), what);
		assert.equal(trips(), max, what);
	}
});

test("Email/get and Thread/get report the state of the same snapshot as their rows", async () => {
	const [[, t], [, g]] = await call(seeded(),
		["Thread/get", { accountId: "acct", ids: ["t1"] }, "t"],
		["Email/get", { accountId: "acct", ids: ["e1"], properties: ["subject"] }, "g"],
	) as [string, any, string][];
	assert.equal(t.state, "4");
	assert.equal(g.state, "4");
});
