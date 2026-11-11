// Run: pnpm test
// The spam engine and how a verdict reaches the mailbox. This repo ships no rules.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Classify, connectingIp, ingestRaw, registrableDomain } from "../server/lib/ingest.ts";
import { type IngestInput, importEmail, ingestEmail, junked } from "../server/lib/jmap/write.ts";
import { parseEmail } from "../server/utils/mail.ts";
import { headerBlock } from "../server/lib/spam/headers.ts";
import { RULES, type Rule, match } from "../server/lib/spam/rules.ts";
import { testD1 } from "./d1.ts";


test("headerBlock keeps header case and unfolds continuations", () => {
	const raw = new TextEncoder().encode(
		"Message-ID: <a@b.co>\r\nReceived: from host\r\n\t(1.2.3.4)\r\nX-Example-Tag: 1\r\n\r\nbody Message-ID: <ignored@x>\r\n",
	);
	const head = headerBlock(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer);
	assert.match(head, /Message-ID:/, "capitalisation survives, so case-sensitive rules still match");
	assert.match(head, /Received: from host \(1\.2\.3\.4\)/, "folded continuation joined onto one line");
	assert.doesNotMatch(head, /ignored/, "body excluded");
});


test("the RDAP lookup happens once per domain, and its absence delivers", async () => {
	const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
	// A domain registered 10 days ago, never written to: junked, and the verdict names the rule.
	{
		const h = harness({ check: async (_hdr: string, ctx: { senderDomainAgeDays?: number; firstContact?: boolean }) =>
			ctx.senderDomainAgeDays !== undefined && ctx.senderDomainAgeDays < 90 && ctx.firstContact ? "new-domain-first-contact" : null },
			{ registration: iso(10) });
		try {
			const raw = message();
			await ingestRaw(h.env, { from: "x@y.co", to: "anyone@mailopus.net", raw: raw.buffer as ArrayBuffer }, h.check);
			assert.equal(h.stored.at(-1)!.spamRule, "new-domain-first-contact");
			const rdapCalls = h.calls.filter((u) => u.includes("www.rdap.net")).length;
			// Pinned to www.rdap.net on purpose: rdap.org answers a Worker with a 403 bot
			// challenge, which the lookup caches as "no date" and the rule then never fires.
			assert.equal(rdapCalls, 1, "one lookup for the first message, against www.rdap.net");
			// Second message, same sender: served from the domain_age cache.
			await ingestRaw(h.env, { from: "x@y.co", to: "anyone@mailopus.net", raw: message().buffer as ArrayBuffer }, h.check);
			assert.equal(h.calls.filter((u) => u.includes("www.rdap.net")).length, 1, "no second lookup");
			assert.equal(h.stored.at(-1)!.spamRule, "new-domain-first-contact");
			const row = h.db.raw.prepare("SELECT key, value FROM sender_facts WHERE key LIKE 'domain:%'").get() as { key: string; value: number };
			assert.equal(row.key, "domain:y.co");
			assert.ok(row.value > 0, "the registration timestamp is cached, not the age");
		} finally { h.restore(); }
	}
	// RDAP rate-limits us: no date, so the rule cannot fire and the message is delivered.
	{
		const h = harness({ check: async (_h: string, ctx: { senderDomainAgeDays?: number }) =>
			ctx.senderDomainAgeDays !== undefined ? "should-not-happen" : null }, { status: 429 });
		try {
			await ingestRaw(h.env, { from: "x@y.co", to: "anyone@mailopus.net", raw: message().buffer as ArrayBuffer }, h.check);
			assert.equal(h.stored.at(-1)!.spamRule, null, "a rate-limited lookup delivers");
			const row = h.db.raw.prepare("SELECT value FROM sender_facts WHERE key = 'domain:y.co'").get() as { value: null };
			assert.equal(row.value, null, "cached as unknown so it is not retried per message");
		} finally { h.restore(); }
	}
});

test("the PTR lookup is cached per IP, and expires so a fixed host is not stuck", async () => {
	const received = "Received: from mail.x.co (203.0.113.9)\r\n\tby cloudflare-email.net (cloudflare) id ABC\r\n\tfor <anyone@mailopus.net>; Fri, 06 Nov 2026 12:00:00 +0000\r\n";
	const h = harness({ check: async (_hdr: string, ctx: { senderHasRdns?: boolean }) => (ctx.senderHasRdns === false ? "sender-without-reverse-dns" : null) });
	// NXDOMAIN for the PTR name: no reverse DNS, which is a known answer worth caching.
	const realFetch = globalThis.fetch;
	const dns: string[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url.includes("dns-query")) { dns.push(url); return Response.json({ Status: 3 }); }
		return new Response("", { status: 404 }); // RDAP: no date, so the age rule cannot fire
	}) as typeof fetch;
	try {
		for (let i = 0; i < 3; i++)
			await ingestRaw(h.env, { from: "x@y.co", to: "anyone@mailopus.net", raw: message(received).buffer as ArrayBuffer }, h.check);
		assert.equal(h.stored.length, 3);
		for (const m of h.stored) assert.equal(m.spamRule, "sender-without-reverse-dns");
		assert.equal(dns.length, 1, "three messages, one PTR lookup");
		assert.ok(dns[0]!.includes("9.113.0.203.in-addr.arpa"), "the name is the reversed IP");
		const row = h.db.raw.prepare("SELECT value FROM sender_facts WHERE key = 'ptr:203.0.113.9'").get() as { value: number };
		assert.equal(row.value, 0, "0 means no PTR record");
		// Age out the cached row: the host may have gained reverse DNS since.
		h.db.raw.prepare("UPDATE sender_facts SET checked_at = ? WHERE key = 'ptr:203.0.113.9'").run(Date.now() - 8 * 86_400_000);
		await ingestRaw(h.env, { from: "x@y.co", to: "anyone@mailopus.net", raw: message(received).buffer as ArrayBuffer }, h.check);
		assert.equal(dns.length, 2, "a week later it is asked again");
	} finally {
		globalThis.fetch = realFetch;
		h.restore();
	}
});

test("registrableDomain finds the part someone actually bought", () => {
	for (const [host, want] of [
		["mail.example.com", "example.com"], ["example.com", "example.com"],
		["a.b.c.example.co.uk", "example.co.uk"], ["acme.co.in", "acme.co.in"],
		["school.sch.id", "school.sch.id"], ["prod.bulk-sender.com", "bulk-sender.com"],
		["fake-leads.email", "fake-leads.email"], ["fake-leads.lol", "fake-leads.lol"],
		// A two-letter TLD that is not a two-level suffix must keep two labels.
		["foo.bar.io", "bar.io"],
	] as const) assert.equal(registrableDomain(host), want, host);
});

test("the engine: every pattern must match, a missing fact never fires, the first rule wins", () => {
	const rules: Rule[] = [
		{ name: "pair", all: [/^X-A: 1$/m, /^X-B: 1$/m] },
		{ name: "context", all: [/^X-C: 1$/m], needs: (c) => c.firstContact === true },
		{ name: "later", all: [/^X-A: 1$/m] },
	];
	assert.equal(match("X-A: 1\nX-B: 1", {}, rules), "pair");
	assert.equal(match("X-B: 1", {}, rules), null, "half a pair is not enough");
	assert.equal(match("X-A: 1", {}, rules), "later");
	assert.equal(match("X-C: 1", { firstContact: true }, rules), "context");
	assert.equal(match("X-C: 1", {}, rules), null, "an unknown fact never fires");
	assert.deepEqual(RULES, [], "this repo ships no rules");
	assert.equal(match("X-A: 1\nX-B: 1"), null);
});

// ---------- wiring: how a verdict reaches the mailbox ----------

const memR2 = () => {
	const store = new Map<string, Uint8Array>();
	return { store, put: async (k: string, v: ArrayBuffer) => void store.set(k, new Uint8Array(v)), delete: async (k: string) => void store.delete(k) } as unknown as R2Bucket & { store: Map<string, Uint8Array> };
};

const message = (extra = "") =>
	new TextEncoder().encode(`From: x@y.co\r\nSubject: hi\r\nMessage-ID: <w1@y.co>\r\n${extra}\r\nhello\r\n`);

/**
 * ingestRaw against an in-memory D1/R2 and a stub Account DO, with whatever classifier we hand it.
 * No classifier means the real rules.
 *
 * fetch is stubbed because the delivery path does a real RDAP lookup for the sender's domain.
 * Tests must not depend on the RDAP service being up, or on what it says about a fixture
 * domain, so
 * `rdap` decides the answer and `calls` records how many lookups actually happened.
 */
function harness(SPAM?: { check: (...a: any[]) => unknown }, rdap?: { registration?: string; status?: number }) {
	const calls: string[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = String(input instanceof Request ? input.url : input);
		calls.push(url);
		if (!rdap) return new Response("not found", { status: 404 });
		if (rdap.status && rdap.status !== 200) return new Response("", { status: rdap.status });
		return Response.json({ events: [{ eventAction: "registration", eventDate: rdap.registration }] });
	}) as typeof fetch;
	const restore = () => void (globalThis.fetch = realFetch);
	const db = testD1();
	const mail = memR2();
	const stored: IngestInput[] = [];
	const env = {
		DB: db, MAIL: mail,
		ACCOUNT: {
			idFromName: (n: string) => n,
			get: () => ({ ingest: async (_a: string, m: IngestInput) => void stored.push(m) ?? { id: m.id } }),
		},
	} as unknown as Env;
	return { env, stored, db, calls, restore, check: SPAM?.check as Classify | undefined };
}

test("junked is true for either signal and false for neither", () => {
	assert.equal(junked({ dmarcFail: false, spamRule: null }), false);
	assert.equal(junked({ dmarcFail: true, spamRule: null }), true);
	assert.equal(junked({ dmarcFail: false, spamRule: "stub-rule" }), true);
});

test("a rule hit lands in Junk and records which rule, a clean message lands in Inbox", async () => {
	for (const [spamRule, box, recorded] of [["stub-rule", "box-junk", "stub-rule"], [null, "box-inbox", null]] as const) {
		const db = testD1();
		const w = { db, mail: memR2(), account: "acct" };
		const raw = message();
		await ingestEmail(w, { ...(await parseEmail(raw.buffer as ArrayBuffer)), id: "m1", blobKey: "k", size: raw.byteLength, receivedAt: 1, spamRule });
		const row = db.raw.prepare("SELECT spam_rule FROM emails WHERE id = 'm1'").get() as { spam_rule: string | null };
		assert.equal(row.spam_rule, recorded, `spam_rule for ${spamRule}`);
		const place = db.raw.prepare("SELECT mailbox_id FROM email_mailboxes WHERE email_id = 'm1'").get() as { mailbox_id: string };
		assert.equal(place.mailbox_id, box, `mailbox for ${spamRule}`);
	}
});

test("a DMARC failure still reaches Junk with no rule recorded", async () => {
	const db = testD1();
	const w = { db, mail: memR2(), account: "acct" };
	const raw = new TextEncoder().encode("Authentication-Results: mx.cloudflare.net; dmarc=fail\r\nFrom: x@y.co\r\nMessage-ID: <d1@y.co>\r\n\r\nhi\r\n");
	await ingestEmail(w, { ...(await parseEmail(raw.buffer as ArrayBuffer)), id: "d1", blobKey: "k", size: raw.byteLength, receivedAt: 1, spamRule: null });
	const row = db.raw.prepare("SELECT spam_rule FROM emails WHERE id = 'd1'").get() as { spam_rule: string | null };
	assert.equal(row.spam_rule, null, "dmarc=fail is not a rule hit");
	const place = db.raw.prepare("SELECT mailbox_id FROM email_mailboxes WHERE email_id = 'd1'").get() as { mailbox_id: string };
	assert.equal(place.mailbox_id, "box-junk");
});

test("the filter fails open: a throw still delivers, and so does having no classifier", async () => {
	for (const [label, SPAM] of [
		["throws", { check: async () => { throw new Error("boom"); } }],
		["no classifier given (no rules here)", undefined],
		["times out", { check: () => Promise.reject(new Error("exceeded cpu")) }],
	] as const) {
		const h = harness(SPAM);
		try {
			const raw = message();
			const result = await ingestRaw(h.env, { from: "x@y.co", to: "anyone@mailopus.net", raw: raw.buffer as ArrayBuffer }, h.check);
			assert.ok(result, `${label}: message still delivered`);
			assert.equal(h.stored.length, 1, `${label}: reached the account`);
			assert.equal(h.stored[0]!.spamRule, null, `${label}: no verdict, so Inbox`);
		} finally { h.restore(); }
	}
});

test("a verdict from the classifier is carried through to the account", async () => {
	const h = harness({ check: async (headers: string) => (headers.includes("X-Example-Tag") ? "stub-rule" : null) });
	try {
		const raw = message("X-Example-Tag: 1\r\n");
		await ingestRaw(h.env, { from: "x@y.co", to: "anyone@mailopus.net", raw: raw.buffer as ArrayBuffer }, h.check);
		assert.equal(h.stored[0]!.spamRule, "stub-rule");
	} finally { h.restore(); }
});

// ---------- context signals ----------

test("the correspondents trigger records everyone you send to", async () => {
	const db = testD1();
	const w = { db, mail: memR2(), account: "acct" };
	const raw = new TextEncoder().encode("From: me@mailopus.net\r\nTo: them@example.com\r\nMessage-ID: <s1@x>\r\n\r\nhi\r\n");
	await importEmail(w, {
		...(await parseEmail(raw.buffer as ArrayBuffer)), id: "s1", blobKey: "k", size: raw.byteLength, receivedAt: 10,
		sourceId: "src1", roles: ["sent"], labels: [], keywords: {}, threadHint: "t1",
	});
	const rows = db.raw.prepare("SELECT address FROM correspondents WHERE account_id = 'acct'").all() as { address: string }[];
	assert.deepEqual(rows.map((r) => r.address), ["them@example.com"], "filing in Sent records the recipient");
});

test("inbound mail does not make someone a correspondent", async () => {
	const db = testD1();
	const w = { db, mail: memR2(), account: "acct" };
	const raw = new TextEncoder().encode("From: them@example.com\r\nTo: me@mailopus.net\r\nMessage-ID: <i1@x>\r\n\r\nhi\r\n");
	await ingestEmail(w, { ...(await parseEmail(raw.buffer as ArrayBuffer)), id: "i1", blobKey: "k", size: raw.byteLength, receivedAt: 1, spamRule: null });
	const n = (db.raw.prepare("SELECT count(*) AS n FROM correspondents").get() as { n: number }).n;
	assert.equal(n, 0, "receiving from someone is not having written to them");
});


test("connectingIp reads the IP out of Cloudflare's own Received header", () => {
	assert.equal(
		connectingIp("Received: from relay.example.net (203.0.113.77) by cloudflare-email.net (cloudflare) id x for <a@b>"),
		"203.0.113.77",
	);
	// Not fooled by an inner hop added by the sender's own provider.
	assert.equal(
		connectingIp("Received: from [10.0.0.1] ([203.0.113.9]) by smtp.gmail.com with ESMTPSA id y"),
		null,
	);
	assert.equal(connectingIp("Received: from mail.google.com (2607:f8b0::1) by cloudflare-email.net"), "2607:f8b0::1");
});

test("a blocked sender lands in Junk with no rules or classifier, and the host form covers subdomains", async () => {
	const msg = (from: string) => new TextEncoder().encode(`From: ${from}\r\nSubject: hi\r\nMessage-ID: <b1@x>\r\n\r\nhello\r\n`);
	const block = (db: D1Database & { raw: { prepare(s: string): { run(...a: unknown[]): unknown } } }, pattern: string) =>
		db.raw.prepare("INSERT INTO blocked_senders (account_id, pattern, created_at) VALUES ('acct', ?, 1)").run(pattern);

	// No rules and no stub: the user's own block must still hold.
	{
		const h = harness(undefined);
		try {
			block(h.db, "editor@members.wayfair.com");
			await ingestRaw(h.env, { from: "x@y", to: "me@mailopus.net", raw: msg("Wayfair <editor@members.wayfair.com>").buffer as ArrayBuffer }, h.check);
			assert.equal(h.stored.at(-1)!.spamRule, "blocked-sender");
			// A different address at the same host is not covered by an address block.
			await ingestRaw(h.env, { from: "x@y", to: "me@mailopus.net", raw: msg("news@members.wayfair.com").buffer as ArrayBuffer }, h.check);
			assert.equal(h.stored.at(-1)!.spamRule, null);
		} finally { h.restore(); }
	}
	// The "@host" form covers the host and its subdomains, and nothing above it.
	{
		const h = harness(undefined);
		try {
			block(h.db, "@members.wayfair.com");
			for (const [from, want] of [
				["editor@members.wayfair.com", "blocked-sender"],
				["any@bmta18.members.wayfair.com", "blocked-sender"],
				// Order mail at a sibling host still arrives: that is the point of blocking the
				// sending host rather than the registrable domain.
				["noreply@service.wayfair.com", null],
				["noreply@wayfair.com", null],
			] as const) {
				await ingestRaw(h.env, { from: "x@y", to: "me@mailopus.net", raw: msg(from).buffer as ArrayBuffer }, h.check);
				assert.equal(h.stored.at(-1)!.spamRule, want, from);
			}
		} finally { h.restore(); }
	}
	// A bare TLD is never a candidate pattern, so a stray "@co" row blocks nothing.
	{
		const h = harness(undefined);
		try {
			block(h.db, "@co");
			await ingestRaw(h.env, { from: "x@y", to: "me@mailopus.net", raw: msg("someone@y.co").buffer as ArrayBuffer }, h.check);
			assert.equal(h.stored.at(-1)!.spamRule, null);
		} finally { h.restore(); }
	}
	// The block is checked before the classifier, so it wins and names itself.
	{
		const h = harness({ check: async () => "stub-rule" });
		try {
			block(h.db, "@members.wayfair.com");
			await ingestRaw(h.env, { from: "x@y", to: "me@mailopus.net", raw: msg("editor@members.wayfair.com").buffer as ArrayBuffer }, h.check);
			assert.equal(h.stored.at(-1)!.spamRule, "blocked-sender");
		} finally { h.restore(); }
	}
});

test("a bound spam Worker decides; if it throws, the built-in rules do (none here, so no verdict)", async () => {
	const raw = message("X-Example-Tag: 1\r\n");
	for (const [label, SPAM, want] of [
		["bound", { check: async () => "from-the-worker" }, "from-the-worker"],
		["throws", { check: async () => { throw new Error("down"); } }, null],
	] as const) {
		const h = harness(undefined);
		try {
			(h.env as unknown as { SPAM: unknown }).SPAM = SPAM;
			await ingestRaw(h.env, { from: "x@y.co", to: "anyone@mailopus.net", raw: raw.buffer as ArrayBuffer });
			assert.equal(h.stored[0]!.spamRule, want, label);
		} finally { h.restore(); }
	}
});

test("remote classifiers: asked after the bound Worker or built-in rules, with the key and headers only, failing open", async () => {
	const URL1 = "https://spam.example/v1/check";
	const URL2 = "https://other.example/check";
	for (const [label, answers, want, asked] of [
		["first verdict wins", { [URL1]: { rule: "remote-rule" }, [URL2]: { rule: "never-asked" } }, "remote-rule", 1],
		["a miss asks the next", { [URL1]: { rule: null }, [URL2]: { rule: "second" } }, "second", 2],
		["errors and odd answers are no verdict", { [URL1]: 500, [URL2]: { rule: 7 } }, null, 2],
	] as const) {
		const h = harness(undefined);
		const seen: { url: string; auth: string | null; body: { headers: string; ctx: unknown } }[] = [];
		const inner = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (!(url in answers)) return inner(input, init);
			seen.push({ url, auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
			const a = answers[url as keyof typeof answers];
			return typeof a === "number" ? new Response("", { status: a }) : Response.json(a);
		}) as typeof fetch;
		try {
			(h.env as unknown as { SPAM_CLASSIFIERS: string }).SPAM_CLASSIFIERS = JSON.stringify([{ url: URL1, key: "k1" }, { url: URL2, key: "k2" }]);
			await ingestRaw(h.env, { from: "x@y.co", to: "anyone@mailopus.net", raw: message().buffer as ArrayBuffer });
			assert.equal(h.stored[0]!.spamRule, want, label);
			assert.equal(seen.length, asked, `${label}: classifiers asked`);
			assert.equal(seen[0]!.auth, "Bearer k1");
			assert.match(seen[0]!.body.headers, /^From: x@y\.co/);
			assert.doesNotMatch(seen[0]!.body.headers, /hello/, "no body");
		} finally { h.restore(); }
	}
	// A bound Worker's verdict never reaches a remote classifier.
	const h = harness(undefined);
	try {
		Object.assign(h.env, { SPAM: { check: async () => "from-the-worker" }, SPAM_CLASSIFIERS: JSON.stringify([{ url: URL1, key: "k1" }]) });
		await ingestRaw(h.env, { from: "x@y.co", to: "anyone@mailopus.net", raw: message().buffer as ArrayBuffer });
		assert.equal(h.stored[0]!.spamRule, "from-the-worker");
		assert.ok(!h.calls.includes(URL1), "not asked");
	} finally { h.restore(); }
	// Malformed config is ignored, not fatal.
	const bad = harness(undefined);
	try {
		(bad.env as unknown as { SPAM_CLASSIFIERS: string }).SPAM_CLASSIFIERS = "not json";
		assert.ok(await ingestRaw(bad.env, { from: "x@y.co", to: "anyone@mailopus.net", raw: message().buffer as ArrayBuffer }));
	} finally { bad.restore(); }
});
