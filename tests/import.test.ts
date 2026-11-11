// Run: pnpm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { GMAIL_SCOPE, mapLabels, serviceAccountJwt } from "../server/lib/gmail.ts";
import { runPage } from "../server/lib/importer.ts";
import { importBatch, importEmail } from "../server/lib/jmap/write.ts";
import { parseEmail } from "../server/utils/mail.ts";
import { testD1 } from "./d1.ts";

const enc = (s: string) => new TextEncoder().encode(s.replace(/\n/g, "\r\n"));
const msg = (mid: string, extra = "") => enc(`From: a@x.com\nTo: me@mailopus.net\nSubject: s ${mid}\nMessage-ID: <${mid}@x.com>\n${extra}\nbody ${mid}\n`);

function memR2() {
	const store = new Map<string, Uint8Array>();
	return { store, put: async (k: string, v: ArrayBuffer) => void store.set(k, new Uint8Array(v)), delete: async (k: string) => void store.delete(k) } as unknown as R2Bucket & { store: Map<string, Uint8Array> };
}

test("service-account JWT is RS256-signed with the right claims", async () => {
	const kp = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
	const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", kp.privateKey)).toString("base64");
	const pem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
	const jwt = await serviceAccountJwt({ client_email: "sa@p.iam.gserviceaccount.com", private_key: pem }, "sam@example.net", 1_800_000_000_000);
	const [h, c, sig] = jwt.split(".");
	const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", kp.publicKey, Buffer.from(sig!, "base64url"), new TextEncoder().encode(`${h}.${c}`));
	assert.equal(ok, true);
	const claims = JSON.parse(Buffer.from(c!, "base64url").toString());
	assert.deepEqual([claims.sub, claims.scope, claims.aud, claims.exp - claims.iat], ["sam@example.net", GMAIL_SCOPE, "https://oauth2.googleapis.com/token", 3600]);
});

test("mapLabels: roles, user labels, keywords; spam/trash override", () => {
	assert.deepEqual(mapLabels(["INBOX", "UNREAD", "Label_1", "CATEGORY_UPDATES", "IMPORTANT"], { Label_1: "Clients/Acme" }),
		{ roles: ["inbox"], labels: ["Clients/Acme"], keywords: {} });
	assert.deepEqual(mapLabels(["SENT", "STARRED"], {}), { roles: ["sent"], labels: [], keywords: { $seen: true, $flagged: true } });
	assert.deepEqual(mapLabels(["SPAM", "INBOX", "Label_1"], { Label_1: "x" }).roles, ["junk"]);
	assert.deepEqual(mapLabels([], {}), { roles: [], labels: [], keywords: { $seen: true } }, "no labels = archived");
});

test("importEmail: imports once, skips repeats, merges a twin, creates label mailboxes once", async () => {
	const db = testD1();
	const w = { db, mail: memR2(), account: "acct" };
	const base = async (gid: string, raw: Uint8Array, extra: Record<string, unknown> = {}) => ({
		...(await parseEmail(raw.buffer as ArrayBuffer)), id: crypto.randomUUID(), blobKey: "k", size: 1, receivedAt: 1,
		sourceId: `gmail:me:${gid}`, roles: ["inbox"], labels: ["Clients"], keywords: { $seen: true as const }, threadHint: "t-hint", ...extra,
	});
	const a = await importEmail(w, await base("g1", msg("m1")));
	assert.equal(a.status, "imported");
	assert.equal((await importEmail(w, await base("g1", msg("m1")))).status, "skipped");
	const twin = await importEmail(w, await base("g2", msg("m1"), { roles: ["sent"], labels: [] }));
	assert.deepEqual([twin.status, twin.id], ["merged", a.id]);
	await importEmail(w, await base("g3", msg("m3")));
	const boxes = db.raw.prepare("SELECT b.name FROM email_mailboxes em JOIN mailboxes b ON b.id = em.mailbox_id WHERE em.email_id = ? ORDER BY b.name").all(a.id).map((r: any) => r.name);
	assert.deepEqual(boxes, ["Clients", "Inbox", "Sent"]);
	assert.equal((db.raw.prepare("SELECT count(*) n FROM mailboxes WHERE name = 'Clients'").get() as any).n, 1);
	assert.equal((db.raw.prepare("SELECT thread_id FROM emails WHERE id = ?").get(a.id) as any).thread_id, "t-hint");
});

test("runPage imports a Gmail page, advances the token, and a retried page adds nothing", async () => {
	const db = testD1();
	const mail = memR2();
	const now = Date.now();
	db.raw.prepare("INSERT INTO import_jobs (id, account_id, workspace, source_email, status, created_at, updated_at) VALUES ('j1','acct','test','me@ws.com','running',?,?)").run(now, now);
	const raws: Record<string, Uint8Array> = { a: msg("pa"), b: msg("pb") };
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (url: string) => {
		const u = String(url);
		const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
		if (u.includes("oauth2")) return json({ access_token: "tok", expires_in: 3600 });
		if (u.endsWith("/labels")) return json({ labels: [{ id: "Label_9", name: "Receipts", type: "user" }] });
		if (u.includes("/messages?")) return json({ messages: [{ id: "a" }, { id: "b" }], nextPageToken: "p2" });
		const id = u.match(/messages\/(\w+)\?/)![1]!;
		return json({ id, threadId: `th-${id}`, labelIds: id === "a" ? ["INBOX", "UNREAD"] : ["Label_9"], internalDate: "1700000000000", raw: Buffer.from(raws[id]!).toString("base64url") });
	}) as typeof fetch;
	try {
		const env = {
			DB: db, MAIL: mail,
			GOOGLE_SA_TEST: JSON.stringify({ client_email: "sa@x", private_key: "unused" }),
			ACCOUNT: { idFromName: () => "x", get: () => ({ importBatch: (_a: string, ms: any[]) => importBatch({ db, mail, account: "acct" }, ms) }) },
		} as unknown as Env;
		// Token signing needs a real key; stub the JWT by pre-seeding the token cache via a fake SA key would be noisier,
		// so patch crypto.subtle.importKey/sign just for this call.
		const subtle = crypto.subtle as any;
		const [imp, sign] = [subtle.importKey, subtle.sign];
		subtle.importKey = async (...a: any[]) => (a[0] === "pkcs8" ? {} : imp.apply(subtle, a));
		subtle.sign = async (alg: any, key: any, data: any) => (alg === "RSASSA-PKCS1-v1_5" ? new ArrayBuffer(8) : sign.call(subtle, alg, key, data));
		try {
			assert.equal(await runPage(env, "j1"), true, "more pages");
			db.raw.prepare("UPDATE import_jobs SET page_token = NULL WHERE id = 'j1'").run(); // replay the same page
			await runPage(env, "j1");
		} finally {
			subtle.importKey = imp;
			subtle.sign = sign;
		}
	} finally {
		globalThis.fetch = realFetch;
	}
	const job = db.raw.prepare("SELECT page_token, pages, imported, skipped, failed, labels_json FROM import_jobs WHERE id = 'j1'").get() as any;
	assert.deepEqual([job.page_token, job.pages, job.imported, job.skipped, job.failed], ["p2", 2, 2, 2, 0]);
	assert.equal(JSON.parse(job.labels_json).Label_9, "Receipts");
	assert.equal(mail.store.size, 2, "one blob per message, none left over from the replay");
	const b = db.raw.prepare("SELECT e.keywords_json, e.received_at, group_concat(m.name) boxes FROM emails e JOIN email_mailboxes em ON em.email_id = e.id JOIN mailboxes m ON m.id = em.mailbox_id WHERE e.subject = 's pb'").get() as any;
	assert.deepEqual([b.boxes, b.keywords_json, b.received_at], ["Receipts", '{"$seen":true}', 1700000000000]);
});

test("importBatch: repeats, twins and replies inside one batch behave as if imported one by one", async () => {
	const db = testD1();
	const w = { db, mail: memR2(), account: "acct" };
	const item = async (gid: string, raw: Uint8Array, extra: Record<string, unknown> = {}) => ({
		...(await parseEmail(raw.buffer as ArrayBuffer)), id: crypto.randomUUID(), blobKey: `k-${gid}`, size: 1, receivedAt: 1,
		sourceId: `gmail:me:${gid}`, roles: ["inbox"], labels: [], keywords: {}, threadHint: `hint-${gid}`, ...extra,
	});
	const res = await importBatch(w, [
		await item("g1", msg("m1")),
		await item("g1", msg("m1")), // same Gmail message again
		await item("g2", msg("m1"), { roles: ["sent"] }), // same Message-ID, other copy
		await item("g3", msg("m3", "In-Reply-To: <m1@x.com>")), // reply in the same batch
	]);
	assert.deepEqual(res.map((r) => r.status), ["imported", "skipped", "merged", "imported"]);
	assert.equal(res[2]!.id, res[0]!.id);
	const t = db.raw.prepare("SELECT id, thread_id FROM emails ORDER BY received_at, id").all() as any[];
	assert.equal(t.length, 2);
	assert.equal(new Set(t.map((r) => r.thread_id)).size, 1, "the reply joined the first message's thread");
	const boxes = db.raw.prepare("SELECT count(*) n FROM email_mailboxes WHERE email_id = ?").get(res[0]!.id) as any;
	assert.equal(boxes.n, 2, "inbox + sent");
});
