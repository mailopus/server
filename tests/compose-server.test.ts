// Run: pnpm test
// Compose on the server: attachments and inline images, live blocks (AMP), scheduled sends,
// signatures, and the autocomplete ranking.
import assert from "node:assert/strict";
import { test } from "node:test";
import PostalMime from "postal-mime";
import { dispatch } from "../server/lib/jmap/core.ts";
import { type Ctx, mailMethods } from "../server/lib/jmap/mail.ts";
import { emailSet, holdUntil, sendDue, submissionSet } from "../server/lib/jmap/write.ts";
import { buildMime } from "../server/lib/mime.ts";
import { render, renderLive } from "../server/lib/amp.ts";
import { uploadKey } from "../server/lib/blobs.ts";
import { contacts } from "../server/lib/contacts.ts";
import { savePending, takePending } from "../server/lib/swiftly-connect.ts";
import { testD1 } from "./d1.ts";

const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];

function memR2() {
	const store = new Map<string, { v: Uint8Array; type?: string; meta?: Record<string, string> }>();
	return {
		store,
		put: async (k: string, v: Uint8Array | string, o?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }) =>
			void store.set(k, { v: typeof v === "string" ? new TextEncoder().encode(v) : v, type: o?.httpMetadata?.contentType, meta: o?.customMetadata }),
		get: async (k: string) => {
			const e = store.get(k);
			return e ? {
				text: async () => new TextDecoder().decode(e.v),
				arrayBuffer: async () => e.v.buffer.slice(e.v.byteOffset, e.v.byteOffset + e.v.byteLength),
				httpMetadata: { contentType: e.type }, customMetadata: e.meta,
			} : null;
		},
		delete: async (k: string) => void store.delete(k),
	} as unknown as R2Bucket;
}

function setup() {
	const db = testD1();
	const mail = memR2();
	const sent: { to: string; raw: string }[] = [];
	const w = { db, mail, account: "acct", fetchJson: async () => ({ status: "shipped", eta: { day: "Friday" } }) };
	const send = async (_from: string, to: string, raw: string) => {
		sent.push({ to, raw });
		return `p${sent.length}@mailopus.net`;
	};
	const ctx: Ctx = {
		db, mail, accounts: new Set(["acct"]), createdIds: {},
		writer: () => ({
			emailSet: (_a, args, ids) => emailSet(w, args, ids) as never,
			submit: (_a, args, ids) => submissionSet(w, args, ids, send) as never,
		}),
	};
	const call = async (...calls: [string, Record<string, unknown>, string][]) => {
		ctx.createdIds = {};
		return Object.fromEntries((await dispatch({ using: USING, methodCalls: calls }, mailMethods, ctx)).methodResponses.map(([n, a, id]) => [`${id}:${n}`, a as any]));
	};
	return { db, mail, w, sent, send, call };
}

const draft = (extra: Record<string, unknown> = {}) => ({
	mailboxIds: { "box-drafts": true },
	keywords: { $draft: true, $seen: true },
	from: [{ name: "Me", email: "me@mailopus.net" }],
	to: [{ name: "Ann", email: "ann@example.com" }],
	subject: "Hi",
	bodyValues: { t: { value: "Body" }, h: { value: "<p>Body</p>" } },
	textBody: [{ partId: "t", type: "text/plain" }],
	htmlBody: [{ partId: "h", type: "text/html" }],
	...extra,
});

test("buildMime nests related and mixed only when needed, and AMP sits before html", async () => {
	const base = { from: [{ email: "a@b.co" }], messageId: "x@b.co", date: new Date(0), text: "t", html: '<p>t <img src="cid:img1"></p>' };
	const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
	const raw = buildMime({ ...base, amp: "<p>amp</p>", attachments: [
		{ name: "dot.png", type: "image/png", content: png, cid: "img1" },
		{ name: "Grüße.pdf", type: "application/pdf", content: new Uint8Array(200).fill(65) },
	] });
	assert.match(raw, /multipart\/mixed[\s\S]*multipart\/related[\s\S]*multipart\/alternative/);
	assert.ok(raw.indexOf("text/x-amp-html") < raw.indexOf("text/html"));
	assert.match(raw, /filename\*=UTF-8''Gr%C3%BC%C3%9Fe\.pdf/);
	const m = await PostalMime.parse(raw);
	assert.equal(m.html, '<p>t <img src="cid:img1"></p>');
	const inline = m.attachments.find((a) => a.contentId === "<img1>");
	assert.deepEqual(new Uint8Array(inline!.content as ArrayBuffer), png);
	assert.equal(m.attachments.find((a) => a.mimeType === "application/pdf")?.filename, "Grüße.pdf");
	// Plain text with nothing attached is still a single part.
	assert.doesNotMatch(buildMime({ from: [{ email: "a@b.co" }], messageId: "y@b.co", date: new Date(0), text: "t" }), /multipart/);
});

test("live blocks render a snapshot everywhere and an amp-list in the AMP part", async () => {
	assert.equal(render("{{status}} by {{eta.day}}{{missing}}", { status: "shipped", eta: { day: "Fri" } }), "shipped by Fri");
	const r = await renderLive({
		text: "Hello\n\n```live\nhttps://x.test/o.json\nOrder is {{status}}\n```\n",
		html: '<p>Hello</p><pre><code class="language-live">https://x.test/o.json\nOrder is {{status}} &amp; &lt;b&gt;</code></pre>',
	}, async () => ({ status: "<shipped>" }));
	assert.equal(r.text, "Hello\n\nOrder is <shipped>\n");
	assert.match(r.html!, /<div class="live">Order is &lt;shipped&gt; &amp; &lt;b&gt;<\/div>/);
	assert.match(r.amp!, /^<!doctype html><html ⚡4email/);
	assert.match(r.amp!, /<amp-list src="https:\/\/x.test\/o.json"[^>]*><template type="amp-mustache">Order is \{\{status\}\} &amp; &lt;b&gt;<\/template><div fallback>/);
	// No blocks, no AMP. A non-https URL isn't a live block.
	assert.equal((await renderLive({ text: "x", html: "<p>x</p>" })).amp, undefined);
	assert.equal((await renderLive({ text: "", html: '<pre><code class="language-live">http://x.test\n{{a}}</code></pre>' })).amp, undefined);
	// Something AMP can't carry means no AMP part; the html still gets its snapshot.
	const withForm = await renderLive({ text: "", html: '<form></form><pre><code class="language-live">https://x.test\n{{a}}</code></pre>' }, async () => ({ a: 1 }));
	assert.equal(withForm.amp, undefined);
	assert.match(withForm.html!, /<div class="live">1<\/div>/);
});

test("Email/set attaches uploads and parts of stored mail, inline by cid", async () => {
	const { call, mail, sent } = setup();
	await mail.put(uploadKey("acct", `u${"a".repeat(32)}`), new Uint8Array([1, 2, 3]), { httpMetadata: { contentType: "image/png" }, customMetadata: { name: "pic.png" } });
	const first = await call(["Email/set", { accountId: "acct", create: { d: draft({ attachments: [{ blobId: `u${"a".repeat(32)}` }] }) } }, "1"]);
	const firstId = first["1:Email/set"].created.d.id;
	// A forward carries the first message's attachment by its blobId, and an inline image by cid.
	const r = await call(
		["Email/set", { accountId: "acct", create: { d: draft({
			bodyValues: { t: { value: "fwd" }, h: { value: '<img src="cid:c1">' } },
			attachments: [{ blobId: `${firstId}_0`, name: "again.png" }, { blobId: `u${"a".repeat(32)}`, cid: "c1" }],
		}) } }, "2"],
		["EmailSubmission/set", { accountId: "acct", create: { s: { identityId: "ident", emailId: "#d" } } }, "3"],
	);
	assert.ok(r["2:Email/set"].created.d);
	const m = await PostalMime.parse(sent[0]!.raw);
	assert.deepEqual(m.attachments.map((a) => [a.filename, a.contentId ?? null]), [["pic.png", "<c1>"], ["again.png", null]]);
	const missing = await call(["Email/set", { accountId: "acct", create: { d: draft({ attachments: [{ blobId: `u${"b".repeat(32)}` }] }) } }, "4"]);
	assert.equal(missing["4:Email/set"].notCreated.d.type, "blobNotFound");
});

test("holdUntil reads HOLDUNTIL and HOLDFOR, sends short holds now, refuses junk", () => {
	const now = Date.parse("2026-11-06T12:00:00Z");
	const env = (p: Record<string, unknown>) => ({ mailFrom: { email: "me@x", parameters: p } });
	assert.equal(holdUntil(undefined, now), null);
	assert.equal(holdUntil(env({ HOLDUNTIL: "2026-11-07T08:00:00Z" }), now), Date.parse("2026-11-07T08:00:00Z"));
	assert.equal(holdUntil(env({ holdfor: "3600" }), now), now + 3_600_000);
	assert.equal(holdUntil(env({ HOLDFOR: "5" }), now), null);
	assert.equal(typeof holdUntil(env({ HOLDUNTIL: "soon" }), now), "string");
	assert.equal(typeof holdUntil(env({ HOLDUNTIL: "2030-01-01T00:00:00Z" }), now), "string");
});

test("a held send waits in Scheduled, goes out when due, and can be canceled back to Drafts", async () => {
	const { call, w, sent, send, db } = setup();
	const at = new Date(Date.now() + 3_600_000).toISOString();
	const submit = (cid: string) => call(
		["Email/set", { accountId: "acct", create: { d: draft() } }, "c"],
		["EmailSubmission/set", {
			accountId: "acct",
			create: { s: { identityId: "ident", emailId: "#d", envelope: { mailFrom: { email: "me@mailopus.net", parameters: { HOLDUNTIL: at } }, rcptTo: null } } },
			onSuccessUpdateEmail: { "#s": { "mailboxIds/box-drafts": null, "mailboxIds/box-scheduled": true } },
		}, cid],
	);
	const r = await submit("s");
	const sub = r["s:EmailSubmission/set"].created.s;
	assert.equal(sub.undoStatus, "pending");
	assert.equal(sub.sendAt, at);
	assert.equal(sent.length, 0);
	const emailId = r["c:Email/set"].created.d.id;
	const boxes = async (id: string) => (await db.prepare("SELECT mailbox_id FROM email_mailboxes WHERE email_id = ?").bind(id).all<{ mailbox_id: string }>()).results.map((x) => x.mailbox_id);
	assert.deepEqual(await boxes(emailId), ["box-scheduled"]);
	const listed = await call(["EmailSubmission/get", { accountId: "acct", ids: null }, "g"]);
	assert.equal(listed["g:EmailSubmission/get"].list[0].emailId, emailId);

	assert.equal(await sendDue(w, send, Date.now()), Date.parse(at)); // not due yet
	assert.equal(sent.length, 0);
	assert.equal(await sendDue(w, send, Date.parse(at)), null);
	assert.deepEqual(sent.map((s) => s.to), ["ann@example.com"]);
	assert.deepEqual(await boxes(emailId), ["box-sent"]);

	const second = await submit("s2");
	const id2 = second["s2:EmailSubmission/set"].created.s.id;
	const cancel = await call(["EmailSubmission/set", { accountId: "acct", update: { [id2]: { undoStatus: "canceled" } } }, "x"]);
	assert.deepEqual(cancel["x:EmailSubmission/set"].updated, { [id2]: null });
	assert.deepEqual(await boxes(second["c:Email/set"].created.d.id), ["box-drafts"]);
	const again = await call(["EmailSubmission/set", { accountId: "acct", update: { [id2]: { undoStatus: "canceled" } } }, "y"]);
	assert.equal(again["y:EmailSubmission/set"].notUpdated[id2].type, "cannotUnsend");
});

test("Swiftly sync: Mailopus reports the signature, stores what Swiftly writes, acks it, and keeps the token", async () => {
	const { call, db } = setup();
	const bad = await call(["Identity/set", { accountId: "acct", update: { ident: { signatureProvider: { name: "swiftly" } } } }, "1"]);
	assert.match(bad["1:Identity/set"].notUpdated.ident.description, /token/);

	const real = globalThis.fetch;
	const calls: { path: string; auth: string; body: any }[] = [];
	let answer: object = { action: "write", html: "<p>Me</p><div data-swiftly>Swiftly<br>sig</div>", hash: "h1" };
	const hosts = new Set<string>();
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		hosts.add(new URL(url).host);
		calls.push({ path: new URL(url).pathname, auth: (init.headers as Record<string, string>).authorization, body: JSON.parse(String(init.body)) });
		return new Response(JSON.stringify(new URL(url).pathname.endsWith("/applied") ? { recorded: "ok" } : answer));
	}) as typeof fetch;
	try {
		// Turning it on with your own signature: Swiftly sees yours, answers with the whole signature.
		await call(["Identity/set", { accountId: "acct", update: { ident: { textSignature: "Me", htmlSignature: "<p>Me</p>", signatureProvider: { name: "swiftly", token: "swa_secret", block: "main", base: "https://evil.example" } } } }, "2"]);
		assert.deepEqual(calls.map((c) => c.path), ["/api/agent/compose", "/api/agent/applied"]);
		assert.deepEqual([...hosts], ["swiftly.biz"], "a client can't choose where the token and signature are sent");
		assert.deepEqual(calls[0]!.body, { address: "me@mailopus.net", reported: "<p>Me</p>", block: "main" });
		assert.equal(calls[0]!.auth, "Bearer swa_secret");
		assert.deepEqual(calls[1]!.body, { address: "me@mailopus.net", hash: "h1", status: "ok", readBack: "<p>Me</p><div data-swiftly>Swiftly<br>sig</div>", block: "main" });

		const got = await call(["Identity/get", { accountId: "acct" }, "g"]);
		const i = got["g:Identity/get"].list[0];
		assert.equal(i.htmlSignature, "<p>Me</p><div data-swiftly>Swiftly<br>sig</div>");
		assert.equal(i.textSignature, "Me\nSwiftly\nsig");
		assert.equal(i.signatureStatus, null);
		assert.deepEqual(i.signatureProvider, { name: "swiftly", block: "main" });
		assert.doesNotMatch(JSON.stringify(got), /swa_secret/);

		// A refusal leaves the signature alone and says why. Sync now keeps the stored token.
		answer = { action: "refuse", reason: "outside-edit", message: "Someone changed this signature outside Swiftly." };
		await call(["Identity/set", { accountId: "acct", update: { ident: { signatureProvider: { name: "swiftly" } } } }, "3"]);
		assert.equal(calls.at(-1)!.auth, "Bearer swa_secret");
		const after = (await call(["Identity/get", { accountId: "acct" }, "g"]))["g:Identity/get"].list[0];
		assert.equal(after.signatureStatus, "Someone changed this signature outside Swiftly.");
		assert.equal(after.htmlSignature, "<p>Me</p><div data-swiftly>Swiftly<br>sig</div>");

		// The cron syncs only identities that are due, and a dead Swiftly becomes a status, not a throw.
		const { syncDue } = await import("../server/lib/signatures.ts");
		const n = calls.length;
		assert.equal(await syncDue(db, 30 * 60_000), 0);
		globalThis.fetch = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
		assert.equal(await syncDue(db, 30 * 60_000, Date.now() + 31 * 60_000), 1);
		assert.equal(calls.length, n);
		const down = (await call(["Identity/get", { accountId: "acct" }, "g"]))["g:Identity/get"].list[0];
		assert.match(down.signatureStatus, /Couldn't sync with Swiftly: Swiftly returned 503/);
	} finally {
		globalThis.fetch = real;
	}
	const off = await call(["Identity/set", { accountId: "acct", update: { ident: { signatureProvider: null } } }, "4"]);
	assert.deepEqual(off["4:Identity/set"].updated, { ident: null });
});

test("autocomplete ranks people you wrote to above people who wrote to you, and skips you", async () => {
	const { call, db } = setup();
	const make = (box: string, from: string, to: string) => draft({ mailboxIds: { [box]: true }, from: [{ name: "", email: from }], to: [{ name: "", email: to }] });
	await call(["Email/set", { accountId: "acct", create: {
		a: make("box-sent", "me@mailopus.net", "ann@example.com"),
		b: make("box-inbox", "bob@example.com", "me@mailopus.net"),
		c: make("box-inbox", "bob@example.com", "me@mailopus.net"),
		d: make("box-inbox", "Ann@Example.com", "me@mailopus.net"),
	} }, "1"]);
	const list = await contacts(db, "acct");
	assert.deepEqual(list.map((c) => [c.email, c.score]), [["ann@example.com", 4], ["bob@example.com", 2]]);
});

test("Connect Swiftly: PKCE pair, code exchange, and one connection covering every address", async () => {
	const { pkce, authorizeUrl, exchange, saveConnection, connectionInfo } = await import("../server/lib/swiftly-connect.ts");
	const { verifier, challenge, state } = await pkce();
	assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
	const expect = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
	assert.equal(challenge, expect);
	const url = new URL(authorizeUrl("https://app.mailopus.net/api/swiftly/callback", state, challenge));
	assert.equal(url.origin + url.pathname, "https://swiftly.biz/connect");
	assert.equal(url.searchParams.get("code_challenge_method"), "S256");
	assert.equal(url.searchParams.get("client"), "mailopus");

	const { db, call } = setup();
	db.raw.prepare("INSERT INTO identities (id, account_id, name, email) VALUES ('ident2', 'acct', 'Me', 'me2@mailopus.net')").run();
	const real = globalThis.fetch;
	const seen: { path: string; body: any; auth?: string }[] = [];
	globalThis.fetch = (async (u: string | URL, init: RequestInit) => {
		const path = new URL(u).pathname;
		seen.push({ path, body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).authorization });
		if (path === "/api/agent/token") return new Response(JSON.stringify(seen.at(-1)!.body.code === "good" ? { token: "swa_conn", memberEmail: "me@mailopus.net", org: { id: "o", name: "Acme" } } : { error: "invalid_grant" }), { status: seen.at(-1)!.body.code === "good" ? 200 : 400 });
		if (path === "/api/agent/compose") return new Response(JSON.stringify({ action: "noop", reason: "unchanged" }));
		return new Response("{}");
	}) as typeof fetch;
	try {
		await assert.rejects(exchange("bad", verifier, "https://app.mailopus.net/api/swiftly/callback"), /didn't connect \(400\)/);
		const c = await exchange("good", verifier, "https://app.mailopus.net/api/swiftly/callback");
		assert.deepEqual(seen.at(-1)!.body, { code: "good", code_verifier: verifier, redirect_uri: "https://app.mailopus.net/api/swiftly/callback", client: "mailopus" });
		assert.deepEqual(await saveConnection(db, "acct", c, "all"), { count: 2, failed: 0 });
		// Both addresses synced with the connection's token; none of them stores it.
		assert.deepEqual(seen.filter((x) => x.path === "/api/agent/compose").map((x) => [x.body.address, x.auth]), [["me@mailopus.net", "Bearer swa_conn"], ["me2@mailopus.net", "Bearer swa_conn"]]);
		const got = await call(["Identity/get", { accountId: "acct" }, "g"]);
		assert.deepEqual(got["g:Identity/get"].list.map((i: any) => i.signatureProvider), [{ name: "swiftly" }, { name: "swiftly" }]);
		assert.doesNotMatch(JSON.stringify(got), /swa_conn/);
		assert.equal((await connectionInfo(db, "acct"))!.memberEmail, "me@mailopus.net");
		// With a connection, turning Swiftly on needs no token.
		const r = await call(["Identity/set", { accountId: "acct", update: { ident: { signatureProvider: { name: "swiftly", block: "alt" } } } }, "s"]);
		assert.deepEqual(r["s:Identity/set"].updated, { ident: null });
	} finally {
		globalThis.fetch = real;
	}
});

test("Swiftly connect state: one use, ten minutes, and expired ones get swept", async () => {
	const db = testD1() as unknown as D1Database;
	const p = { verifier: "v", account: "acct", identity: "ident", all: false, base: "https://app.mailopus.net" };
	await savePending(db, "s1", p, 0);
	assert.deepEqual(await takePending(db, "s1", 1000), { ...p, expires: 600_000 });
	assert.equal(await takePending(db, "s1", 1000), null, "a state works once");
	await savePending(db, "s2", p, 0);
	assert.equal(await takePending(db, "s2", 600_001), null, "too late");
	await savePending(db, "s3", p, 0);
	await savePending(db, "s4", p, 600_001);
	const left = await db.prepare("SELECT key FROM instance_settings WHERE key LIKE 'swiftly-connect:%'").all<{ key: string }>();
	assert.deepEqual(left.results.map((r) => r.key), ["swiftly-connect:s4"], "starting a connect sweeps abandoned ones");
});

test("a plugin that acts can stop a send, and a watching one hears about a send that went", async () => {
	const submit = ["EmailSubmission/set", { accountId: "acct", create: { s: { identityId: "ident", emailId: "#d" } } }, "2"] as [string, Record<string, unknown>, string];
	const asked: { host: string; body: any }[] = [];
	const realFetch = globalThis.fetch;
	let answer: unknown = { block: "no mail to Ann today" };
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const host = new URL(String(input)).host;
		asked.push({ host, body: JSON.parse(String(init?.body)) });
		return Response.json(host === "guard.example" ? answer : {});
	}) as typeof fetch;
	try {
		const { db, sent, call } = setup();
		const plugins = [
			{ name: "guard", url: "https://guard.example", key: "k1", events: ["send"], act: true, wants: "body" },
			{ name: "watch", url: "https://watch.example", key: "k2", events: ["send"] },
		];
		db.raw.prepare("INSERT INTO instance_settings (key, value) VALUES ('plugins', ?)").run(JSON.stringify(plugins));
		const stopped = await call(["Email/set", { accountId: "acct", create: { d: draft() } }, "1"], submit);
		assert.equal(sent.length, 0);
		assert.deepEqual(stopped["2:EmailSubmission/set"].notCreated.s, { type: "forbiddenToSend", description: "ann@example.com: stopped by plugin guard: no mail to Ann today" });
		assert.deepEqual(asked.map((a) => a.host), ["guard.example"], "nobody hears about a send that didn't go");
		assert.deepEqual(asked[0]!.body.message, { from: { name: "Me", email: "me@mailopus.net" }, to: ["ann@example.com"], cc: [], subject: "Hi", messageId: asked[0]!.body.message.messageId, date: asked[0]!.body.message.date });
		assert.match(asked[0]!.body.headers, /^Subject: Hi$/m);
		assert.match(asked[0]!.body.body, /Body/);

		answer = {};
		asked.length = 0;
		const went = await call(["Email/set", { accountId: "acct", create: { d: draft() } }, "1"], submit);
		assert.ok(went["2:EmailSubmission/set"].created.s);
		assert.equal(sent.length, 1);
		assert.deepEqual(asked.map((a) => a.host), ["guard.example", "watch.example"]);
		assert.equal(asked[1]!.body.headers, undefined, "the watcher asked for the envelope only");
	} finally {
		globalThis.fetch = realFetch;
	}
});
