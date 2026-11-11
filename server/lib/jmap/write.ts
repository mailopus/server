// Every mutation of an account's mail: ingest, Email/set, EmailSubmission/set. Runs inside the
// account's Durable Object (one call at a time), and each call commits as one D1 batch.
import PostalMime, { addressParser } from "postal-mime";
import { type ParsedEmail, parseEmail } from "../../utils/mail.ts";
import { MimeError, type Part, buildMime, stripBcc } from "../mime.ts";
import { type Fetcher, renderLive } from "../amp.ts";
import { readBlob } from "../blobs.ts";
import { PROVIDERS, connectionConfig, publicConfig, syncSignature } from "../signatures.ts";
import { KEYWORD } from "./mail.ts";
import { newId } from "../provision.ts";
import { addressedTo } from "../addressed.ts";
import { askPlugins, pluginsFor, tellPlugins, type MailEvent } from "../plugin-hooks.ts";

/** fetchJson is for live blocks (server/lib/amp.ts); tests pass a stub. */
/** env: the Worker's bindings, for plugins reached over a service binding (server/lib/plugin-hooks.ts). */
export type Writer = { db: D1Database; mail: R2Bucket; account: string; fetchJson?: Fetcher; env?: object };
/** Sends one copy; resolves to the Message-ID the provider put on it. */
export type Sender = (from: string, to: string, raw: string) => Promise<string | undefined>;
type SetError = { type: string; description?: string; properties?: string[] };
type Box = { id: string; name: string; role: string | null; uidnext: number };

const MAX_REFS = 50;
const MAX_RECIPIENTS = 50;

/** One write transaction: hands out modseq and uids, collects statements, commits in one batch. */
async function begin(w: Writer) {
	const [acct, boxes, ids] = await w.db.batch([
		w.db.prepare("SELECT modseq FROM accounts WHERE id = ?").bind(w.account),
		w.db.prepare("SELECT id, name, role, uidnext FROM mailboxes WHERE account_id = ?").bind(w.account),
		w.db.prepare("SELECT lower(email) AS email FROM identities WHERE account_id = ?").bind(w.account),
	]);
	const start = (acct!.results[0] as { modseq: number } | undefined)?.modseq;
	if (start === undefined) throw new Error(`unknown account ${w.account}`);
	let modseq = start;
	const mailboxes = new Map((boxes!.results as Box[]).map((b) => [b.id, { ...b }]));
	const touched = new Set<string>();
	const stmts: D1PreparedStatement[] = [];
	// Per-mailbox count changes, flushed in commit(). Every placement change goes through place()/unplace()
	// so the stored counts can't drift from the rows.
	const counts = new Map<string, { total: number; unread: number }>();
	const count = (box: string, total: number, unread: number) => {
		const c = counts.get(box) ?? { total: 0, unread: 0 };
		c.total += total;
		c.unread += unread;
		counts.set(box, c);
	};
	return {
		start,
		mailboxes,
		/** Your addresses, lowercased, for emails.addressed_to. */
		mine: new Set((ids!.results as { email: string }[]).map((r) => r.email)),
		stmts,
		get modseq() { return modseq; },
		next: () => ++modseq,
		/** A role-less mailbox by name, created in this transaction if missing (imported Gmail labels). */
		mailboxNamed(name: string) {
			for (const b of mailboxes.values()) if (!b.role && b.name === name) return b.id;
			const id = newId();
			stmts.push(w.db.prepare("INSERT INTO mailboxes (id, account_id, name, role, uidvalidity) VALUES (?, ?, ?, NULL, ?)").bind(id, w.account, name, Math.floor(Date.now() / 1000)));
			mailboxes.set(id, { id, name, role: null, uidnext: 1 });
			touched.add(id);
			return id;
		},
		uid(boxId: string) {
			const box = mailboxes.get(boxId)!;
			touched.add(boxId);
			return box.uidnext++;
		},
		/** Puts an email in a mailbox: new uid, its date for the newest-first index, and the counts. */
		place(emailId: string, boxId: string, receivedAt: number, unseen: boolean) {
			const uid = this.uid(boxId);
			stmts.push(w.db.prepare("INSERT INTO email_mailboxes (email_id, mailbox_id, uid, received_at) VALUES (?, ?, ?, ?)").bind(emailId, boxId, uid, receivedAt));
			count(boxId, 1, unseen ? 1 : 0);
		},
		/** n uids in a row for one set-based insert; returns the first. */
		reserve(boxId: string, n: number) {
			const box = mailboxes.get(boxId)!;
			touched.add(boxId);
			const first = box.uidnext;
			box.uidnext += n;
			return first;
		},
		/** Count changes from a set-based statement, which place()/unplace() don't see. */
		adjust: count,
		unplace(emailId: string, boxId: string, unseen: boolean) {
			stmts.push(w.db.prepare("DELETE FROM email_mailboxes WHERE email_id = ? AND mailbox_id = ?").bind(emailId, boxId));
			count(boxId, -1, unseen ? -1 : 0);
		},
		/** The email's read state flipped while it stays in these mailboxes. */
		unreadChanged(boxIds: string[], nowUnseen: boolean) {
			for (const b of boxIds) count(b, 0, nowUnseen ? 1 : -1);
		},
		async commit() {
			if (modseq === start) return;
			for (const id of touched) stmts.push(w.db.prepare("UPDATE mailboxes SET uidnext = ? WHERE id = ?").bind(mailboxes.get(id)!.uidnext, id));
			for (const [id, c] of counts) {
				if (c.total || c.unread) stmts.push(w.db.prepare("UPDATE mailboxes SET total_emails = total_emails + ?, unread_emails = unread_emails + ? WHERE id = ?").bind(c.total, c.unread, id));
			}
			stmts.push(w.db.prepare("UPDATE accounts SET modseq = ? WHERE id = ?").bind(modseq, w.account));
			await w.db.batch(stmts);
		},
	};
}
type Tx = Awaited<ReturnType<typeof begin>>;

// ponytail: joins a thread only when a referenced message is already stored; a parent arriving
// after its reply starts a second thread.
async function threadFor(w: Writer, refs: string[]): Promise<string>;
async function threadFor(w: Writer, refs: string[], fresh: false): Promise<string | null>;
async function threadFor(w: Writer, refs: string[], fresh = true) {
	const ids = refs.slice(0, MAX_REFS);
	// Numbered parameters bind each id once: D1 allows 100 per query, and binding the list twice went over.
	const marks = ids.map((_, i) => `?${i + 2}`).join(",");
	const row = ids.length
		? await w.db.prepare(
				`SELECT thread_id FROM emails WHERE account_id = ?1 AND message_id IN (${marks})
				UNION ALL SELECT thread_id FROM sent_message_ids WHERE account_id = ?1 AND message_id IN (${marks}) LIMIT 1`,
			).bind(w.account, ...ids).first<{ thread_id: string }>()
		: null;
	return row?.thread_id ?? (fresh ? crypto.randomUUID() : null);
}

function insertEmail(w: Writer, tx: Tx, e: {
	id: string; blobKey: string; parsed: ParsedEmail; size: number; receivedAt: number;
	threadId: string; mailboxIds: string[]; keywords: Record<string, true>; sourceId?: string;
	/** Name of the spam rule that filed this in Junk, for auditing false positives. */
	spamRule?: string | null;
}) {
	const modseq = tx.next();
	const p = e.parsed;
	const addresses = [...p.from, ...p.to, ...p.cc].map((a) => `${a.name} ${a.email}`).join(" ");
	tx.stmts.push(
		w.db.prepare(
			`INSERT INTO emails (id, account_id, thread_id, blob_key, message_id, subject, from_json, to_json, cc_json,
				sent_at, received_at, size, preview, has_attachment, auth_results, keywords_json, created_modseq, updated_modseq, source_id, delivered_json, spam_rule, addressed_to)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			e.id, w.account, e.threadId, e.blobKey, p.messageId, p.subject,
			JSON.stringify(p.from), JSON.stringify(p.to), JSON.stringify(p.cc),
			p.sentAt, e.receivedAt, e.size, p.preview, p.hasAttachment ? 1 : 0, p.authResults,
			JSON.stringify(e.keywords), modseq, modseq, e.sourceId ?? null, JSON.stringify(p.deliveredTo ?? []), e.spamRule ?? null,
			addressedTo(tx.mine, p) ?? "",
		),
		w.db.prepare("INSERT INTO emails_fts (email_id, subject, addresses, body) VALUES (?, ?, ?, ?)").bind(e.id, p.subject ?? "", addresses, p.body),
	);
	for (const box of e.mailboxIds) tx.place(e.id, box, e.receivedAt, !e.keywords.$seen);
	return modseq;
}

// ---------- ingest ----------

export type IngestInput = ParsedEmail & {
	id: string; blobKey: string; size: number; receivedAt: number;
	/** Rule name from the spam rules, or null when none matched or classifying failed. */
	spamRule?: string | null;
	/** Keywords a plugin asked for, such as $seen (server/lib/plugin-hooks.ts). */
	keywords?: Record<string, true>;
};

/**
 * Whether this message belongs in Junk rather than Inbox. Two independent signals: failed
 * authentication, and a cold-email fingerprint from the spam rules. One place so the role
 * decision and the push suppression in the Account DO cannot drift apart.
 */
export const junked = (m: { dmarcFail: boolean; spamRule?: string | null }) => m.dmarcFail || !!m.spamRule;

export async function ingestEmail(w: Writer, m: IngestInput) {
	const tx = await begin(w);
	const role = junked(m) ? "junk" : "inbox";
	const box = [...tx.mailboxes.values()].find((b) => b.role === role);
	if (!box) throw new Error(`account ${w.account} has no ${role} mailbox`);
	const uid = box.uidnext;
	// Its own Message-ID too: mail you send to yourself comes back carrying the provider's id for your
	// sent copy (recorded in sent_message_ids), and belongs in that thread.
	const threadId = await threadFor(w, m.messageId ? [m.messageId, ...m.refs] : m.refs);
	insertEmail(w, tx, { id: m.id, blobKey: m.blobKey, parsed: m, size: m.size, receivedAt: m.receivedAt, threadId, mailboxIds: [box.id], keywords: m.keywords ?? {}, spamRule: m.spamRule });
	await tx.commit();
	return { id: m.id, threadId, mailboxId: box.id, uid, modseq: tx.modseq };
}

// ---------- import ----------

export type ImportInput = IngestInput & {
	/** Stable id at the source ("gmail:<user>:<id>"); a repeat is skipped. */
	sourceId: string;
	/** Role mailboxes to file it in ("inbox", "sent", ...). Empty plus no labels means archive. */
	roles: string[];
	/** Role-less mailboxes by name (Gmail user labels), created if missing. */
	labels: string[];
	keywords: Record<string, true>;
	/** Thread to use when no stored message links it to an existing one (Gmail's thread, hashed). */
	threadHint: string;
};

/**
 * Stores one imported message. Returns "skipped" for a repeat of the same source message, and
 * "merged" when another copy (same Message-ID) is already stored, e.g. the same email in two of your
 * Workspace mailboxes: that copy gains this one's mailboxes instead of a duplicate being stored.
 */
export async function importEmail(w: Writer, m: ImportInput) {
	return (await importBatch(w, [m]))[0]!;
}

// D1 allows 100 bound parameters per statement; leave room for the account id.
const CHUNK = 90;
async function lookup<T>(w: Writer, sql: (marks: string) => string, values: string[]): Promise<T[]> {
	const out: T[] = [];
	for (let i = 0; i < values.length; i += CHUNK) {
		const part = values.slice(i, i + CHUNK);
		if (!part.length) continue;
		const rows = await w.db.prepare(sql(part.map(() => "?").join(","))).bind(w.account, ...part).all<T>();
		out.push(...rows.results);
	}
	return out;
}

/**
 * Imports a batch in one transaction: a handful of lookups up front, one D1 batch to commit. Earlier
 * items in the batch count as stored for later ones (repeats skip, Message-ID twins merge, replies
 * thread), exactly as if they had been imported one by one.
 */
export async function importBatch(w: Writer, items: ImportInput[]): Promise<{ status: "imported" | "merged" | "skipped"; id: string }[]> {
	const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))];
	const seen = new Map((await lookup<{ id: string; source_id: string }>(w,
		(m) => `SELECT id, source_id FROM emails WHERE account_id = ? AND source_id IN (${m})`, uniq(items.map((i) => i.sourceId)))).map((r) => [r.source_id, r.id]));
	const twinRows = await lookup<{ id: string; message_id: string; received_at: number; keywords_json: string }>(w,
		(m) => `SELECT id, message_id, received_at, keywords_json FROM emails WHERE account_id = ? AND destroyed_modseq IS NULL AND message_id IN (${m})`, uniq(items.map((i) => i.messageId)));
	const twins = new Map(twinRows.map((r) => [r.message_id, r.id]));
	// What a merge needs to place the existing copy in more mailboxes: its date and read state.
	const twinInfo = new Map(twinRows.map((r) => [r.id, { receivedAt: r.received_at, unseen: !JSON.parse(r.keywords_json).$seen }]));
	const linkIds = uniq(items.flatMap((i) => [i.messageId, ...i.refs.slice(0, 50)]));
	const threads = new Map<string, string>();
	for (const r of await lookup<{ message_id: string; thread_id: string }>(w,
		(m) => `SELECT message_id, thread_id FROM emails WHERE account_id = ? AND message_id IN (${m})`, linkIds)) threads.set(r.message_id, r.thread_id);
	for (const r of await lookup<{ message_id: string; thread_id: string }>(w,
		(m) => `SELECT message_id, thread_id FROM sent_message_ids WHERE account_id = ? AND message_id IN (${m})`, linkIds)) if (!threads.has(r.message_id)) threads.set(r.message_id, r.thread_id);
	const twinBoxes = new Map<string, Set<string>>();
	for (const r of await lookup<{ email_id: string; mailbox_id: string }>(w,
		(m) => `SELECT email_id, mailbox_id FROM email_mailboxes WHERE ? IS NOT NULL AND email_id IN (${m})`, [...new Set(twins.values())])) {
		twinBoxes.set(r.email_id, (twinBoxes.get(r.email_id) ?? new Set()).add(r.mailbox_id));
	}

	const tx = await begin(w);
	const byRole = (role: string) => [...tx.mailboxes.values()].find((b) => b.role === role)?.id;
	const results: { status: "imported" | "merged" | "skipped"; id: string }[] = [];
	for (const m of items) {
		const repeat = seen.get(m.sourceId);
		if (repeat) {
			results.push({ status: "skipped", id: repeat });
			continue;
		}
		const boxes = new Set<string>();
		for (const r of m.roles) {
			const id = byRole(r);
			if (id) boxes.add(id);
		}
		for (const name of m.labels) boxes.add(tx.mailboxNamed(name));
		if (!boxes.size) boxes.add(byRole("archive")!);

		const twin = m.messageId ? twins.get(m.messageId) : undefined;
		if (twin) {
			const have = twinBoxes.get(twin) ?? new Set();
			const add = [...boxes].filter((b) => !have.has(b));
			if (add.length) {
				tx.stmts.push(w.db.prepare("UPDATE emails SET updated_modseq = ? WHERE id = ?").bind(tx.next(), twin));
				const info = twinInfo.get(twin)!;
				for (const b of add) {
					tx.place(twin, b, info.receivedAt, info.unseen);
					have.add(b);
				}
				twinBoxes.set(twin, have);
			}
			seen.set(m.sourceId, twin);
			results.push({ status: "merged", id: twin });
			continue;
		}

		const linked = [m.messageId, ...m.refs.slice(0, 50)].map((id) => id && threads.get(id)).find(Boolean);
		const threadId = linked ?? m.threadHint;
		insertEmail(w, tx, {
			id: m.id, blobKey: m.blobKey, parsed: m, size: m.size, receivedAt: m.receivedAt,
			threadId, mailboxIds: [...boxes], keywords: m.keywords, sourceId: m.sourceId,
		});
		// Visible to the rest of the batch.
		seen.set(m.sourceId, m.id);
		if (m.messageId) {
			twins.set(m.messageId, m.id);
			twinInfo.set(m.id, { receivedAt: m.receivedAt, unseen: !m.keywords.$seen });
			twinBoxes.set(m.id, new Set(boxes));
			threads.set(m.messageId, threadId);
		}
		results.push({ status: "imported", id: m.id });
	}
	await tx.commit();
	return results;
}

// ---------- Email/set ----------

function decodePath(s: string) {
	return s.replace(/~1/g, "/").replace(/~0/g, "~");
}

function checkKeywords(k: unknown): Record<string, true> | null {
	if (!k || typeof k !== "object" || Array.isArray(k)) return null;
	const out: Record<string, true> = {};
	for (const [key, v] of Object.entries(k)) {
		if (v !== true || !KEYWORD.test(key.toLowerCase())) return null;
		out[key.toLowerCase()] = true;
	}
	return out;
}

/** Applies a JMAP PatchObject to keywords/mailboxIds. Returns an error for anything else. */
export function applyPatch(cur: { keywords: Record<string, true>; mailboxIds: Record<string, true> }, patch: Record<string, unknown>) {
	const next = { keywords: { ...cur.keywords }, mailboxIds: { ...cur.mailboxIds } };
	for (const [path, value] of Object.entries(patch)) {
		if (path === "keywords" || path === "mailboxIds") {
			const set = checkKeywords(value);
			if (!set) return { error: { type: "invalidProperties", properties: [path] } as SetError };
			next[path] = path === "mailboxIds" ? Object.fromEntries(Object.keys(value as object).map((k) => [k, true as const])) : set;
			continue;
		}
		const slash = path.indexOf("/");
		const prop = path.slice(0, slash);
		const key = decodePath(path.slice(slash + 1));
		if ((prop !== "keywords" && prop !== "mailboxIds") || slash < 0 || !key || (value !== true && value !== null)) {
			return { error: { type: "invalidProperties", properties: [path] } as SetError };
		}
		const k = prop === "keywords" ? key.toLowerCase() : key;
		if (prop === "keywords" && !KEYWORD.test(k)) return { error: { type: "invalidProperties", properties: [path] } as SetError };
		if (value) next[prop][k] = true;
		else delete next[prop][k];
	}
	return { next };
}

const resolve = (id: string, createdIds: Record<string, string>) => (id.startsWith("#") ? createdIds[id.slice(1)] : id);

type Addr = { name?: string | null; email: string };
type EmailCreate = {
	mailboxIds?: Record<string, true>; keywords?: Record<string, true>;
	from?: Addr[]; to?: Addr[]; cc?: Addr[]; bcc?: Addr[]; replyTo?: Addr[];
	subject?: string | null; inReplyTo?: string[] | null; references?: string[] | null;
	bodyValues?: Record<string, { value?: string }>;
	textBody?: { partId?: string }[]; htmlBody?: { partId?: string }[];
	/** Uploads or parts of stored mail. A cid makes it inline (multipart/related), referenced from html. */
	attachments?: { blobId?: string; name?: string | null; type?: string; cid?: string | null }[];
};

const MAX_ATTACHMENTS_SIZE = 25_000_000;

async function createEmail(w: Writer, tx: Tx, o: EmailCreate): Promise<{ ok: Record<string, unknown> } | { error: SetError }> {
	const boxes = Object.keys(o.mailboxIds ?? {});
	if (!boxes.length || boxes.some((b) => !tx.mailboxes.has(b))) return { error: { type: "invalidProperties", properties: ["mailboxIds"] } };
	const keywords = checkKeywords(o.keywords ?? {});
	if (!keywords) return { error: { type: "invalidProperties", properties: ["keywords"] } };
	const body = (parts?: { partId?: string }[]) => (parts?.[0]?.partId ? o.bodyValues?.[parts[0].partId]?.value : undefined);
	const from = o.from ?? [];
	const domain = from[0]?.email.split("@")[1] ?? "mailopus.invalid";
	const id = crypto.randomUUID();

	const files: Part[] = [];
	let total = 0;
	for (const [i, a] of (o.attachments ?? []).entries()) {
		const blob = typeof a?.blobId === "string" ? await readBlob(w.db, w.mail, w.account, a.blobId) : null;
		if (!blob) return { error: { type: "blobNotFound", properties: [`attachments/${i}`], description: `no blob ${a?.blobId}` } };
		total += blob.content.byteLength;
		if (total > MAX_ATTACHMENTS_SIZE) return { error: { type: "tooLarge", properties: ["attachments"], description: "attachments over 25 MB" } };
		files.push({ name: a.name ?? blob.name ?? "attachment", type: a.type ?? blob.type, content: blob.content, ...(a.cid && { cid: a.cid }) });
	}
	const live = await renderLive({ text: body(o.textBody) ?? "", html: body(o.htmlBody) }, w.fetchJson);

	let raw: string;
	try {
		raw = buildMime({
			from, to: o.to, cc: o.cc, bcc: o.bcc, replyTo: o.replyTo, subject: o.subject,
			inReplyTo: o.inReplyTo, references: o.references,
			messageId: `${crypto.randomUUID()}@${domain}`, date: new Date(),
			text: live.text, html: live.html, amp: live.amp, attachments: files,
		});
	} catch (e) {
		if (e instanceof MimeError) return { error: { type: "invalidProperties", description: e.message } };
		throw e;
	}
	const bytes = new TextEncoder().encode(raw);
	const blobKey = `raw/${w.account}/${id}.eml`;
	await w.mail.put(blobKey, bytes, { httpMetadata: { contentType: "message/rfc822" } });
	const parsed = await parseEmail(bytes.buffer as ArrayBuffer);
	const threadId = await threadFor(w, parsed.refs);
	insertEmail(w, tx, { id, blobKey, parsed, size: bytes.byteLength, receivedAt: Date.now(), threadId, mailboxIds: boxes, keywords });
	return { ok: { id, blobId: id, threadId, size: bytes.byteLength } };
}

export async function emailSet(w: Writer, args: Record<string, any>, createdIds: Record<string, string>) {
	const tx = await begin(w);
	const oldState = String(tx.start);
	if (args.ifInState != null && args.ifInState !== oldState) return { error: "stateMismatch" as const };

	const created: Record<string, unknown> = {};
	const notCreated: Record<string, SetError> = {};
	for (const [cid, obj] of Object.entries((args.create ?? {}) as Record<string, EmailCreate>)) {
		const r = await createEmail(w, tx, obj);
		if ("error" in r) notCreated[cid] = r.error;
		else {
			created[cid] = r.ok;
			createdIds[cid] = r.ok.id as string;
		}
	}

	const updates = Object.entries((args.update ?? {}) as Record<string, Record<string, unknown>>).map(([id, patch]) => [resolve(id, createdIds) ?? id, patch] as const);
	const destroys = ((args.destroy ?? []) as string[]).map((id) => resolve(id, createdIds) ?? id);
	const ids = [...new Set([...updates.map(([id]) => id), ...destroys])];
	const rows = new Map<string, { keywords: Record<string, true>; mailboxIds: Record<string, true>; blobKey: string; receivedAt: number }>();
	// Chunked: D1 allows 100 bound parameters per statement, and a bulk action can name more emails.
	for (const e of await lookup<{ id: string; keywords_json: string; blob_key: string; received_at: number }>(w,
		(m) => `SELECT id, keywords_json, blob_key, received_at FROM emails WHERE account_id = ? AND destroyed_modseq IS NULL AND id IN (${m})`, ids)) {
		rows.set(e.id, { keywords: JSON.parse(e.keywords_json), mailboxIds: {}, blobKey: e.blob_key, receivedAt: e.received_at });
	}
	for (const b of await lookup<{ email_id: string; mailbox_id: string }>(w,
		(m) => `SELECT email_id, mailbox_id FROM email_mailboxes WHERE ? IS NOT NULL AND email_id IN (${m})`, [...rows.keys()])) {
		const r = rows.get(b.email_id);
		if (r) r.mailboxIds[b.mailbox_id] = true;
	}

	const updated: Record<string, null> = {};
	const notUpdated: Record<string, SetError> = {};
	for (const [id, patch] of updates) {
		const cur = rows.get(id);
		if (!cur) { notUpdated[id] = { type: "notFound" }; continue; }
		const r = applyPatch(cur, patch);
		if ("error" in r) { notUpdated[id] = r.error!; continue; }
		const nextBoxes = Object.keys(r.next!.mailboxIds);
		if (!nextBoxes.length || nextBoxes.some((b) => !tx.mailboxes.has(b))) {
			notUpdated[id] = { type: "invalidProperties", properties: ["mailboxIds"], description: "an email must be in at least one existing mailbox" };
			continue;
		}
		const modseq = tx.next();
		tx.stmts.push(w.db.prepare("UPDATE emails SET keywords_json = ?, updated_modseq = ? WHERE id = ?").bind(JSON.stringify(r.next!.keywords), modseq, id));
		const wasUnseen = !cur.keywords.$seen;
		const nowUnseen = !r.next!.keywords.$seen;
		const kept: string[] = [];
		for (const b of Object.keys(cur.mailboxIds)) {
			if (!r.next!.mailboxIds[b]) tx.unplace(id, b, wasUnseen);
			else kept.push(b);
		}
		for (const b of nextBoxes) {
			if (!cur.mailboxIds[b]) tx.place(id, b, cur.receivedAt, nowUnseen);
		}
		if (wasUnseen !== nowUnseen) tx.unreadChanged(kept, nowUnseen);
		cur.keywords = r.next!.keywords;
		cur.mailboxIds = r.next!.mailboxIds;
		updated[id] = null;
	}

	const destroyed: string[] = [];
	const notDestroyed: Record<string, SetError> = {};
	const gone: string[] = [];
	for (const id of destroys) {
		const cur = rows.get(id);
		if (!cur) { notDestroyed[id] = { type: "notFound" }; continue; }
		const modseq = tx.next();
		tx.stmts.push(
			w.db.prepare("UPDATE emails SET destroyed_modseq = ?, updated_modseq = ?, destroyed_at = ? WHERE id = ?").bind(modseq, modseq, Date.now(), id),
			// By rowid through the content table's email_id index (migration 0029): WHERE email_id = ? scans the whole index.
			w.db.prepare("DELETE FROM emails_fts WHERE rowid IN (SELECT id FROM emails_fts_content WHERE c0 = ?)").bind(id),
		);
		for (const b of Object.keys(cur.mailboxIds)) tx.unplace(id, b, !cur.keywords.$seen);
		rows.delete(id);
		destroyed.push(id);
		gone.push(cur.blobKey);
	}

	await tx.commit();
	// After the commit, so a failed batch never loses the message itself.
	await Promise.all(gone.map((k) => w.mail.delete(k)));
	const orNull = <T extends object>(o: T) => (Object.keys(o).length ? o : null);
	return {
		response: {
			accountId: w.account, oldState, newState: String(tx.modseq),
			created: orNull(created), updated: orNull(updated), destroyed: destroyed.length ? destroyed : null,
			notCreated: orNull(notCreated), notUpdated: orNull(notUpdated), notDestroyed: orNull(notDestroyed),
		},
		createdIds,
	};
}

// ---------- Mailbox/set ----------

const UNSEEN = `json_extract(e.keywords_json, '$."$seen"') IS NULL`;
// Placements in this mailbox whose email is in no other mailbox.
const ONLY_HERE = "em.mailbox_id = ? AND NOT EXISTS (SELECT 1 FROM email_mailboxes o WHERE o.email_id = em.email_id AND o.mailbox_id <> em.mailbox_id)";

/**
 * RFC 8621 §2.5 for labels (role-less mailboxes): create, rename, isSubscribed, destroy. Standard
 * mailboxes can't be created, renamed or destroyed. Names are flat, with "/" as the tree; parentId stays null.
 * Destroying with onDestroyRemoveEmails moves mail that was only in the label to Archive instead of
 * destroying it (Gmail's meaning of deleting a label); the RFC would destroy it.
 */
export async function mailboxSet(w: Writer, args: Record<string, any>) {
	const tx = await begin(w);
	const oldState = String(tx.start);
	if (args.ifInState != null && args.ifInState !== oldState) return { error: "stateMismatch" as const };

	// One rule for a created and a renamed label: parts trimmed, empty ones dropped, unique in the account.
	const named = (raw: unknown, self?: string): { name: string } | SetError => {
		const name = typeof raw === "string" ? raw.split("/").map((p) => p.trim()).filter(Boolean).join("/") : "";
		if (!name || name.length > 255) return { type: "invalidProperties", properties: ["name"], description: "a name is required" };
		// Case-insensitive: mail apps treat INBOX that way, and two labels a letter-case apart are one folder to them.
		if ([...tx.mailboxes.values()].some((b) => b.id !== self && b.name.toLowerCase() === name.toLowerCase())) return { type: "invalidProperties", properties: ["name"], description: `there's already a label called ${name}` };
		return { name };
	};

	const created: Record<string, unknown> = {};
	const createdIds: Record<string, string> = {};
	const notCreated: Record<string, SetError> = {};
	for (const [cid, o] of Object.entries((args.create ?? {}) as Record<string, Record<string, unknown>>)) {
		// role and parentId may be sent as null. A role would make a second Inbox or Trash.
		const bad = Object.keys(o ?? {}).filter((k) => (k === "role" || k === "parentId" ? o[k] != null : k === "isSubscribed" ? typeof o[k] !== "boolean" : k !== "name"));
		if (bad.length) { notCreated[cid] = { type: "invalidProperties", properties: bad }; continue; }
		const n = named(o?.name);
		if (!("name" in n)) { notCreated[cid] = n; continue; }
		tx.next();
		const id = newId();
		const subscribed = o.isSubscribed !== false;
		// Same row import makes (mailboxNamed). Counts start at the column defaults; mailbox_counts gets rows as mail is placed.
		tx.stmts.push(w.db.prepare("INSERT INTO mailboxes (id, account_id, name, role, uidvalidity, subscribed) VALUES (?, ?, ?, NULL, ?, ?)").bind(id, w.account, n.name, Math.floor(Date.now() / 1000), subscribed ? 1 : 0));
		tx.mailboxes.set(id, { id, name: n.name, role: null, uidnext: 1 });
		created[cid] = { id, name: n.name, role: null, parentId: null, sortOrder: 100, isSubscribed: subscribed, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0 };
		createdIds[cid] = id;
	}

	const updated: Record<string, null> = {};
	const notUpdated: Record<string, SetError> = {};
	for (const [id, patch] of Object.entries((args.update ?? {}) as Record<string, Record<string, unknown>>)) {
		const box = tx.mailboxes.get(id);
		if (!box) { notUpdated[id] = { type: "notFound" }; continue; }
		const bad = Object.keys(patch).filter((k) => k !== "name" && k !== "isSubscribed");
		if (bad.length) { notUpdated[id] = { type: "invalidProperties", properties: bad }; continue; }
		if ("isSubscribed" in patch && typeof patch.isSubscribed !== "boolean") { notUpdated[id] = { type: "invalidProperties", properties: ["isSubscribed"] }; continue; }
		let name: string | undefined;
		if ("name" in patch) {
			if (box.role) { notUpdated[id] = { type: "forbidden", description: "standard mailboxes keep their names" }; continue; }
			const n = named(patch.name, id);
			if (!("name" in n)) { notUpdated[id] = n; continue; }
			name = n.name;
		}
		tx.next();
		if (name !== undefined) {
			box.name = name;
			tx.stmts.push(w.db.prepare("UPDATE mailboxes SET name = ? WHERE id = ?").bind(name, id));
		}
		if (typeof patch.isSubscribed === "boolean") tx.stmts.push(w.db.prepare("UPDATE mailboxes SET subscribed = ? WHERE id = ?").bind(patch.isSubscribed ? 1 : 0, id));
		updated[id] = null;
	}

	const destroyed: string[] = [];
	const notDestroyed: Record<string, SetError> = {};
	const archive = [...tx.mailboxes.values()].find((b) => b.role === "archive")?.id;
	for (const id of (args.destroy ?? []) as string[]) {
		const box = tx.mailboxes.get(id);
		if (!box) { notDestroyed[id] = { type: "notFound" }; continue; }
		if (box.role || !archive) { notDestroyed[id] = { type: "forbidden", description: "standard mailboxes can't be deleted" }; continue; }
		const all = await w.db.prepare("SELECT count(*) AS n FROM email_mailboxes WHERE mailbox_id = ?").bind(id).first<{ n: number }>();
		if (all!.n && !args.onDestroyRemoveEmails) { notDestroyed[id] = { type: "mailboxHasEmail" }; continue; }
		const only = await w.db
			.prepare(`SELECT count(*) AS n, coalesce(sum(${UNSEEN}), 0) AS unread FROM email_mailboxes em JOIN emails e ON e.id = em.email_id WHERE ${ONLY_HERE}`)
			.bind(id)
			.first<{ n: number; unread: number }>();
		// One modseq for every email whose mailboxIds change: Email/changes reports them all after it.
		const modseq = tx.next();
		const first = tx.reserve(archive, only!.n);
		tx.adjust(archive, only!.n, only!.unread);
		tx.stmts.push(
			w.db.prepare("UPDATE emails SET updated_modseq = ? WHERE id IN (SELECT email_id FROM email_mailboxes WHERE mailbox_id = ?)").bind(modseq, id),
			w.db.prepare(
				`INSERT INTO email_mailboxes (email_id, mailbox_id, uid, received_at)
				SELECT em.email_id, ?, ? + row_number() OVER (ORDER BY em.received_at, em.email_id) - 1, em.received_at
				FROM email_mailboxes em WHERE ${ONLY_HERE}`,
			).bind(archive, first, id),
			w.db.prepare("DELETE FROM email_mailboxes WHERE mailbox_id = ?").bind(id),
			w.db.prepare("DELETE FROM mailboxes WHERE id = ?").bind(id),
		);
		tx.mailboxes.delete(id);
		destroyed.push(id);
	}

	await tx.commit();
	const orNull = <T extends object>(o: T) => (Object.keys(o).length ? o : null);
	return {
		response: {
			accountId: w.account, oldState, newState: String(tx.modseq),
			created: orNull(created), updated: orNull(updated), destroyed: destroyed.length ? destroyed : null,
			notCreated: orNull(notCreated), notUpdated: orNull(notUpdated), notDestroyed: orNull(notDestroyed),
		},
		createdIds,
	};
}

// ---------- Email/import ----------

/**
 * RFC 8621 §4.8: stores raw messages the client uploaded (IMAP APPEND and SMTP submission through
 * the imap/ proxy). Each one is a new email, with one exception: a message filed only into Sent
 * that Sent already holds (same Message-ID) returns the stored copy. Apple Mail and Thunderbird
 * append their own copy to Sent after sending, and Mailopus has already filed it there.
 */
export async function emailImport(w: Writer, args: Record<string, any>, createdIds: Record<string, string>) {
	const tx = await begin(w);
	const oldState = String(tx.start);
	if (args.ifInState != null && args.ifInState !== oldState) return { error: "stateMismatch" as const };
	const sent = [...tx.mailboxes.values()].find((b) => b.role === "sent")?.id;

	const created: Record<string, unknown> = {};
	const notCreated: Record<string, SetError> = {};
	for (const [cid, o] of Object.entries((args.emails ?? {}) as Record<string, { blobId?: unknown; mailboxIds?: Record<string, true>; keywords?: unknown; receivedAt?: unknown }>)) {
		const boxes = Object.keys(o?.mailboxIds ?? {});
		if (!boxes.length || boxes.some((b) => !tx.mailboxes.has(b))) { notCreated[cid] = { type: "invalidProperties", properties: ["mailboxIds"] }; continue; }
		const keywords = checkKeywords(o.keywords ?? {});
		if (!keywords) { notCreated[cid] = { type: "invalidProperties", properties: ["keywords"] }; continue; }
		const blob = typeof o.blobId === "string" ? await readBlob(w.db, w.mail, w.account, o.blobId) : null;
		if (!blob) { notCreated[cid] = { type: "blobNotFound", properties: ["blobId"] }; continue; }
		const bytes = blob.content;
		const parsed = await parseEmail(bytes.slice().buffer as ArrayBuffer);

		if (sent && parsed.messageId && boxes.length === 1 && boxes[0] === sent) {
			const twin = await w.db
				.prepare("SELECT e.id, e.thread_id, e.size FROM emails e JOIN email_mailboxes em ON em.email_id = e.id WHERE e.account_id = ? AND e.message_id = ? AND e.destroyed_modseq IS NULL AND em.mailbox_id = ?")
				.bind(w.account, parsed.messageId, sent)
				.first<{ id: string; thread_id: string; size: number }>();
			if (twin) {
				created[cid] = { id: twin.id, blobId: twin.id, threadId: twin.thread_id, size: twin.size };
				createdIds[cid] = twin.id;
				continue;
			}
		}

		const id = crypto.randomUUID();
		const blobKey = `raw/${w.account}/${id}.eml`;
		await w.mail.put(blobKey, bytes, { httpMetadata: { contentType: "message/rfc822" } });
		const threadId = await threadFor(w, parsed.messageId ? [parsed.messageId, ...parsed.refs] : parsed.refs);
		const at = typeof o.receivedAt === "string" ? Date.parse(o.receivedAt) : NaN;
		insertEmail(w, tx, { id, blobKey, parsed, size: bytes.byteLength, receivedAt: Number.isNaN(at) ? Date.now() : at, threadId, mailboxIds: boxes, keywords });
		created[cid] = { id, blobId: id, threadId, size: bytes.byteLength };
		createdIds[cid] = id;
	}

	await tx.commit();
	const orNull = <T extends object>(o: T) => (Object.keys(o).length ? o : null);
	return {
		response: { accountId: w.account, oldState, newState: String(tx.modseq), created: orNull(created), notCreated: orNull(notCreated) },
		createdIds,
	};
}

// ---------- EmailSubmission/set ----------

const addrList = (list: unknown) =>
	(Array.isArray(list) ? list : list ? [list] : []).flatMap((a: any) => (a.group ? a.group : [a])).map((a: any) => String(a.address ?? "").toLowerCase()).filter(Boolean);

/**
 * Each `name` header in the raw header block, as its list of addresses. postal-mime keeps only the first
 * address of the first From, so a second address or a second header would slip past a check on its result.
 */
export const headerAddresses = (raw: string, name: string) =>
	raw.split(/\r?\n\r?\n/, 1)[0]!.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)
		// "From :" with space before the colon is obsolete syntax that parsers still read as From.
		.filter((l) => new RegExp(`^${name}[ \\t]*:`, "i").test(l))
		.map((l) => addrList(addressParser(l.slice(l.indexOf(":") + 1))));

/** Earliest a held send may go, and the latest (Gmail allows ~49 years; a year is plenty). */
const MIN_HOLD_MS = 30_000;
const MAX_HOLD_MS = 366 * 86_400_000;

/**
 * RFC 4865 FUTURERELEASE as JMAP carries it: envelope.mailFrom.parameters HOLDUNTIL (a date-time) or
 * HOLDFOR (seconds). Returns the send time in ms, null to send now, or an error string.
 */
export function holdUntil(envelope: any, now = Date.now()): number | null | string {
	const params = Object.fromEntries(Object.entries(envelope?.mailFrom?.parameters ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
	const at = params.holduntil != null ? Date.parse(String(params.holduntil)) : params.holdfor != null ? now + Number(params.holdfor) * 1000 : null;
	if (at === null) return null;
	if (!Number.isFinite(at)) return "HOLDUNTIL/HOLDFOR isn't a valid time";
	if (at - now < MIN_HOLD_MS) return null;
	if (at - now > MAX_HOLD_MS) return "can't schedule more than a year ahead";
	return at;
}

/** Sends one copy per recipient and records the provider's Message-IDs for threading. */
async function deliver(w: Writer, threadId: string, from: string, raw: string, rcpts: string[], send: Sender) {
	const outgoing = stripBcc(raw);
	// Plugins (docs/plugins.md). One that acts can stop the send, and then no recipient gets it.
	const plugins = await pluginsFor(w.db, "send").catch(() => []);
	let event: MailEvent | undefined;
	if (plugins.length) {
		const m = await PostalMime.parse(outgoing);
		event = {
			event: "send",
			account: w.account,
			message: { from: { name: m.from?.name ?? "", email: from }, to: rcpts, cc: addrList(m.cc), subject: m.subject ?? null, messageId: m.messageId ?? null, date: m.date ? Date.parse(m.date) : null },
			headers: () => outgoing.slice(0, outgoing.search(/\r?\n\r?\n/) >>> 0).replace(/\r?\n[ \t]+/g, " "),
			body: () => m.text ?? "",
		};
		const { block } = await askPlugins(w.env, plugins, event);
		if (block) return rcpts.map((to) => `${to}: stopped by plugin ${block}`);
	}
	const failed: string[] = [];
	// ponytail: one send per recipient (the raw-message binding takes a single envelope recipient),
	// sequential, no retry. A partial failure reports which addresses didn't go out.
	const sentIds: string[] = [];
	for (const to of rcpts) {
		try {
			const mid = await send(from, to, outgoing);
			if (mid) sentIds.push(`<${mid.replace(/^<|>$/g, "")}>`);
		} catch (e) {
			failed.push(`${to}: ${(e as Error).message}`);
		}
	}
	if (sentIds.length) {
		await w.db.batch(sentIds.map((mid) =>
			w.db.prepare("INSERT OR IGNORE INTO sent_message_ids (account_id, message_id, thread_id) VALUES (?, ?, ?)").bind(w.account, mid, threadId)));
	}
	// ponytail: awaited, so a slow watching plugin adds up to its timeout to a send. Hand it to
	// waitUntil if that shows.
	if (event && failed.length < rcpts.length) await tellPlugins(w.env, plugins, event);
	return failed;
}

const roleBox = async (w: Writer, role: string) =>
	(await w.db.prepare("SELECT id FROM mailboxes WHERE account_id = ? AND role = ?").bind(w.account, role).first<{ id: string }>())?.id;

/** Moves an email between role mailboxes as one Email/set, so counts and modseq stay right. */
async function moveRole(w: Writer, emailId: string, from: string, to: string, keywords: Record<string, true | null> = {}) {
	const [src, dst] = [await roleBox(w, from), await roleBox(w, to)];
	if (!src || !dst) return;
	const patch: Record<string, unknown> = { [`mailboxIds/${src}`]: null, [`mailboxIds/${dst}`]: true };
	for (const [k, v] of Object.entries(keywords)) patch[`keywords/${k}`] = v;
	await emailSet(w, { update: { [emailId]: patch } }, {});
}

export type SubmitResult = Awaited<ReturnType<typeof submissionSet>>;

export async function submissionSet(w: Writer, args: Record<string, any>, createdIds: Record<string, string>, send: Sender) {
	const created: Record<string, unknown> = {};
	const notCreated: Record<string, SetError> = {};
	const emailFor: Record<string, string> = {};
	let scheduled = false;

	for (const [cid, sub] of Object.entries((args.create ?? {}) as Record<string, any>)) {
		const identity = await w.db.prepare("SELECT email FROM identities WHERE id = ? AND account_id = ?").bind(sub?.identityId, w.account).first<{ email: string }>();
		if (!identity) { notCreated[cid] = { type: "invalidProperties", properties: ["identityId"] }; continue; }
		const emailId = typeof sub.emailId === "string" ? resolve(sub.emailId, createdIds) : undefined;
		const row = emailId
			? await w.db.prepare("SELECT blob_key, thread_id FROM emails WHERE id = ? AND account_id = ? AND destroyed_modseq IS NULL").bind(emailId, w.account).first<{ blob_key: string; thread_id: string }>()
			: null;
		const obj = row && (await w.mail.get(row.blob_key));
		if (!obj) { notCreated[cid] = { type: "invalidProperties", properties: ["emailId"] }; continue; }
		const raw = await obj.text();
		const m = await PostalMime.parse(raw);
		// Exactly one From header holding exactly the identity, and a Sender, if any, that is the identity too.
		const me = identity.email.toLowerCase();
		const froms = headerAddresses(raw, "from");
		const only = (list: string[]) => list.length === 1 && list[0] === me;
		if (froms.length !== 1 || !only(froms[0]!) || !headerAddresses(raw, "sender").every(only)) {
			notCreated[cid] = { type: "forbiddenFrom", description: `From must be ${identity.email}` };
			continue;
		}
		const rcpts = [...new Set(sub.envelope?.rcptTo?.map((r: { email: string }) => r.email.toLowerCase()) ?? [...addrList(m.to), ...addrList(m.cc), ...addrList(m.bcc)])] as string[];
		if (!rcpts.length) { notCreated[cid] = { type: "noRecipients" }; continue; }
		if (rcpts.length > MAX_RECIPIENTS) { notCreated[cid] = { type: "tooManyRecipients", description: `at most ${MAX_RECIPIENTS}` }; continue; }

		const hold = holdUntil(sub.envelope);
		if (typeof hold === "string") { notCreated[cid] = { type: "invalidProperties", properties: ["envelope"], description: hold }; continue; }
		const id = crypto.randomUUID();
		if (hold !== null) {
			await w.db.prepare("INSERT INTO scheduled_submissions (id, account_id, email_id, identity_id, rcpts_json, send_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
				.bind(id, w.account, emailId, sub.identityId, JSON.stringify(rcpts), hold, Date.now()).run();
			scheduled = true;
			createdIds[cid] = id;
			emailFor[cid] = emailId!;
			created[cid] = { id, sendAt: new Date(hold).toISOString(), undoStatus: "pending" };
			continue;
		}

		const failed = await deliver(w, row!.thread_id, identity.email, raw, rcpts, send);
		if (failed.length === rcpts.length) { notCreated[cid] = { type: "forbiddenToSend", description: failed.join("; ") }; continue; }
		createdIds[cid] = id;
		emailFor[cid] = emailId!;
		created[cid] = { id, sendAt: new Date().toISOString(), undoStatus: "final", ...(failed.length && { deliveryFailures: failed }) };
	}

	// Canceling a held send (RFC 8621 §7.5: update undoStatus to "canceled") puts the email back in Drafts.
	const updated: Record<string, null> = {};
	const notUpdated: Record<string, SetError> = {};
	for (const [id, patch] of Object.entries((args.update ?? {}) as Record<string, any>)) {
		if (patch?.undoStatus !== "canceled" || Object.keys(patch).length !== 1) { notUpdated[id] = { type: "invalidProperties", description: "only undoStatus: canceled" }; continue; }
		const row = await w.db.prepare("SELECT email_id FROM scheduled_submissions WHERE id = ? AND account_id = ?").bind(id, w.account).first<{ email_id: string }>();
		if (!row) { notUpdated[id] = { type: "cannotUnsend", description: "already sent or not found" }; continue; }
		await w.db.prepare("DELETE FROM scheduled_submissions WHERE id = ?").bind(id).run();
		await moveRole(w, row.email_id, "scheduled", "drafts", { $draft: true });
		updated[id] = null;
	}

	const orNull = <T extends object>(o: T) => (Object.keys(o).length ? o : null);
	const response = {
		accountId: w.account, oldState: null, newState: "0",
		created: orNull(created), notCreated: orNull(notCreated), updated: orNull(updated), notUpdated: orNull(notUpdated),
	};

	// onSuccess*: "#cid" names the Email of that submission (RFC 8621 §7.5).
	const pick = (key: string) => (key.startsWith("#") ? emailFor[key.slice(1)] : undefined);
	const update: Record<string, unknown> = {};
	for (const [key, patch] of Object.entries((args.onSuccessUpdateEmail ?? {}) as Record<string, unknown>)) {
		const id = pick(key);
		if (id) update[id] = patch;
	}
	const destroy = ((args.onSuccessDestroyEmail ?? []) as string[]).map(pick).filter(Boolean) as string[];
	if (!Object.keys(update).length && !destroy.length) return { response, createdIds, scheduled };
	const implicit = await emailSet(w, { update, destroy }, createdIds);
	return { response, createdIds, scheduled, also: ["Email/set", (implicit as { response: unknown }).response] as [string, unknown] };
}

/**
 * Sends held submissions that are due, then files each email in Sent (or back in Drafts if every
 * recipient failed). Returns when the next one is due, for the Durable Object's alarm.
 */
export async function sendDue(w: Writer, send: Sender, now = Date.now()): Promise<number | null> {
	const due = await w.db.prepare("SELECT s.id, s.email_id, s.rcpts_json, i.email, e.blob_key, e.thread_id FROM scheduled_submissions s JOIN identities i ON i.id = s.identity_id JOIN emails e ON e.id = s.email_id WHERE s.account_id = ? AND s.send_at <= ? AND e.destroyed_modseq IS NULL")
		.bind(w.account, now).all<{ id: string; email_id: string; rcpts_json: string; email: string; blob_key: string; thread_id: string }>();
	for (const r of due.results) {
		// Deleted first: a crash mid-send can't send it twice on the next alarm.
		await w.db.prepare("DELETE FROM scheduled_submissions WHERE id = ?").bind(r.id).run();
		const obj = await w.mail.get(r.blob_key);
		const rcpts = JSON.parse(r.rcpts_json) as string[];
		const failed = obj ? await deliver(w, r.thread_id, r.email, await obj.text(), rcpts, send) : rcpts;
		if (failed.length === rcpts.length) {
			console.error("scheduled send failed", r.id, failed.join("; "));
			await moveRole(w, r.email_id, "scheduled", "drafts", { $draft: true });
		} else {
			await moveRole(w, r.email_id, "scheduled", "sent", { $draft: null });
		}
	}
	// Rows whose email was deleted can never send.
	await w.db.prepare("DELETE FROM scheduled_submissions WHERE account_id = ? AND email_id IN (SELECT id FROM emails WHERE destroyed_modseq IS NOT NULL)").bind(w.account).run();
	const next = await w.db.prepare("SELECT min(send_at) AS at FROM scheduled_submissions WHERE account_id = ?").bind(w.account).first<{ at: number | null }>();
	return next?.at ?? null;
}

export async function scheduledSubmissions(db: D1Database, account: string) {
	const rows = await db.prepare("SELECT s.id, s.email_id, s.identity_id, s.rcpts_json, s.send_at, e.thread_id FROM scheduled_submissions s JOIN emails e ON e.id = s.email_id WHERE s.account_id = ? ORDER BY s.send_at")
		.bind(account).all<{ id: string; email_id: string; identity_id: string; rcpts_json: string; send_at: number; thread_id: string }>();
	return rows.results.map((r) => ({
		id: r.id, emailId: r.email_id, threadId: r.thread_id, identityId: r.identity_id,
		sendAt: new Date(r.send_at).toISOString(), undoStatus: "pending",
		envelope: { mailFrom: { email: "", parameters: { HOLDUNTIL: new Date(r.send_at).toISOString() } }, rcptTo: (JSON.parse(r.rcpts_json) as string[]).map((email) => ({ email, parameters: null })) },
		deliveryStatus: null, dsnBlobIds: [], mdnBlobIds: [],
	}));
}

type IdentityRow = {
	id: string; account_id: string; name: string; email: string; text_signature: string; html_signature: string;
	signature_provider: string | null; signature_config: string; signature_status: string | null; signature_synced_at: number | null;
};

/**
 * JMAP Identity objects with the stored signatures. A provider keeps those up to date by syncing
 * (server/lib/signatures.ts); nothing is fetched here. Our extensions: signatureProvider
 * ({name, ...public settings} or null), signatureStatus (null, or why the last sync didn't apply),
 * signatureSyncedAt.
 */
export async function identities(db: D1Database, account: string) {
	const rows = await db.prepare("SELECT * FROM identities WHERE account_id = ?").bind(account).all<IdentityRow>();
	return rows.results.map((r) => ({
		id: r.id, name: r.name, email: r.email, replyTo: null, bcc: null, mayDelete: false,
		textSignature: r.text_signature, htmlSignature: r.html_signature,
		signatureProvider: publicConfig(r.signature_provider, r.signature_config),
		signatureStatus: r.signature_status,
		signatureSyncedAt: r.signature_synced_at ? new Date(r.signature_synced_at).toISOString() : null,
	}));
}

const MAX_SIGNATURE = 100_000;

/**
 * Identity/set, update only: name, textSignature, htmlSignature (stored), and signatureProvider
 * ({name, ...settings} or null). Settings merge into what's stored, so a client can change "block"
 * without resending the token.
 */
export async function identityUpdate(db: D1Database, account: string, update: Record<string, any>) {
	const updated: Record<string, null> = {};
	const notUpdated: Record<string, SetError> = {};
	for (const [id, patch] of Object.entries(update ?? {})) {
		const row = await db.prepare("SELECT signature_provider, signature_config FROM identities WHERE id = ? AND account_id = ?").bind(id, account).first<{ signature_provider: string | null; signature_config: string }>();
		if (!row) { notUpdated[id] = { type: "notFound" }; continue; }
		const sets: string[] = [];
		const vals: unknown[] = [];
		const bad = (prop: string, description?: string) => (notUpdated[id] = { type: "invalidProperties", properties: [prop], ...(description && { description }) });
		for (const [k, v] of Object.entries(patch ?? {})) {
			if (k === "name" && typeof v === "string" && v.length <= 255 && !/[\r\n]/.test(v)) sets.push("name = ?"), vals.push(v);
			else if (k === "textSignature" && typeof v === "string" && v.length <= MAX_SIGNATURE) sets.push("text_signature = ?"), vals.push(v);
			else if (k === "htmlSignature" && typeof v === "string" && v.length <= MAX_SIGNATURE) sets.push("html_signature = ?"), vals.push(v);
			else if (k === "signatureProvider" && v === null) sets.push("signature_provider = NULL", "signature_config = '{}'");
			else if (k === "signatureProvider" && v && typeof v === "object" && PROVIDERS[(v as { name: string }).name]) {
				const { name, ...settings } = v as Record<string, string> & { name: string };
				const keep = row.signature_provider === name ? JSON.parse(row.signature_config || "{}") : {};
				// Only the provider's own settings. Anything else in the stored config (where to reach the provider)
				// is set by the server when the account connects, never by a client.
				const allowed = new Set([...PROVIDERS[name]!.public, ...PROVIDERS[name]!.required]);
				const config = { ...keep, ...Object.fromEntries(Object.entries(settings).filter(([key, x]) => allowed.has(key) && typeof x === "string" && x.length <= 1000)) };
				const connected = await connectionConfig(db, account, name);
				const missing = PROVIDERS[name]!.required.find((r) => !config[r] && !connected[r]);
				if (missing) { bad(k, `${name} needs ${missing}`); break; }
				sets.push("signature_provider = ?", "signature_config = ?"), vals.push(name, JSON.stringify(config));
			} else { bad(k); break; }
		}
		if (notUpdated[id]) continue;
		if (sets.length) await db.prepare(`UPDATE identities SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, id).run();
		// Picking a provider (or sending it again: "Sync now") syncs right away, so the answer shows.
		if (patch?.signatureProvider) {
			const fresh = await db.prepare("SELECT id, account_id, email, html_signature, signature_provider, signature_config FROM identities WHERE id = ?").bind(id).first<IdentityRow>();
			if (fresh) await syncSignature(db, fresh);
		}
		updated[id] = null;
	}
	const orNull = <T extends object>(o: T) => (Object.keys(o).length ? o : null);
	return { accountId: account, oldState: "0", newState: "0", updated: orNull(updated), notUpdated: orNull(notUpdated), created: null, destroyed: null, notCreated: null, notDestroyed: null };
}
