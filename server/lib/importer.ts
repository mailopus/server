// Imports one Gmail page (100 messages) for a job, then reports whether more pages remain.
// The queue consumer calls this and enqueues the next page; everything is idempotent per message
// (emails.source_id), so a retried page never duplicates mail.
import { GmailError, type ServiceAccount, accessToken, labelNames, listPage, mapLabels, messageSize, messagesTotal, rawMessage, useGmailApi } from "./gmail.ts";
import { parseEmail } from "../utils/mail.ts";
import type { ImportInput } from "./jmap/write.ts";

const FETCH_CONCURRENCY = 24; // Gmail allows ~50 raw gets/s per user; ~1s each keeps us near 24/s
// A Worker has 128 MB. A message costs ~3x its size while in flight (JSON text, bytes, parse), so cap
// the bytes being fetched at once; one message bigger than this still goes, alone.
const BYTES_IN_FLIGHT = 24 * 1024 * 1024;
// Past this, only the start of the message is parsed: headers and body text sit before the attachments
// that make it big.
const PARSE_LIMIT = 2 * 1024 * 1024;
const BATCH = 25; // messages per Durable Object transaction (keeps each D1 batch around 100 statements)
const STALL_MS = 10 * 60_000; // a run lasts at most RUN_BUDGET_MS (4 min), so 10 min of silence means it died

type Job = {
	id: string; account_id: string; workspace: string; source_email: string; status: string;
	page_token: string | null; labels_json: string | null;
};

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

export function serviceAccount(env: Env, workspace: string): ServiceAccount {
	const raw = (env as unknown as Record<string, string | undefined>)[`GOOGLE_SA_${workspace.toUpperCase()}`];
	if (!raw) throw new Error(`secret GOOGLE_SA_${workspace.toUpperCase()} is not set`);
	// A parse error quotes the text around where it failed, and this text is a private key. The job's
	// last_error is shown in Settings and logged, so it gets a message with none of the secret in it.
	try {
		const sa = JSON.parse(raw) as ServiceAccount;
		useGmailApi(sa.gmail_api);
		return sa;
	} catch {
		throw new Error(`secret GOOGLE_SA_${workspace.toUpperCase()} is not valid JSON. Paste the whole key file.`);
	}
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
	let i = 0;
	await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
		while (i < items.length) await fn(items[i++]!);
	}));
}

export async function runPage(env: Env, jobId: string): Promise<boolean> {
	const db = env.DB;
	const job = await db.prepare("SELECT * FROM import_jobs WHERE id = ?").bind(jobId).first<Job>();
	if (!job || (job.status !== "running" && job.status !== "pending")) return false;
	const user = job.source_email;
	const token = await accessToken(serviceAccount(env, job.workspace), user);
	let labels: Record<string, string>;
	if (job.labels_json) labels = JSON.parse(job.labels_json);
	else {
		labels = await labelNames(token, user);
		await db.prepare("UPDATE import_jobs SET labels_json = ? WHERE id = ?").bind(JSON.stringify(labels), jobId).run();
	}

	const t0 = Date.now();
	const page = await listPage(token, user, job.page_token);
	const tList = Date.now();
	const account = env.ACCOUNT.get(env.ACCOUNT.idFromName(job.account_id));
	const counts = { imported: 0, merged: 0, skipped: 0, failed: 0 };
	let lastError = null as string | null;

	// Skip what's already stored before downloading anything (a retried page costs only this query).
	const ids = (page.messages ?? []).map((m) => m.id);
	const have = new Set<string>();
	for (let i = 0; i < ids.length; i += 90) {
		const part = ids.slice(i, i + 90).map((id) => `gmail:${user}:${id}`);
		const rows = await db.prepare(`SELECT source_id FROM emails WHERE account_id = ? AND source_id IN (${part.map(() => "?").join(",")})`)
			.bind(job.account_id, ...part).all<{ source_id: string }>();
		for (const r of rows.results) have.add(r.source_id);
	}
	const todo = ids.filter((id) => !have.has(`gmail:${user}:${id}`));
	counts.skipped += ids.length - todo.length;

	// Sizes first (a few bytes each), so the downloads can be held to a memory budget. A failed size
	// lookup counts as 0; the download reports the real error.
	const sizes: number[] = new Array(todo.length).fill(0);
	await pool(todo.map((id, i) => ({ id, i })), FETCH_CONCURRENCY, async ({ id, i }) => {
		sizes[i] = await messageSize(token, user, id).catch(() => 0);
	});
	let inFlight = 0;
	let wake: (() => void)[] = [];
	const acquire = async (n: number) => {
		while (inFlight > 0 && inFlight + n > BYTES_IN_FLIGHT) await new Promise<void>((r) => wake.push(r));
		inFlight += n;
	};
	const release = (n: number) => {
		inFlight -= n;
		const w = wake;
		wake = [];
		for (const r of w) r();
	};

	// Fetch raw messages in parallel and store them in R2; collect the parsed results in page order.
	const items: (ImportInput | null)[] = new Array(todo.length).fill(null);
	await pool(todo.map((id, i) => ({ id, i })), FETCH_CONCURRENCY, async ({ id: gmailId, i }) => {
		await acquire(sizes[i]!);
		try {
			const m = await rawMessage(token, user, gmailId);
			const id = crypto.randomUUID();
			const blobKey = `raw/${job.account_id}/${id}.eml`;
			const buf = m.bytes.buffer.slice(m.bytes.byteOffset, m.bytes.byteOffset + m.bytes.byteLength) as ArrayBuffer;
			await env.MAIL.put(blobKey, buf, { httpMetadata: { contentType: "message/rfc822" } });
			const big = buf.byteLength > PARSE_LIMIT;
			const parsed = await parseEmail(big ? buf.slice(0, PARSE_LIMIT) : buf);
			// ponytail: a cut-off parse can't see attachments past the cut; a message this big has one.
			if (big) parsed.hasAttachment = true;
			const threadHint = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`gmail:${user}:${m.threadId}`))).slice(0, 32);
			items[i] = {
				...parsed, ...mapLabels(m.labelIds ?? [], labels),
				id, blobKey, size: buf.byteLength, receivedAt: Number(m.internalDate) || Date.now(), sourceId: `gmail:${user}:${gmailId}`, threadHint,
			};
		} catch (e) {
			// Only a permanent Gmail answer (e.g. 404, message deleted since the listing) counts as failed.
			// Everything else (Gmail rate limits, R2 or Durable Object hiccups) retries the whole page,
			// which is safe because stored messages are skipped.
			if (!(e instanceof GmailError) || e.transient) throw e;
			counts.failed++;
			lastError = `${gmailId}: ${(e as Error).message}`.slice(0, 500);
		} finally {
			release(sizes[i]!);
		}
	});

	const tFetch = Date.now();
	// One Durable Object transaction per BATCH messages instead of one per message.
	const ready = items.filter((x): x is ImportInput => !!x);
	// D1 refuses a transaction that does too much at once ("overloaded"); halve the batch until it fits.
	// A single message that still can't be stored counts as failed (a rescan tries it again) so one bad
	// message can't hold the job on this page forever.
	const store = async (chunk: ImportInput[]): Promise<void> => {
		try {
			const res: { status: "imported" | "merged" | "skipped" }[] = await account.importBatch(job.account_id, chunk);
			await Promise.all(res.map((r, j) => {
				counts[r.status]++;
				return r.status === "imported" ? null : env.MAIL.delete(chunk[j]!.blobKey);
			}));
		} catch (e) {
			const msg = (e as Error).message;
			if (!/overloaded/i.test(msg)) throw e;
			await new Promise((r) => setTimeout(r, 2000));
			if (chunk.length > 1) {
				const half = Math.ceil(chunk.length / 2);
				await store(chunk.slice(0, half));
				return store(chunk.slice(half));
			}
			const m = chunk[0]!;
			counts.failed++;
			lastError = `${m.sourceId}: ${msg} (${m.size} bytes, ${m.to.length + m.cc.length} recipients, ${m.refs.length} refs)`.slice(0, 500);
			console.warn("import: message too heavy for one write", lastError);
			await env.MAIL.delete(m.blobKey);
		}
	};
	for (let i = 0; i < ready.length; i += BATCH) await store(ready.slice(i, i + BATCH));

	console.log(`import ${user}: list ${tList - t0}ms, fetch+store ${tFetch - tList}ms (${todo.length}), durable object ${Date.now() - tFetch}ms`);
	const next = page.nextPageToken ?? null;
	await db.prepare(
		`UPDATE import_jobs SET page_token = ?, status = ?, pages = pages + 1, imported = imported + ?, merged = merged + ?,
			skipped = skipped + ?, failed = failed + ?, last_error = coalesce(?, last_error), updated_at = ? WHERE id = ?`,
	).bind(next, next ? "running" : "done", counts.imported, counts.merged, counts.skipped, counts.failed, lastError, Date.now(), jobId).run();
	return !!next;
}

// A queue invocation keeps going for this long before handing off to a fresh one. Delivery between
// queue messages takes ~30s, so one page per message wasted most of the time.
const RUN_BUDGET_MS = 4 * 60_000;

/** Imports pages until the job is done, paused, or the time budget is spent. True if more remain. */
export async function runPages(env: Env, jobId: string, budgetMs = RUN_BUDGET_MS): Promise<boolean> {
	const until = Date.now() + budgetMs;
	await recordTotal(env, jobId).catch((e) => console.warn("import: no message total", (e as Error).message));
	let more = true;
	while (more && Date.now() < until) more = await runPage(env, jobId);
	return more;
}

/** Gmail's message count for the job's mailbox, once per run, for progress in `import.mjs status`. */
async function recordTotal(env: Env, jobId: string) {
	const job = await env.DB.prepare("SELECT workspace, source_email FROM import_jobs WHERE id = ?").bind(jobId).first<{ workspace: string; source_email: string }>();
	if (!job) return;
	const total = await messagesTotal(await accessToken(serviceAccount(env, job.workspace), job.source_email), job.source_email);
	await env.DB.prepare("UPDATE import_jobs SET messages_total = ? WHERE id = ?").bind(total, jobId).run();
}

/** Cron: starts pending jobs and restarts running ones that stopped advancing (e.g. lost queue message). */
export async function kickJobs(env: Env) {
	const jobs = await env.DB.prepare("SELECT id FROM import_jobs WHERE status = 'pending' OR (status = 'running' AND updated_at < ?)")
		.bind(Date.now() - STALL_MS).all<{ id: string }>();
	for (const { id } of jobs.results) {
		await env.DB.prepare("UPDATE import_jobs SET status = 'running', updated_at = ? WHERE id = ?").bind(Date.now(), id).run();
		await env.IMPORT_QUEUE.send({ jobId: id });
	}
	return jobs.results.length;
}
