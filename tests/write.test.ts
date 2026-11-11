// Run: pnpm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatch } from "../server/lib/jmap/core.ts";
import { type Ctx, mailMethods } from "../server/lib/jmap/mail.ts";
import { applyPatch, emailSet, headerAddresses, ingestEmail, mailboxSet, submissionSet } from "../server/lib/jmap/write.ts";
import { MimeError, buildMime, stripBcc } from "../server/lib/mime.ts";
import { parseEmail } from "../server/utils/mail.ts";
import { testD1 } from "./d1.ts";
import { ADDRESS_COUNTS_SQL, COUNTS_SQL } from "../server/lib/recount.ts";
import { importBatch } from "../server/lib/jmap/write.ts";

const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];

function memR2() {
	const store = new Map<string, Uint8Array>();
	return {
		store,
		put: async (k: string, v: Uint8Array | string) => void store.set(k, typeof v === "string" ? new TextEncoder().encode(v) : v),
		get: async (k: string) => {
			const v = store.get(k);
			return v ? { text: async () => new TextDecoder().decode(v), arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) } : null;
		},
		delete: async (k: string) => void store.delete(k),
	} as unknown as R2Bucket & { store: Map<string, Uint8Array> };
}

function setup() {
	const db = testD1();
	const mail = memR2();
	const sent: { from: string; to: string; raw: string }[] = [];
	const w = { db, mail, account: "acct" };
	const send = async (from: string, to: string, raw: string) => {
		sent.push({ from, to, raw });
		return `provider-${sent.length}@mailopus.net`;
	};
	const ctx: Ctx = {
		db, mail, accounts: new Set(["acct"]), createdIds: {},
		writer: () => ({
			emailSet: (_a, args, ids) => emailSet(w, args, ids) as never,
			submit: (_a, args, ids) => submissionSet(w, args, ids, send) as never,
			mailboxSet: (_a, args) => mailboxSet(w, args) as never,
		}),
	};
	const call = (...calls: [string, Record<string, unknown>, string][]) => {
		ctx.createdIds = {};
		return dispatch({ using: USING, methodCalls: calls }, mailMethods, ctx).then((r) => r.methodResponses);
	};
	return { db, mail, w, sent, call, ctx };
}

const draft = (extra: Record<string, unknown> = {}) => ({
	mailboxIds: { "box-drafts": true },
	keywords: { $draft: true, $seen: true },
	from: [{ name: "Me", email: "me@mailopus.net" }],
	to: [{ name: "Ann", email: "ann@example.com" }],
	bcc: [{ email: "secret@example.com" }],
	subject: "Héllo",
	bodyValues: { t: { value: "Body text" } },
	textBody: [{ partId: "t", type: "text/plain" }],
	...extra,
});

test("buildMime refuses header injection and round-trips through the parser", async () => {
	const base = { from: [{ email: "a@b.co" }], messageId: "x@b.co", date: new Date(0) };
	assert.throws(() => buildMime({ ...base, subject: "hi\r\nBcc: evil@x.com" }), MimeError);
	assert.throws(() => buildMime({ ...base, to: [{ name: "x\nY", email: "c@d.co" }] }), MimeError);
	assert.throws(() => buildMime({ ...base, to: [{ email: "not-an-address" }] }), MimeError);
	const raw = buildMime({ ...base, to: [{ name: "Zoë", email: "z@d.co" }], subject: "Grüße", html: "<p>hi</p>", text: "hi" });
	const p = await parseEmail(new TextEncoder().encode(raw).buffer as ArrayBuffer);
	assert.equal(p.subject, "Grüße");
	assert.deepEqual(p.to, [{ name: "Zoë", email: "z@d.co" }]);
	assert.equal(p.messageId, "<x@b.co>");
});

test("stripBcc removes Bcc and its folded lines, nothing else", () => {
	const raw = "From: a@b.co\r\nBcc: x@y.co,\r\n  z@y.co\r\nSubject: s\r\n\r\nBcc: in body stays\r\n";
	assert.equal(stripBcc(raw), "From: a@b.co\r\nSubject: s\r\n\r\nBcc: in body stays\r\n");
});

test("applyPatch handles paths, whole-object replace, and rejects other properties", () => {
	const cur = { keywords: { $seen: true as const }, mailboxIds: { a: true as const } };
	assert.deepEqual(applyPatch(cur, { "keywords/$seen": null, "keywords/$Flagged": true, "mailboxIds/b": true, "mailboxIds/a": null }).next,
		{ keywords: { $flagged: true }, mailboxIds: { b: true } });
	assert.equal(applyPatch(cur, { subject: "x" }).error?.type, "invalidProperties");
	assert.equal(applyPatch(cur, { "keywords/$seen": false }).error?.type, "invalidProperties");
});

test("draft create, send, and move to Sent in one request; Bcc never leaves in the message", async () => {
	const { call, sent, mail } = setup();
	const r = await call(
		["Email/set", { accountId: "acct", create: { d: draft() } }, "0"],
		["EmailSubmission/set", {
			accountId: "acct",
			create: { s: { identityId: "ident", emailId: "#d" } },
			onSuccessUpdateEmail: { "#s": { "mailboxIds/box-drafts": null, "mailboxIds/box-sent": true, "keywords/$draft": null } },
		}, "1"],
	);
	assert.deepEqual(r.map((x) => x[0]), ["Email/set", "EmailSubmission/set", "Email/set"]);
	const id = (r[0]![1] as any).created.d.id;
	r.push(...(await call(["Email/get", { accountId: "acct", ids: [id], properties: ["mailboxIds", "keywords", "subject"] }, "2"])));
	assert.equal(mail.store.size, 1, "draft raw stored once");
	assert.deepEqual(sent.map((s) => s.to).sort(), ["ann@example.com", "secret@example.com"]);
	assert.ok(sent.every((s) => s.from === "me@mailopus.net" && !/^bcc:/im.test(s.raw.split("\r\n\r\n")[0]!)));
	const email = (r[3]![1] as any).list[0];
	assert.deepEqual(email, { id: email.id, mailboxIds: { "box-sent": true }, keywords: { $seen: true }, subject: "Héllo" });
});

test("submission refuses a second From address next to the identity", async () => {
	const { call, sent } = setup();
	const [, sub] = await call(
		["Email/set", { accountId: "acct", create: { d: draft({ from: [{ email: "me@mailopus.net" }, { email: "ceo@mailopus.net" }] }) } }, "0"],
		["EmailSubmission/set", { accountId: "acct", create: { s: { identityId: "ident", emailId: "#d" } } }, "1"],
	);
	assert.equal((sub![1] as any).notCreated.s.type, "forbiddenFrom");
	assert.equal(sent.length, 0);
});

test("headerAddresses sees every From header and address, and Sender", () => {
	const head = (h: string) => `${h}\r\nTo: x@y.co\r\n\r\nFrom: body@not.a.header\r\n`;
	assert.deepEqual(headerAddresses(head("From: Me <me@acme.test>"), "from"), [["me@acme.test"]]);
	assert.deepEqual(headerAddresses(head("From: me@acme.test,\r\n ceo@acme.test"), "from"), [["me@acme.test", "ceo@acme.test"]]);
	assert.deepEqual(headerAddresses(head("From: me@acme.test\r\nFROM: ceo@acme.test"), "from"), [["me@acme.test"], ["ceo@acme.test"]]);
	assert.deepEqual(headerAddresses(head("From: me@acme.test\r\nFrom \t: ceo@acme.test"), "from"), [["me@acme.test"], ["ceo@acme.test"]], "space before the colon is still a From header");
	assert.deepEqual(headerAddresses(head("From: me@acme.test\r\nSender: ceo@acme.test"), "sender"), [["ceo@acme.test"]]);
	assert.deepEqual(headerAddresses(head("From: me@acme.test"), "sender"), []);
});

test("submission refuses a From that isn't the identity", async () => {
	const { call, sent } = setup();
	const [, sub] = await call(
		["Email/set", { accountId: "acct", create: { d: draft({ from: [{ email: "ceo@bank.com" }] }) } }, "0"],
		["EmailSubmission/set", { accountId: "acct", create: { s: { identityId: "ident", emailId: "#d" } } }, "1"],
	);
	assert.equal((sub![1] as any).notCreated.s.type, "forbiddenFrom");
	assert.equal(sent.length, 0);
});

test("update flags and mailboxes, destroy, and Email/changes reports each", async () => {
	const { call, w, mail } = setup();
	const raw = new TextEncoder().encode("From: x@y.co\r\nSubject: hi\r\nMessage-ID: <p@y.co>\r\n\r\nhello\r\n");
	for (const id of ["m1", "m2"]) {
		await mail.put(`raw/acct/${id}.eml`, raw);
		await ingestEmail(w, { ...(await parseEmail(raw.buffer as ArrayBuffer)), id, blobKey: `raw/acct/${id}.eml`, size: raw.byteLength, receivedAt: 1 });
	}
	const [set] = await call(["Email/set", {
		accountId: "acct", ifInState: "2",
		update: { m1: { "keywords/$seen": true, "mailboxIds/box-inbox": null, "mailboxIds/box-archive": true }, nope: { "keywords/$seen": true } },
		destroy: ["m2"],
	}, "0"]);
	const s = set![1] as any;
	assert.deepEqual([s.oldState, s.newState, s.updated, s.destroyed, s.notUpdated.nope.type], ["2", "4", { m1: null }, ["m2"], "notFound"]);
	assert.equal(mail.store.has("raw/acct/m2.eml"), false, "destroyed blob is deleted");

	const uid = w.db.raw.prepare("SELECT uid FROM email_mailboxes WHERE email_id = 'm1'").get() as { uid: number };
	assert.equal(uid.uid, 1, "first uid in Archive");
	const [ch, get, empty] = await call(
		["Email/changes", { accountId: "acct", sinceState: "2" }, "c"],
		["Email/get", { accountId: "acct", ids: ["m2"] }, "g"],
		["Email/set", { accountId: "acct", ifInState: "2", update: { m1: { "mailboxIds/box-archive": null } } }, "x"],
	);
	assert.deepEqual([(ch![1] as any).updated, (ch![1] as any).destroyed], [["m1"], ["m2"]]);
	assert.deepEqual((get![1] as any).notFound, ["m2"]);
	assert.deepEqual(empty, ["error", { type: "stateMismatch" }, "x"]);
	const [last] = await call(["Email/set", { accountId: "acct", update: { m1: { "mailboxIds/box-archive": null } } }, "y"]);
	assert.equal((last![1] as any).notUpdated.m1.type, "invalidProperties", "an email can't end up in no mailbox");
});

test("a reply to the provider's Message-ID joins the sent message's thread", async () => {
	const { call, w } = setup();
	const [c] = await call(
		["Email/set", { accountId: "acct", create: { d: draft({ bcc: [] }) } }, "0"],
		["EmailSubmission/set", { accountId: "acct", create: { s: { identityId: "ident", emailId: "#d" } } }, "1"],
	);
	const threadId = (c![1] as any).created.d.threadId;
	const reply = new TextEncoder().encode("From: ann@example.com\r\nSubject: Re: hi\r\nIn-Reply-To: <provider-1@mailopus.net>\r\n\r\nthanks\r\n");
	const r = await ingestEmail(w, { ...(await parseEmail(reply.buffer as ArrayBuffer)), id: "r1", blobKey: "k", size: 1, receivedAt: 2 });
	assert.equal(r.threadId, threadId);
});

test("a References header with hundreds of ids still ingests and threads", async () => {
	const { call, w } = setup();
	const [c] = await call(
		["Email/set", { accountId: "acct", create: { d: draft({ bcc: [] }) } }, "0"],
		["EmailSubmission/set", { accountId: "acct", create: { s: { identityId: "ident", emailId: "#d" } } }, "1"],
	);
	const refs = Array.from({ length: 300 }, (_, i) => (i === 290 ? "<provider-1@mailopus.net>" : `<r${i}@spam.example>`)).join(" ");
	const reply = new TextEncoder().encode(`From: ann@example.com\r\nSubject: Re: hi\r\nReferences: ${refs}\r\n\r\nthanks\r\n`);
	const r = await ingestEmail(w, { ...(await parseEmail(reply.buffer as ArrayBuffer)), id: "r1", blobKey: "k", size: 1, receivedAt: 2 });
	assert.equal(r.threadId, (c![1] as any).created.d.threadId);
});

test("the delivered copy of mail sent to yourself joins the sent copy's thread", async () => {
	const { call, w } = setup();
	const [c] = await call(
		["Email/set", { accountId: "acct", create: { d: draft({ to: [{ email: "me@mailopus.net" }], bcc: [] }) } }, "0"],
		["EmailSubmission/set", { accountId: "acct", create: { s: { identityId: "ident", emailId: "#d" } } }, "1"],
	);
	const copy = new TextEncoder().encode("From: me@mailopus.net\r\nSubject: Hi\r\nMessage-ID: <provider-1@mailopus.net>\r\n\r\nhi\r\n");
	const r = await ingestEmail(w, { ...(await parseEmail(copy.buffer as ArrayBuffer)), id: "c1", blobKey: "k", size: 1, receivedAt: 2 });
	assert.equal(r.threadId, (c![1] as any).created.d.threadId);
});

test("bodies go out as 7bit or quoted-printable, never base64, and round-trip exactly", async () => {
	const PostalMime = (await import("postal-mime")).default;
	const cases = [
		"Plain ASCII.\nSecond line.",
		"Grüße — naïve café 🎉",
		"a=b and ==",
		"trailing space here \nand tab\t",
		"x".repeat(300),
		"long ünïcode " + "é".repeat(120),
	];
	for (const text of cases) {
		const raw = buildMime({ from: [{ email: "a@b.co" }], messageId: "m@b.co", date: new Date(0), text });
		assert.doesNotMatch(raw, /Content-Transfer-Encoding: base64/);
		assert.ok(raw.split("\r\n").every((l) => l.length <= 998), "no line over 998");
		const parsed = await PostalMime.parse(raw);
		assert.equal(parsed.text?.replace(/\r\n/g, "\n").replace(/\n$/, ""), text, JSON.stringify(text));
	}
	assert.match(buildMime({ from: [{ email: "a@b.co" }], messageId: "m@b.co", date: new Date(0), text: "hi" }), /Content-Transfer-Encoding: 7bit/);
	assert.match(buildMime({ from: [{ email: "a@b.co" }], messageId: "m@b.co", date: new Date(0), text: "héllo" }), /Content-Transfer-Encoding: quoted-printable/);
});

/** mailbox_counts (migration 0030) equals a recount from the rows. */
function assertAddressCounts(w: { db: { raw: { prepare: (s: string) => { all: (...a: unknown[]) => unknown[] } } } }) {
	const rows = w.db.raw.prepare(ADDRESS_COUNTS_SQL).all("acct") as { mailbox_id: string; addressed_to: string; total: number; unread: number; stored_total: number; stored_unread: number }[];
	for (const r of rows) assert.deepEqual([r.stored_total, r.stored_unread], [r.total, r.unread], `${r.mailbox_id} ${r.addressed_to}`);
	return rows;
}

test("stored mailbox counts match a full recount after every kind of write", async () => {
	const { call, w, mail } = setup();
	const raw = (mid: string) => new TextEncoder().encode(`From: x@y.co\r\nSubject: ${mid}\r\nMessage-ID: <${mid}@y.co>\r\n\r\nhi\r\n`);
	for (const id of ["a", "b", "c"]) {
		const r = raw(id);
		await mail.put(`k-${id}`, r);
		await ingestEmail(w, { ...(await parseEmail(r.buffer as ArrayBuffer)), id, blobKey: `k-${id}`, size: r.byteLength, receivedAt: 1 });
	}
	// Import: one new message, one twin of "a" merging into Sent and a label mailbox.
	const imp = async (gid: string, mid: string, extra: Record<string, unknown>) => ({
		...(await parseEmail(raw(mid).buffer as ArrayBuffer)), id: crypto.randomUUID(), blobKey: "k", size: 1, receivedAt: 2,
		sourceId: `gmail:me:${gid}`, roles: ["inbox"], labels: [], keywords: {}, threadHint: "h", ...extra,
	});
	await importBatch(w, [await imp("g1", "d", { keywords: { $seen: true } }), await imp("g2", "a", { roles: ["sent"], labels: ["Receipts"] })]);
	await call(["Email/set", { accountId: "acct", update: {
		a: { "keywords/$seen": true },
		b: { "mailboxIds/box-inbox": null, "mailboxIds/box-archive": true },
		c: { "keywords/$seen": true, "mailboxIds/box-archive": true },
	} }, "0"]);
	await call(["Email/set", { accountId: "acct", update: { c: { "keywords/$seen": null } }, destroy: ["b"] }, "1"]);
	const rows = w.db.raw.prepare(COUNTS_SQL).all("acct") as { id: string; stored_total: number; total: number; stored_unread: number; unread: number }[];
	for (const r of rows) assert.deepEqual([r.stored_total, r.stored_unread], [r.total, r.unread], r.id);
	assert.ok(rows.some((r) => r.total > 0), "the scenario actually placed mail");
	assert.ok(assertAddressCounts(w).some((r) => r.total > 0), "per-address counts follow too");
	// The 0025 backfill rewriting addressed_to moves a message's counts to its new address.
	w.db.raw.exec("UPDATE emails SET addressed_to = 'other@mailopus.net' WHERE id = 'c'");
	assertAddressCounts(w);
});

test("Mailbox/set renames and unsubscribes labels, and deleting one moves its only-there mail to Archive", async () => {
	const { call, w, mail } = setup();
	const raw = new TextEncoder().encode("From: x@y.co\r\nSubject: hi\r\nMessage-ID: <q@y.co>\r\n\r\nhello\r\n");
	for (const id of ["m1", "m2"]) {
		await mail.put(`raw/acct/${id}.eml`, raw);
		await ingestEmail(w, { ...(await parseEmail(raw.buffer as ArrayBuffer)), id, blobKey: `raw/acct/${id}.eml`, size: raw.byteLength, receivedAt: 1 });
	}
	w.db.raw.exec("INSERT INTO mailboxes (id, account_id, name, role, uidvalidity) VALUES ('lab', 'acct', 'CLIENTS/WAYNE', NULL, 1), ('lab2', 'acct', 'OLD', NULL, 1)");
	// m1 only in the label; m2 in the label and the Inbox. m1 is unread.
	await call(["Email/set", { accountId: "acct", update: { m1: { mailboxIds: { lab: true } }, m2: { "mailboxIds/lab": true, "keywords/$seen": true } } }, "0"]);

	const [set] = await call(["Mailbox/set", {
		accountId: "acct",
		update: { lab: { name: " CLIENTS / WAYNE JOBS " }, lab2: { name: "CLIENTS/WAYNE JOBS" }, "box-inbox": { name: "Mail" } },
	}, "0"]);
	const s = set![1] as any;
	assert.deepEqual(s.updated, { lab: null });
	assert.equal(s.notUpdated.lab2.type, "invalidProperties", "names are unique");
	assert.equal(s.notUpdated["box-inbox"].type, "forbidden");

	const [sub, get] = await call(
		["Mailbox/set", { accountId: "acct", update: { lab: { isSubscribed: false } } }, "1"],
		["Mailbox/get", { accountId: "acct", ids: ["lab"], properties: ["name", "isSubscribed"] }, "2"],
	);
	assert.deepEqual((sub![1] as any).updated, { lab: null });
	assert.deepEqual((get![1] as any).list[0], { id: "lab", name: "CLIENTS/WAYNE JOBS", isSubscribed: false });

	const [refused] = await call(["Mailbox/set", { accountId: "acct", destroy: ["lab", "box-inbox"] }, "3"]);
	assert.deepEqual([(refused![1] as any).notDestroyed.lab.type, (refused![1] as any).notDestroyed["box-inbox"].type], ["mailboxHasEmail", "forbidden"]);

	const before = (await call(["Email/changes", { accountId: "acct", sinceState: "0" }, "c"]))[0]![1] as any;
	const [del] = await call(["Mailbox/set", { accountId: "acct", destroy: ["lab"], onDestroyRemoveEmails: true }, "4"]);
	assert.deepEqual((del![1] as any).destroyed, ["lab"]);
	const [boxes, ch] = await call(
		["Email/get", { accountId: "acct", ids: ["m1", "m2"], properties: ["mailboxIds"] }, "g"],
		["Email/changes", { accountId: "acct", sinceState: before.newState }, "c"],
	);
	assert.deepEqual((boxes![1] as any).list.map((e: any) => Object.keys(e.mailboxIds)), [["box-archive"], ["box-inbox"]]);
	assert.deepEqual((ch![1] as any).updated.sort(), ["m1", "m2"]);
	const archive = w.db.raw.prepare("SELECT total_emails AS t, unread_emails AS u, uidnext FROM mailboxes WHERE id = 'box-archive'").get() as any;
	assert.deepEqual({ ...archive }, { t: 1, u: 1, uidnext: 2 });
	assert.equal(w.db.raw.prepare("SELECT count(*) AS n FROM mailboxes WHERE id = 'lab'").get()!.n, 0);
	// The set-based move to Archive and the deleted label's rows both reach mailbox_counts.
	assertAddressCounts(w);
	assert.equal(w.db.raw.prepare("SELECT count(*) AS n FROM mailbox_counts WHERE mailbox_id = 'lab'").get()!.n, 0);
});

test("Mailbox/set creates labels, and refuses a taken or empty name, a role, and a limited app password", async () => {
	const { call, w, mail, ctx } = setup();
	const raw = new TextEncoder().encode("From: x@y.co\r\nSubject: hi\r\nMessage-ID: <q@y.co>\r\n\r\nhello\r\n");
	await mail.put("raw/acct/m1.eml", raw);
	await ingestEmail(w, { ...(await parseEmail(raw.buffer as ArrayBuffer)), id: "m1", blobKey: "raw/acct/m1.eml", size: raw.byteLength, receivedAt: 1 });

	const [set, get] = await call(
		["Mailbox/set", { accountId: "acct", create: {
			a: { name: " Clients / Wayne ", role: null, parentId: null },
			dup: { name: "Clients/Wayne" },
			inbox: { name: "Inbox" },
			cased: { name: "INBOX" },
			empty: { name: " / " },
			none: {},
			long: { name: "x".repeat(256) },
			role: { name: "More trash", role: "trash" },
			child: { name: "Kid", parentId: "box-inbox" },
		} }, "0"],
		["Mailbox/get", { accountId: "acct", properties: ["name", "role", "totalEmails", "isSubscribed"] }, "1"],
	);
	const s = set![1] as any;
	assert.deepEqual(Object.keys(s.created), ["a"]);
	const id = s.created.a.id as string;
	assert.match(id, /^[0-9a-f]{32}$/);
	assert.equal(s.created.a.name, "Clients/Wayne", "the answer carries the name as stored");
	assert.equal(Number(s.newState), Number(s.oldState) + 1, "one state step for the one label made");
	assert.deepEqual(Object.fromEntries(Object.entries(s.notCreated).map(([k, e]: [string, any]) => [k, e.properties])), {
		dup: ["name"], inbox: ["name"], cased: ["name"], empty: ["name"], none: ["name"], long: ["name"], role: ["role"], child: ["parentId"],
	});
	assert.deepEqual((get![1] as any).list.find((b: any) => b.id === id), { id, name: "Clients/Wayne", role: null, totalEmails: 0, isSubscribed: true });
	assert.equal((get![1] as any).state, s.newState);
	const row = w.db.raw.prepare("SELECT role, uidvalidity, uidnext, total_emails AS t, unread_emails AS u FROM mailboxes WHERE id = ?").get(id) as any;
	assert.deepEqual([row.role, row.uidnext, row.t, row.u], [null, 1, 0, 0]);
	assert.ok(row.uidvalidity > 1_600_000_000, "uidvalidity is the creation time in seconds, as for an imported label");

	// Mail moved in is counted, on the mailbox and per address.
	await call(["Email/set", { accountId: "acct", update: { m1: { mailboxIds: { [id]: true } } } }, "2"]);
	const counted = w.db.raw.prepare(COUNTS_SQL).all("acct") as { id: string; total: number; unread: number; stored_total: number; stored_unread: number }[];
	const mine = counted.find((r) => r.id === id)!;
	assert.deepEqual([mine.stored_total, mine.stored_unread, mine.total, mine.unread], [1, 1, 1, 1]);
	assert.equal(assertAddressCounts(w).filter((r) => r.mailbox_id === id).length, 1);

	// A refused create changes nothing, state included.
	const [no] = await call(["Mailbox/set", { accountId: "acct", create: { x: { name: "Clients/Wayne" } } }, "3"]);
	assert.equal((no![1] as any).newState, (no![1] as any).oldState);
	assert.equal((no![1] as any).created, null);

	ctx.scope = ["@acme.test"];
	const [scoped] = await call(["Mailbox/set", { accountId: "acct", create: { x: { name: "Mine" } } }, "4"]);
	assert.deepEqual([scoped![0], (scoped![1] as any).type], ["error", "forbidden"]);
	assert.equal(w.db.raw.prepare("SELECT count(*) AS n FROM mailboxes WHERE name = 'Mine'").get()!.n, 0);
});

test("Email/query narrows a mailbox to some of your addresses, on the fast path and off it", async () => {
	const { call, w, mail, db } = setup();
	db.raw.exec("INSERT INTO identities (id, account_id, name, email) VALUES ('i2', 'acct', 'Me', 'me@acme.test')");
	for (const [id, to] of [["h1", "me@acme.test"], ["m1", "me@mailopus.net"]] as const) {
		const raw = new TextEncoder().encode(`From: x@y.co\r\nTo: ${to}\r\nSubject: ${id}\r\nMessage-ID: <${id}@y.co>\r\n\r\nhi\r\n`);
		await mail.put(`raw/acct/${id}.eml`, raw);
		await ingestEmail(w, { ...(await parseEmail(raw.buffer as ArrayBuffer)), id, blobKey: `raw/acct/${id}.eml`, size: raw.byteLength, receivedAt: id === "h1" ? 2 : 1 });
	}
	const [fast, slow, none] = await call(
		["Email/query", { accountId: "acct", filter: { inMailbox: "box-inbox", addressedTo: ["@acme.test"] } }, "f"],
		["Email/query", { accountId: "acct", filter: { inMailbox: "box-inbox", addressedTo: ["me@mailopus.net"] }, calculateTotal: true }, "s"],
		["Email/query", { accountId: "acct", filter: { inMailbox: "box-inbox", addressedTo: [] } }, "n"],
	);
	assert.deepEqual([(fast![1] as any).ids, (slow![1] as any).ids, (none![1] as any).ids], [["h1"], ["m1"], []]);
});
