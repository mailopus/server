// App passwords and the JMAP pieces the imap/ proxy uses. Run: pnpm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { basicAuth, lookupAppPassword, newAppPassword, normalizeAppPassword, sha256 } from "../server/lib/auth.ts";
import { gate } from "../server/lib/gate.ts";
import { dispatch } from "../server/lib/jmap/core.ts";
import { type Ctx, addressInScope, blobInScope, mailMethods } from "../server/lib/jmap/mail.ts";
import { emailImport, emailSet } from "../server/lib/jmap/write.ts";
import { uploadKey } from "../server/lib/blobs.ts";
import { ME, testD1 } from "./d1.ts";

const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "https://mailopus.net/jmap/imap"];
const ORIGIN = "https://app.mailopus.net";

function memR2() {
	const store = new Map<string, Uint8Array>();
	return {
		store,
		put: async (k: string, v: Uint8Array | string) => void store.set(k, typeof v === "string" ? new TextEncoder().encode(v) : v),
		get: async (k: string) => {
			const v = store.get(k);
			return v ? { text: async () => new TextDecoder().decode(v), arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength), httpMetadata: {}, customMetadata: {} } : null;
		},
		delete: async (k: string) => void store.delete(k),
	} as unknown as R2Bucket & { store: Map<string, Uint8Array> };
}

function setup() {
	const db = testD1();
	const mail = memR2();
	const w = { db, mail, account: "acct" };
	const ctx: Ctx = {
		db, mail, accounts: new Set(["acct"]), createdIds: {},
		writer: () => ({
			emailSet: (_a, args, ids) => emailSet(w, args, ids) as never,
			emailImport: (_a, args, ids) => emailImport(w, args, ids) as never,
			submit: () => { throw new Error("no sends here"); },
		}),
	};
	const call = (...calls: [string, Record<string, unknown>, string][]) => {
		ctx.createdIds = {};
		return dispatch({ using: USING, methodCalls: calls }, mailMethods, ctx).then((r) => r.methodResponses);
	};
	let n = 0;
	const upload = async (raw: string) => {
		const id = `u${String(++n).padStart(32, "0")}`;
		await mail.put(uploadKey("acct", id), raw);
		return id;
	};
	return { db, call, upload, ctx };
}

const raw = (subject: string, mid: string) =>
	`From: Me <${ME}>\r\nTo: ann@example.com\r\nSubject: ${subject}\r\nMessage-ID: <${mid}>\r\nDate: Sat, 07 Nov 2026 10:00:00 +0000\r\n\r\nHello\r\n`;

test("app passwords are 32 random characters of upper, lower and digits; case matters", () => {
	const p = newAppPassword();
	assert.match(p, /^[A-Za-z0-9]{32}$/);
	assert.notEqual(newAppPassword(), p);
	assert.equal(normalizeAppPassword(` ${p.slice(0, 16)}-${p.slice(16)}\n`), p, "pasted with a dash or whitespace still matches");
	const seen = new Set(Array.from({ length: 200 }, newAppPassword).join(""));
	assert.equal(seen.size, 62, "every character turns up");
});

test("basicAuth parses a header and refuses junk", () => {
	assert.deepEqual(basicAuth(`Basic ${btoa("Me@Mailopus.net:a:b")}`), { user: "me@mailopus.net", pass: "a:b" });
	assert.equal(basicAuth("Bearer x"), null);
	assert.equal(basicAuth(`Basic ${btoa("nocolon")}`), null);
	assert.equal(basicAuth("Basic !!!"), null);
});

async function withPassword() {
	const db = testD1();
	const pass = newAppPassword();
	db.raw.prepare("INSERT INTO app_passwords (id, user_id, name, token_hash, created_at) VALUES ('p1', 'user', 'Mail', ?, 1)").run(await sha256(pass));
	return { db, pass };
}

test("an app password signs in with any of the user's addresses, and records its use", async () => {
	const { db, pass } = await withPassword();
	assert.deepEqual(await lookupAppPassword(db, { user: ME, pass }), { userId: "user", scope: null, appPassword: "p1" });
	// Catch-all on the domain (provision routes *@mailopus.net).
	assert.equal((await lookupAppPassword(db, { user: "alias@mailopus.net", pass }))?.userId, "user");
	assert.equal(await lookupAppPassword(db, { user: "case@mailopus.net", pass: pass.toLowerCase() }), null, "case matters");
	assert.equal(await lookupAppPassword(db, { user: "me@elsewhere.com", pass }), null);
	assert.equal(await lookupAppPassword(db, { user: ME, pass: "AAAA-AAAA-AAAA-AAAA-AAAA" }), null);
	assert.ok((db.raw.prepare("SELECT last_used_at FROM app_passwords WHERE id = 'p1'").get() as { last_used_at: number }).last_used_at > 0);
});

test("sign-ins are counted per password, address and network; a wrong password is counted for the address's owner only", async () => {
	const { signinFailed } = await import("../server/lib/auth.ts");
	const { db, pass } = await withPassword();
	await lookupAppPassword(db, { user: ME, pass }, "203.0.113.9");
	await lookupAppPassword(db, { user: "Other@mailopus.net", pass }, "203.0.113.10"); // a cache miss: another username
	await signinFailed(db, ME, "203.0.113.0/24");
	await signinFailed(db, ME, "203.0.113.0/24");
	await signinFailed(db, "nobody@elsewhere.example", "198.51.100.0/24");
	const rows = db.raw.prepare("SELECT password_id, address, network, ok, count FROM app_password_signins ORDER BY ok DESC, address").all();
	assert.deepEqual(rows.map((r) => ({ ...r })), [
		{ password_id: "p1", address: ME, network: "203.0.113.0/24", ok: 1, count: 1 },
		{ password_id: "p1", address: "other@mailopus.net", network: "203.0.113.0/24", ok: 1, count: 1 },
		{ password_id: "", address: ME, network: "203.0.113.0/24", ok: 0, count: 2 },
	]);
});

test("the first 20-character base32 passwords still work in any case", async () => {
	const db = testD1();
	db.raw.prepare("INSERT INTO app_passwords (id, user_id, name, token_hash, created_at) VALUES ('old', 'user', 'Mail', ?, 1)").run(await sha256("ABCDEFGHIJKLMNOPQRST"));
	assert.equal((await lookupAppPassword(db, { user: ME, pass: "abcd-efgh-ijkl-mnop-qrst" }))?.userId, "user");
});

test("a revoked app password stops working once the cache entry expires", async () => {
	const { db, pass } = await withPassword();
	const user = "revoke@mailopus.net";
	assert.equal((await lookupAppPassword(db, { user, pass }))?.userId, "user");
	db.raw.exec("DELETE FROM app_passwords");
	// Cached for up to a minute; a different username is a different cache entry, so it misses.
	assert.equal(await lookupAppPassword(db, { user: "other@mailopus.net", pass }), null);
});

function gateEnv(db: D1Database, limitOk = true) {
	return { APP_ORIGIN: ORIGIN, DB: db, AUTH_LIMIT: { limit: async () => ({ success: limitOk }) }, ASSETS: { fetch: async () => new Response("") } } as unknown as Env;
}
const basic = (user: string, pass: string) => ({ authorization: `Basic ${btoa(`${user}:${pass}`)}` });
const reached = () => new Response("app");

test("the gate takes an app password on /jmap/* without an Origin, and nowhere else", async () => {
	const { db, pass } = await withPassword();
	const env = gateEnv(db);
	const post = (path: string, headers: Record<string, string>) => gate(new Request(ORIGIN + path, { method: "POST", headers }), env, reached);
	assert.equal((await post("/jmap/api", basic(ME, pass))).status, 200);
	assert.equal((await post("/jmap/api", { ...basic(ME, pass), origin: "https://evil.example" })).status, 200, "no cookie involved, so Origin doesn't matter");
	assert.equal((await post("/api/app-passwords", { ...basic(ME, pass), origin: ORIGIN })).status, 401, "app passwords can't reach /api");
	assert.equal((await post("/jmap/api", basic(ME, "WRONG"))).status, 401);
	assert.equal((await gate(new Request(ORIGIN + "/jmap/api", { method: "POST", headers: basic(ME, "WRONG") }), gateEnv(db, false), reached)).status, 429);
});

test("Mailbox/get and Email/get expose IMAP uids; Email/imapUids pages a mailbox in uid order", async () => {
	const { call, upload } = setup();
	const emails: Record<string, unknown> = {};
	for (let i = 1; i <= 5; i++) emails[`m${i}`] = { blobId: await upload(raw(`n${i}`, `n${i}@x`)), mailboxIds: { "box-inbox": true }, keywords: i === 2 ? { $seen: true } : {} };
	const [imp] = await call(["Email/import", { accountId: "acct", emails }, "i"]);
	const created = imp![1].created as Record<string, { id: string }>;
	assert.equal(Object.keys(created).length, 5);

	const [p1] = await call(["Email/imapUids", { accountId: "acct", mailboxId: "box-inbox", limit: 3 }, "u"]);
	assert.equal(p1![1].hasMore, true);
	const l1 = p1![1].list as [number, string, string[]][];
	assert.deepEqual(l1.map((r) => r[0]), [1, 2, 3]);
	assert.deepEqual(l1[1]![2], ["$seen"]);
	assert.ok((l1[0]![3] as number) > 0, "size");
	assert.ok((l1[0]![4] as number) > 0, "receivedAt");
	const [p2] = await call(["Email/imapUids", { accountId: "acct", mailboxId: "box-inbox", afterUid: 3, limit: 3 }, "u"]);
	assert.deepEqual((p2![1].list as unknown[][]).map((r) => r[0]), [4, 5]);
	assert.equal(p2![1].hasMore, false);
	assert.equal(p2![1].uidNext, 6);

	// Moving to Archive gives a new uid there; moving back gives a fresh one in Inbox, never the old.
	const id = created.m1!.id;
	await call(["Email/set", { accountId: "acct", update: { [id]: { "mailboxIds/box-inbox": null, "mailboxIds/box-archive": true } } }, "s"]);
	await call(["Email/set", { accountId: "acct", update: { [id]: { "mailboxIds/box-archive": null, "mailboxIds/box-inbox": true } } }, "s"]);
	const [g, mb] = await call(
		["Email/get", { accountId: "acct", ids: [id], properties: ["imapUids", "imapHeader"] }, "g"],
		["Mailbox/get", { accountId: "acct", ids: ["box-inbox"], properties: ["imapUidValidity", "imapUidNext"] }, "m"],
	);
	assert.deepEqual((g![1].list as any[])[0].imapUids, { "box-inbox": 6 });
	const header = (g![1].list as any[])[0].imapHeader as string;
	assert.match(header, /^From: Me/);
	assert.ok(header.endsWith("\r\n\r\n") && !header.includes("Hello"), "the header block only, through the blank line");
	const box = (mb![1].list as any[])[0];
	assert.equal(box.imapUidNext, 7);
	assert.ok(box.imapUidValidity > 0);
});

test("Email/import refuses bad mailboxes and missing blobs; a Sent copy already in Sent merges", async () => {
	const { call, upload } = setup();
	const [bad] = await call(["Email/import", { accountId: "acct", emails: {
		a: { blobId: await upload(raw("x", "x@x")), mailboxIds: { nope: true } },
		b: { blobId: "u" + "f".repeat(32), mailboxIds: { "box-inbox": true } },
	} }, "i"]);
	assert.equal((bad![1].notCreated as any).a.type, "invalidProperties");
	assert.equal((bad![1].notCreated as any).b.type, "blobNotFound");

	const sent = async () => (await call(["Email/import", { accountId: "acct", emails: { s: { blobId: await upload(raw("sent", "s@x")), mailboxIds: { "box-sent": true }, keywords: { $seen: true } } } }, "i"]))[0]![1].created as any;
	const first = await sent();
	const second = await sent();
	assert.equal(second.s.id, first.s.id, "the client's own copy of a sent message doesn't duplicate it");

	// Same Message-ID into Drafts (a client re-saving a draft) is a new email: merging would let the
	// client's EXPUNGE of the old copy delete the new one.
	const [d] = await call(["Email/import", { accountId: "acct", emails: { d: { blobId: await upload(raw("sent", "s@x")), mailboxIds: { "box-drafts": true } } } }, "i"]);
	assert.notEqual((d![1].created as any).d.id, first.s.id);
});

test("addressInScope matches addresses and domains the way addressedSql does", () => {
	assert.ok(addressInScope("Sam@acme.test", ["sam@acme.test"]));
	assert.ok(addressInScope("a@mail.acme.test", ["@acme.test"]));
	assert.ok(!addressInScope("a@notacme.test", ["@acme.test"]));
	assert.ok(addressInScope("anything@x.com", null));
});

test("a limited app password sees, changes and sends only mail to its addresses", async () => {
	const { call, upload, ctx } = setup();
	const other = (subject: string, mid: string) =>
		`From: Bob <bob@example.com>\r\nTo: sam@acme.test\r\nSubject: ${subject}\r\nMessage-ID: <${mid}>\r\nDate: Sat, 07 Nov 2026 10:00:00 +0000\r\n\r\nHi\r\n`;
	const [imp] = await call(["Email/import", { accountId: "acct", emails: {
		mine: { blobId: await upload(raw("mine", "mine@x")), mailboxIds: { "box-inbox": true } },
		acme: { blobId: await upload(other("acme", "h@x")), mailboxIds: { "box-inbox": true } },
	} }, "i"]);
	const ids = imp![1].created as Record<string, { id: string }>;
	const mine = ids.mine!.id, acme = ids.acme!.id;

	ctx.scope = ["@acme.test"];
	const [q, g, c, u, mb, idn] = await call(
		["Email/query", { accountId: "acct", filter: { inMailbox: "box-inbox" } }, "q"],
		["Email/get", { accountId: "acct", ids: [mine, acme], properties: ["id"] }, "g"],
		["Email/changes", { accountId: "acct", sinceState: "0" }, "c"],
		["Email/imapUids", { accountId: "acct", mailboxId: "box-inbox" }, "u"],
		["Mailbox/get", { accountId: "acct", ids: ["box-inbox"], properties: ["totalEmails", "unreadEmails", "myRights"] }, "m"],
		["Identity/get", { accountId: "acct" }, "id"],
	);
	assert.deepEqual(q![1].ids, [acme]);
	assert.deepEqual((g![1].list as any[]).map((e) => e.id), [acme]);
	assert.deepEqual(g![1].notFound, [mine]);
	assert.deepEqual(c![1].created, [acme]);
	assert.deepEqual((u![1].list as any[]).map((r) => r[1]), [acme]);
	assert.equal((mb![1].list as any[])[0].totalEmails, 1);
	assert.equal((mb![1].list as any[])[0].myRights.mayCreateChild, false);
	assert.deepEqual(idn![1].list, [], "the only identity is outside the scope");

	const err = (r: any) => r[0] === "error" && r[1].type;
	const [set] = await call(["Email/set", { accountId: "acct", update: { [mine]: { "keywords/$seen": true } } }, "s"]);
	assert.equal(err(set), "forbidden");
	const [copy] = await call(["Email/import", { accountId: "acct", emails: { x: { blobId: mine, mailboxIds: { "box-inbox": true } } } }, "i"]);
	assert.equal(err(copy), "forbidden", "can't copy an out-of-scope message in by its blob id");
	const [box] = await call(["Mailbox/set", { accountId: "acct", create: { n: { name: "x" } } }, "b"]);
	assert.equal(err(box), "forbidden");
	const [sub] = await call(["EmailSubmission/set", { accountId: "acct", create: { s: { identityId: "anything", emailId: acme } } }, "e"]);
	assert.equal(err(sub), "forbidden");
	const [ok] = await call(["Email/set", { accountId: "acct", update: { [acme]: { "keywords/$seen": true } } }, "s"]);
	assert.deepEqual(Object.keys(ok![1].updated as object), [acme]);
	assert.equal(await blobInScope(ctx, "acct", mine), false);
	assert.equal(await blobInScope(ctx, "acct", `${acme}_0`), true);
	assert.equal(await blobInScope(ctx, "acct", "u" + "0".repeat(32)), true, "uploads aren't mail");
});
