// Run: pnpm test
// Full scans D1 reported as "overloaded" (migration 0029). Plans here come from node:sqlite without
// production stats, so these pin the shape of each query, not the planner's every choice.
import assert from "node:assert/strict";
import { test } from "node:test";
import { testD1 } from "./d1.ts";
import { addressedSql } from "../server/lib/addressed.ts";
import { compileFilter } from "../server/lib/jmap/mail.ts";

const plan = (sql: string, ...p: unknown[]) =>
	testD1().raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(p as never[])).map((r) => String((r as { detail: string }).detail)).join(" | ");

test("destroying a message finds its search row through the email_id index, not a scan", () => {
	const p = plan("DELETE FROM emails_fts WHERE rowid IN (SELECT id FROM emails_fts_content WHERE c0 = ?)", "x");
	assert.match(p, /emails_fts_content_email/);
	assert.doesNotMatch(p, /SCAN emails_fts_content/);
});

test("lookups by id and by thread never walk the account's addressed_to index", () => {
	const ids = Array.from({ length: 50 }, (_, i) => `id${i}`);
	const marks = ids.map(() => "?").join(",");
	const like = "(e.addressed_to LIKE ? ESCAPE '\\' OR e.addressed_to LIKE ? ESCAPE '\\')";
	for (const sql of [
		`SELECT * FROM emails e WHERE +e.account_id = ? AND e.destroyed_modseq IS NULL AND e.id IN (${marks}) AND ${like}`,
		`SELECT e.thread_id, e.id FROM emails e WHERE +e.account_id = ? AND e.destroyed_modseq IS NULL AND e.thread_id IN (${marks}) AND 1`,
		`SELECT e.thread_id, e.id FROM emails e WHERE e.account_id = ? AND e.destroyed_modseq IS NULL AND e.thread_id IN (${marks}) AND 1`,
	]) {
		const params = sql.includes("LIKE") ? ["acct", ...ids, "%@x.com", "%.x.com"] : ["acct", ...ids];
		assert.doesNotMatch(plan(sql, ...params), /emails_account_addressed/, sql.slice(0, 80));
	}
});

test("a scoped folder count can still use the addressed_to index", () => {
	assert.match(plan("SELECT count(*) FROM emails e WHERE e.account_id = ? AND e.destroyed_modseq IS NULL AND e.addressed_to IN (?)", "acct", "a@x.com"), /emails_account_addressed/);
});

test("a password scoped to domains counts its folders through the addressed_to index", () => {
	const scope = addressedSql(["@a.example", "@b.example"]);
	const sql = `SELECT em.mailbox_id, count(*) FROM email_mailboxes em JOIN emails e ON e.id = em.email_id
		WHERE e.account_id = ? AND e.destroyed_modseq IS NULL AND ${scope.sql} GROUP BY em.mailbox_id`;
	assert.match(plan(sql, "acct", ...scope.params), /emails_account_addressed/);
});

test("a search starts from its matches and looks each one up, in the mailbox too, instead of walking the account", () => {
	// The two shapes Email/query builds (server/lib/jmap/mail.ts): flat, and one row per thread.
	for (const filter of [{ inMailbox: "box-inbox", text: "invoice" }, { text: "invoice" }]) {
		const f = compileFilter(filter);
		assert.equal(f.fts, true);
		const base = `SELECT e.id, e.thread_id, e.received_at, e.sent_at, e.size FROM emails e WHERE +e.account_id = ? AND e.destroyed_modseq IS NULL AND (${f.sql})`;
		const threads = `(SELECT * FROM (SELECT f.*, ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY received_at DESC, id) AS rn FROM (${base}) f) WHERE rn = 1)`;
		for (const from of [`(${base})`, threads]) {
			const p = plan(`SELECT id FROM ${from} ORDER BY received_at DESC, id LIMIT ? OFFSET ?`, "acct", ...f.params, 50, 0);
			assert.match(p, /SEARCH e USING INDEX sqlite_autoindex_emails_1 \(id=\?\)/, p);
			if ("inMailbox" in filter) assert.match(p, /SEARCH x (EXISTS )?USING COVERING INDEX sqlite_autoindex_email_mailboxes_1 \(email_id=\? AND mailbox_id=\?\)/, p);
			assert.doesNotMatch(p, /emails_account_|SCAN (e|x|email_mailboxes)\b/, p);
		}
	}
	assert.ok(!compileFilter({ inMailbox: "b", from: "x" }).fts);
	assert.ok(!compileFilter({ operator: "NOT", conditions: [{ text: "x" }] }).fts, "a negated search can't drive");
});

test("a common-word search walks the mailbox by date through narrow indexes and looks no match up per row", () => {
	// The shape newestInMailbox builds when it's given words (server/lib/jmap/mail.ts).
	const p = plan(`SELECT em.email_id AS id, e.thread_id FROM email_mailboxes em CROSS JOIN emails_fts_content c ON c.c0 = em.email_id CROSS JOIN emails e ON e.id = em.email_id
		WHERE em.mailbox_id = ? AND +c.id IN (SELECT rowid FROM emails_fts WHERE emails_fts MATCH ?) AND e.account_id = ? AND e.destroyed_modseq IS NULL AND 1
		ORDER BY em.received_at DESC, em.email_id LIMIT ?`, "box-inbox", '"the"', "acct", 150);
	assert.match(p, /^SEARCH em USING INDEX email_mailboxes_newest \(mailbox_id=\?\) \| SEARCH c USING COVERING INDEX emails_fts_content_email \(c0=\?\) \|/, p);
	assert.match(p, /SEARCH e USING INDEX sqlite_autoindex_emails_1 \(id=\?\)/, p);
	assert.doesNotMatch(p, /rowid=\?|SCAN (em|c|e)\b|USE TEMP B-TREE FOR ORDER BY/, p);
});

test("a rare-word search reads its matches, each one's mailbox row, and full rows only for the page", () => {
	// The shape matchesInMailbox builds (server/lib/jmap/mail.ts).
	const p = plan(`SELECT m.id, e.thread_id FROM (
			SELECT x.email_id AS id, x.received_at FROM (SELECT rowid AS r FROM emails_fts WHERE emails_fts MATCH ? LIMIT 1001) f
			CROSS JOIN emails_fts_content c INDEXED BY emails_fts_content_id ON c.id = f.r
			CROSS JOIN email_mailboxes x ON x.email_id = c.c0 AND x.mailbox_id = ?
			ORDER BY x.received_at DESC, x.email_id LIMIT ?) m
		CROSS JOIN emails e ON e.id = m.id
		WHERE e.account_id = ? AND e.destroyed_modseq IS NULL AND 1
		ORDER BY m.received_at DESC, m.id`, '"rare"', "box-inbox", 150, "acct");
	assert.match(p, /SCAN emails_fts VIRTUAL TABLE INDEX 0:M4/, p);
	assert.match(p, /SEARCH x USING INDEX sqlite_autoindex_email_mailboxes_1 \(email_id=\? AND mailbox_id=\?\)/, p);
	assert.match(p, /SEARCH e USING INDEX sqlite_autoindex_emails_1 \(id=\?\)/, p);
	assert.doesNotMatch(p, /SCAN (x|e)\b|emails_account_/, p);
	// The email id comes from the narrow index, never from the content table's rows, which hold the message text.
	assert.match(p, /SEARCH c USING COVERING INDEX emails_fts_content_id \(id=\?\)/, p);
});
