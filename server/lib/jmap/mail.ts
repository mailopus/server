// JMAP Mail (RFC 8621). Writes go to the account's Durable Object via ctx.writer (see write.ts).
import { ALSO, LIMITS, type Method, MethodError } from "./core.ts";
import { identities, identityUpdate, scheduledSubmissions } from "./write.ts";
import PostalMime from "postal-mime";
import { addressedSql, cleanPattern } from "../addressed.ts";
import { UPLOAD_ID } from "../blobs.ts";

type SetResult = { response?: Record<string, unknown>; error?: string; createdIds: Record<string, string>; also?: [string, unknown] };
export type Writer = {
	emailSet(account: string, args: Record<string, unknown>, createdIds: Record<string, string>): Promise<SetResult>;
	emailImport(account: string, args: Record<string, unknown>, createdIds: Record<string, string>): Promise<SetResult>;
	submit(account: string, args: Record<string, unknown>, createdIds: Record<string, string>): Promise<SetResult>;
	mailboxSet(account: string, args: Record<string, unknown>): Promise<SetResult>;
};
export type Ctx = {
	db: D1Database;
	mail: R2Bucket;
	accounts: Set<string>;
	/** The account's Durable Object; all writes go through it. */
	writer: (account: string) => Writer;
	/** Creation ids from earlier calls in this request (RFC 8620 §5.3). */
	createdIds: Record<string, string>;
	/** A limited app password's address patterns: only mail that reached them is visible. Null for all mail. */
	scope?: string[] | null;
};

const QUERY_LIMIT = 256;

// D1 caps a statement at 100 bound parameters, so id lists go in chunks (sent together in one batch).
const PARAM_CHUNK = 90;
function chunked<T>(xs: T[]): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < xs.length; i += PARAM_CHUNK) out.push(xs.slice(i, i + PARAM_CHUNK));
	return out;
}
const ROLE_ORDER = ["inbox", "drafts", "sent", "archive", "junk", "trash"];

function accountId(args: Record<string, unknown>, ctx: Ctx): string {
	const id = args.accountId;
	if (typeof id !== "string" || !ctx.accounts.has(id)) throw new MethodError("accountNotFound");
	return id;
}

const stateStmt = (ctx: Ctx, account: string) => ctx.db.prepare("SELECT modseq FROM accounts WHERE id = ?").bind(account);

async function currentState(ctx: Ctx, account: string): Promise<number> {
	return (await stateStmt(ctx, account).first<{ modseq: number }>())?.modseq ?? 0;
}

/**
 * Runs the statements and reads the account's state in one D1 batch: one round trip instead of two,
 * and the state matches the rows (a batch is one transaction). Each sequential D1 call costs ~30 ms.
 */
async function withState(ctx: Ctx, account: string, stmts: D1PreparedStatement[]) {
	const r = await ctx.db.batch([...stmts, stateStmt(ctx, account)]);
	const state = String((r.at(-1)!.results[0] as { modseq: number } | undefined)?.modseq ?? 0);
	return [r.slice(0, -1).map((x) => x.results), state] as const;
}

function sinceState(args: Record<string, unknown>, current: number): number {
	const n = Number(args.sinceState);
	if (typeof args.sinceState !== "string" || !Number.isInteger(n) || n < 0 || n > current) {
		throw new MethodError("cannotCalculateChanges");
	}
	return n;
}

function idList(v: unknown, what = "ids"): string[] | null {
	if (v === null || v === undefined) return null;
	if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new MethodError("invalidArguments", what);
	if (v.length > LIMITS.maxObjectsInGet) throw new MethodError("requestTooLarge");
	return v as string[];
}

const pick = (obj: Record<string, unknown>, props: string[] | null) =>
	props ? Object.fromEntries(props.filter((p) => p in obj).map((p) => [p, obj[p]])) : obj;

// ---------- App password scope ----------
// A limited app password sees only mail addressed to its patterns (emails.addressed_to, see
// server/lib/addressed.ts), sends only as identities inside them, and can't change folders or identities.

/** SQL on alias `e` for "inside the scope"; "1" for all mail. */
const scopeSql = (ctx: Ctx) => (ctx.scope ? addressedSql(ctx.scope) : { sql: "1", params: [] as unknown[] });

/** Whether an address is inside the scope, by the same rule as addressedSql. */
export function addressInScope(address: string, scope: string[] | null | undefined): boolean {
	if (!scope) return true;
	const a = address.toLowerCase();
	return scope.some((p) => (p.startsWith("@") ? a.endsWith(p) || a.endsWith(`.${p.slice(1)}`) : a === p));
}

const outOfScope = () => new MethodError("forbidden", "outside this app password's addresses");

/** Throws forbidden unless every email (ids, "#creation" refs or blob ids) is inside the scope. */
async function requireInScope(ctx: Ctx, account: string, refs: string[]) {
	if (!ctx.scope) return;
	const ids = [...new Set(refs
		.map((r) => (r.startsWith("#") ? ctx.createdIds[r.slice(1)] ?? r : r))
		.filter((r) => !UPLOAD_ID.test(r))
		.map((r) => r.split("_")[0]!))];
	if (!ids.length) return;
	const s = scopeSql(ctx);
	const found = (await ctx.db.batch(chunked(ids).map((part) => ctx.db
		.prepare(`SELECT e.id FROM emails e WHERE +e.account_id = ? AND e.id IN (${part.map(() => "?").join(",")}) AND ${s.sql}`)
		.bind(account, ...part, ...s.params)))).flatMap((r) => r.results).length;
	if (found < ids.length) throw outOfScope();
}

/** Every string under a "blobId" or "emailId" key, at any depth. */
function refsIn(v: unknown, out: string[] = []): string[] {
	if (Array.isArray(v)) for (const x of v) refsIn(x, out);
	else if (v && typeof v === "object") {
		for (const [k, x] of Object.entries(v)) {
			if ((k === "blobId" || k === "emailId") && typeof x === "string") out.push(x);
			else refsIn(x, out);
		}
	}
	return out;
}

/** For the download route: whether a blob is visible to this context. */
export async function blobInScope(ctx: Ctx, account: string, blobId: string) {
	try {
		await requireInScope(ctx, account, [blobId]);
		return true;
	} catch {
		return false;
	}
}

// ---------- Mailbox ----------

const mailboxGet: Method<Ctx> = async (args, ctx) => {
	const account = accountId(args, ctx);
	const ids = idList(args.ids);
	const props = idList(args.properties, "properties");
	// Email counts are kept by the writer; thread counts need a scan of the mailbox, so they're only
	// computed when a client asks for them.
	const unread = `json_extract(e.keywords_json, '$."$seen"') IS NULL`;
	const scope = scopeSql(ctx);
	const wantThreads = !props || props.includes("totalThreads") || props.includes("unreadThreads");
	// One round trip: the mailboxes, the optional counts below, and the state.
	const [[rows, ...more], state] = await withState(ctx, account, [
		ctx.db
			.prepare("SELECT id, name, role, total_emails AS totalEmails, unread_emails AS unreadEmails, subscribed, uidvalidity AS imapUidValidity, uidnext AS imapUidNext FROM mailboxes WHERE account_id = ?")
			.bind(account),
		// The writer's counts are for all mail. A scoped password sees the per-address counts its scope matches,
		// which triggers keep in step with every write (migration 0030). The alias is e so scope.sql applies.
		...(ctx.scope ? [ctx.db
			.prepare(
				`SELECT e.mailbox_id AS id, sum(e.total) AS total, sum(e.unread) AS unread FROM mailbox_counts e
				WHERE e.mailbox_id IN (SELECT id FROM mailboxes WHERE account_id = ?) AND ${scope.sql} GROUP BY e.mailbox_id`,
			)
			.bind(account, ...scope.params)] : []),
		...(wantThreads ? [ctx.db
			.prepare(
				`SELECT em.mailbox_id AS id, count(DISTINCT e.thread_id) AS totalThreads,
					count(DISTINCT CASE WHEN ${unread} THEN e.thread_id END) AS unreadThreads
				FROM email_mailboxes em JOIN emails e ON e.id = em.email_id
				WHERE e.account_id = ? AND ${scope.sql} GROUP BY em.mailbox_id`,
			)
			.bind(account, ...scope.params)] : []),
	]);
	const boxes = rows as { id: string; name: string; role: string | null; totalEmails: number; unreadEmails: number; subscribed?: number; imapUidValidity: number; imapUidNext: number; totalThreads?: number; unreadThreads?: number }[];
	if (ctx.scope) {
		const c = new Map((more.shift() as { id: string; total: number; unread: number }[]).map((r) => [r.id, r]));
		for (const r of boxes) Object.assign(r, { totalEmails: c.get(r.id)?.total ?? 0, unreadEmails: c.get(r.id)?.unread ?? 0 });
	}
	if (wantThreads) {
		const t = new Map((more.shift() as { id: string; totalThreads: number; unreadThreads: number }[]).map((r) => [r.id, r]));
		for (const r of boxes) Object.assign(r, { totalThreads: t.get(r.id)?.totalThreads ?? 0, unreadThreads: t.get(r.id)?.unreadThreads ?? 0 });
	}
	const byId = new Map(boxes.map((r) => [r.id, r]));
	const list = (ids ?? [...byId.keys()]).filter((id) => byId.has(id)).map((id) => {
		const { subscribed, ...r } = byId.get(id)!;
		const order = ROLE_ORDER.indexOf(r.role ?? "");
		return pick(
			{
				...r,
				id: r.id,
				parentId: null,
				sortOrder: order < 0 ? 100 : order + 1,
				isSubscribed: subscribed !== 0,
				myRights: {
					mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true, maySetKeywords: true,
					mayCreateChild: !ctx.scope, mayRename: !r.role && !ctx.scope, mayDelete: !r.role && !ctx.scope, maySubmit: true,
				},
			},
			props && [...new Set(["id", ...props])],
		);
	});
	return {
		accountId: account,
		state,
		list,
		notFound: (ids ?? []).filter((id) => !byId.has(id)),
	};
};

// Reports every current mailbox as updated, with any property, after any change since the client's state.
// ponytail: no mailbox tombstones, so a destroyed label isn't in `destroyed`; a client that sees a
// state change should Mailbox/get the whole list (the web app does). Add tombstones if a client needs them.
const mailboxChanges: Method<Ctx> = async (args, ctx) => {
	const account = accountId(args, ctx);
	const current = await currentState(ctx, account);
	const since = sinceState(args, current);
	const ids = since === current
		? []
		: (await ctx.db.prepare("SELECT id FROM mailboxes WHERE account_id = ?").bind(account).all<{ id: string }>()).results.map((r) => r.id);
	return {
		accountId: account,
		oldState: String(since),
		newState: String(current),
		hasMoreChanges: false,
		created: [],
		updated: ids,
		destroyed: [],
		updatedProperties: null,
	};
};

// ---------- Thread ----------

const threadGet: Method<Ctx> = async (args, ctx) => {
	const account = accountId(args, ctx);
	const ids = idList(args.ids) ?? [];
	if (!ids.length) return { accountId: account, state: String(await currentState(ctx, account)), list: [], notFound: [] };
	const scope = scopeSql(ctx);
	const [results, state] = await withState(ctx, account, chunked(ids).map((part) => ctx.db
		.prepare(`SELECT e.thread_id, e.id FROM emails e WHERE +e.account_id = ? AND e.destroyed_modseq IS NULL AND e.thread_id IN (${part.map(() => "?").join(",")}) AND ${scope.sql} ORDER BY e.received_at`)
		.bind(account, ...part, ...scope.params)));
	const threads = new Map<string, string[]>();
	for (const r of results.flat() as { thread_id: string; id: string }[]) threads.set(r.thread_id, [...(threads.get(r.thread_id) ?? []), r.id]);
	return {
		accountId: account,
		state,
		list: ids.filter((id) => threads.has(id)).map((id) => ({ id, emailIds: threads.get(id) })),
		notFound: ids.filter((id) => !threads.has(id)),
	};
};

// ---------- Email/query ----------

/** fts: a text search is ANDed at the top, so its matches can drive the query. */
type Sql = { sql: string; params: unknown[]; fts?: boolean };
// RFC 8621 keyword: %x21-7E except ( ) { ] % * " \
export const KEYWORD = /^[\x21\x23\x24\x26\x27\x2b-\x5b\x5e-\x7a\x7c-\x7e]+$/;

/** User text -> FTS5 query of quoted tokens, so operators and quotes in input can't break out. */
// Email/query joins, groups by thread and sorts every match before it takes a page, so its cost follows the
// number of matches. "the" matched most of a 65k-message mailbox, ran 2 to 14 s and overloaded D1 for
// everyone on the server. With the cap a search reads at most this many matches (35 ms for the FTS part there).
// A search inside one mailbox doesn't come here for a common word (see emailQuery), so this cap is for
// searches across mailboxes, which the app never makes.
// ponytail: a word with more matches than this searches only the most recently indexed ones, across all
// accounts. Rowids follow arrival, except that a Gmail import indexes in import order. If that bites, drive
// common words from the received_at index and probe FTS per row instead.
export const FTS_CAP = 10_000;
/** Up to this many matches, a search starts from the matches. Past it, a search in a mailbox walks the mailbox. */
export const FTS_FEW = 1000;
/** Filter keys that search text, and the FTS column each is limited to. */
const FTS_COLUMNS: Record<string, string | undefined> = { text: undefined, subject: "subject", body: "body" };

export function ftsQuery(text: string, column?: string): string | null {
	const tokens = text.split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"`);
	if (!tokens.length) return null;
	return column ? `${column} : (${tokens.join(" ")})` : tokens.join(" ");
}

const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const IN_MAILBOX = "e.id IN (SELECT email_id FROM email_mailboxes WHERE mailbox_id = ?)";
const IN_MAILBOX_PROBE = "EXISTS (SELECT 1 FROM email_mailboxes x WHERE x.email_id = e.id AND x.mailbox_id = ?)";

export function compileFilter(f: unknown): Sql {
	if (f === null || f === undefined) return { sql: "1", params: [] };
	if (typeof f !== "object") throw new MethodError("invalidArguments", "filter");
	const filter = f as Record<string, unknown>;

	if ("operator" in filter) {
		const parts = ((filter.conditions as unknown[]) ?? []).map(compileFilter);
		if (!parts.length) throw new MethodError("invalidArguments", "empty conditions");
		const params = parts.flatMap((p) => p.params);
		const joined = parts.map((p) => `(${p.sql})`);
		switch (filter.operator) {
			case "AND": return { sql: joined.join(" AND "), params };
			case "OR": return { sql: joined.join(" OR "), params };
			case "NOT": return { sql: `NOT (${joined.join(" OR ")})`, params };
			default: throw new MethodError("unsupportedFilter", String(filter.operator));
		}
	}

	const clauses: string[] = [];
	const params: unknown[] = [];
	const fts = (text: unknown, column?: string) => {
		const q = ftsQuery(String(text), column);
		if (!q) return;
		clauses.push(`e.id IN (SELECT email_id FROM emails_fts WHERE emails_fts MATCH ? ORDER BY rowid DESC LIMIT ${FTS_CAP})`);
		params.push(q);
	};
	for (const [key, value] of Object.entries(filter)) {
		switch (key) {
			case "inMailbox":
				clauses.push(IN_MAILBOX);
				params.push(value);
				break;
			case "inMailboxOtherThan": {
				const ids = idList(value, "inMailboxOtherThan") ?? [];
				clauses.push(`EXISTS (SELECT 1 FROM email_mailboxes x WHERE x.email_id = e.id AND x.mailbox_id NOT IN (${ids.map(() => "?").join(",") || "''"}))`);
				params.push(...ids);
				break;
			}
			case "before":
			case "after": {
				const t = Date.parse(String(value));
				if (Number.isNaN(t)) throw new MethodError("invalidArguments", key);
				clauses.push(key === "before" ? "e.received_at < ?" : "e.received_at >= ?");
				params.push(t);
				break;
			}
			case "minSize": clauses.push("e.size >= ?"); params.push(Number(value)); break;
			case "maxSize": clauses.push("e.size < ?"); params.push(Number(value)); break;
			case "hasAttachment": clauses.push("e.has_attachment = ?"); params.push(value ? 1 : 0); break;
			case "hasKeyword":
			case "notKeyword": {
				const kw = String(value).toLowerCase();
				if (!KEYWORD.test(kw)) throw new MethodError("invalidArguments", key);
				clauses.push(`json_extract(e.keywords_json, ?) IS ${key === "hasKeyword" ? "NOT " : ""}NULL`);
				params.push(`$."${kw}"`);
				break;
			}
			case "text": fts(value); break;
			case "subject": fts(value, "subject"); break;
			case "body": fts(value, "body"); break;
			// Ours: reached one of these of your addresses ("@domain" for a whole domain). See server/lib/addressed.ts.
			case "addressedTo": {
				const a = addressedSql((idList(value, "addressedTo") ?? []).map(cleanPattern).filter((x): x is string => !!x));
				clauses.push(a.sql);
				params.push(...a.params);
				break;
			}
			case "from":
			case "to":
			case "cc":
				clauses.push(`e.${key}_json LIKE ? ESCAPE '\\'`);
				params.push(like(String(value).toLowerCase()));
				break;
			default:
				throw new MethodError("unsupportedFilter", key);
		}
	}
	// With a text search beside it, the mailbox is checked per match (one primary-key lookup each) instead of
	// read whole. A search then costs what its matches cost, not what the mailbox holds: a word with 42
	// matches in a 50k-message Archive went from 29 ms to 0.3 ms on a local copy.
	const searching = clauses.some((c) => c.includes("emails_fts MATCH"));
	return { sql: clauses.length ? clauses.map((c) => (searching && c === IN_MAILBOX ? IN_MAILBOX_PROBE : c)).join(" AND ") : "1", params, fts: searching };
}

const SORT_COLUMNS: Record<string, string> = { receivedAt: "received_at", sentAt: "sent_at", size: "size" };

export function compileSort(sort: unknown): string {
	if (!sort) return "received_at DESC, id";
	if (!Array.isArray(sort)) throw new MethodError("invalidArguments", "sort");
	const parts = sort.map((c: { property?: string; isAscending?: boolean }) => {
		const col = SORT_COLUMNS[c?.property ?? ""];
		if (!col) throw new MethodError("unsupportedSort", String(c?.property));
		return `${col} ${c.isAscending === false ? "DESC" : "ASC"}`;
	});
	return [...parts, "id"].join(", ");
}

/**
 * The common case, a mailbox newest-first, read from the (mailbox_id, received_at) index: take the newest
 * placements and keep the first per thread, widening the window until enough threads are found. Returns
 * null when the window would get too large, and the caller uses the general query.
 */
async function newestInMailbox(ctx: Ctx, account: string, box: string, collapse: boolean, position: number, limit: number, extra = { sql: "1", params: [] as unknown[] }, matches: string[] = []) {
	const need = position + limit;
	// A search for a common word walks the same index and keeps the rows whose search rowid is among the
	// word's matches. The matches are read as rowids only and the mailbox through two narrow indexes, so a
	// full message row is loaded only for what's returned. CROSS JOIN fixes that order. The + stops SQLite
	// from trying every match against every row.
	const search = matches.length
		? { join: "CROSS JOIN emails_fts_content c ON c.c0 = em.email_id CROSS JOIN", sql: matches.map(() => " AND +c.id IN (SELECT rowid FROM emails_fts WHERE emails_fts MATCH ?)").join("") }
		: { join: "JOIN", sql: "" };
	for (let k = collapse ? Math.max(need * 3, 150) : need; k <= 20_000; k *= 4) {
		const rows = await ctx.db
			.prepare(
				`SELECT em.email_id AS id, e.thread_id FROM email_mailboxes em ${search.join} emails e ON e.id = em.email_id
				WHERE em.mailbox_id = ?${search.sql} AND e.account_id = ? AND e.destroyed_modseq IS NULL AND ${extra.sql}
				ORDER BY em.received_at DESC, em.email_id LIMIT ?`,
			)
			.bind(box, ...matches, account, ...extra.params, k)
			.all<{ id: string; thread_id: string }>();
		if (!collapse) return rows.results.slice(position, need).map((r) => r.id);
		const seen = new Set<string>();
		const ids: string[] = [];
		for (const r of rows.results) {
			if (seen.has(r.thread_id)) continue;
			seen.add(r.thread_id);
			ids.push(r.id);
		}
		if (ids.length >= need || rows.results.length < k) return ids.slice(position, need);
	}
	return null;
}

/**
 * A word with few matches (at most FTS_FEW), in one mailbox, newest first. Starts from the matches, takes
 * each one's date from its mailbox row, which is small, and loads the full message row only for the newest
 * `k`. The email id comes from the (rowid, id) index of migration 0035, not from FTS's own column, which would
 * load each match's message text to read it. The general query loads and sorts a full row per match. The inner LIMIT bounds the work when the
 * word turns out to be common: emailQuery sends this along with the count and drops the answer then.
 */
const matchStmt = (ctx: Ctx, account: string, box: string, extra: { sql: string; params: unknown[] }, match: string, k: number) =>
	ctx.db
		.prepare(
			`SELECT m.id, e.thread_id FROM (
				SELECT x.email_id AS id, x.received_at FROM (SELECT rowid AS r FROM emails_fts WHERE emails_fts MATCH ? LIMIT ${FTS_FEW + 1}) f
				CROSS JOIN emails_fts_content c INDEXED BY emails_fts_content_id ON c.id = f.r
				CROSS JOIN email_mailboxes x ON x.email_id = c.c0 AND x.mailbox_id = ?
				ORDER BY x.received_at DESC, x.email_id LIMIT ?) m
			CROSS JOIN emails e ON e.id = m.id
			WHERE e.account_id = ? AND e.destroyed_modseq IS NULL AND ${extra.sql}
			ORDER BY m.received_at DESC, m.id`,
		)
		.bind(match, box, k, account, ...extra.params);

/** The first email of each thread, in the order given. */
function firstPerThread(rows: { id: string; thread_id: string }[], collapse: boolean): string[] {
	const seen = new Set<string>();
	const ids: string[] = [];
	for (const r of rows) {
		if (collapse && seen.has(r.thread_id)) continue;
		seen.add(r.thread_id);
		ids.push(r.id);
	}
	return ids;
}

/** The window a page needs: three emails per thread wanted when collapsing, which most pages fit in. */
const windowFor = (collapse: boolean, need: number) => (collapse ? Math.max(need * 3, 150) : need);

/** `first`: the rows already fetched with the first window. `total`: how many matches the word has. Widens until the page is full or the window held them all. */
async function matchesInMailbox(ctx: Ctx, account: string, box: string, collapse: boolean, position: number, limit: number, extra: { sql: string; params: unknown[] }, match: string, first: { id: string; thread_id: string }[], total: number) {
	const need = position + limit;
	for (let k = windowFor(collapse, need), rows = first; ; ) {
		const ids = firstPerThread(rows, collapse);
		if (ids.length >= need || k >= total) return ids.slice(position, need);
		k *= 4;
		rows = (await matchStmt(ctx, account, box, extra, match, k).all<{ id: string; thread_id: string }>()).results;
	}
}

const emailQuery: Method<Ctx> = async (args, ctx) => {
	const account = accountId(args, ctx);
	if (args.anchor !== undefined && args.anchor !== null) throw new MethodError("invalidArguments", "anchor is not supported yet");
	const filter = args.filter as Record<string, unknown> | null | undefined;
	const sort = args.sort as { property?: string; isAscending?: boolean }[] | undefined;
	const newestFirst = !sort || (sort.length === 1 && sort[0]!.property === "receivedAt" && sort[0]!.isAscending === false);
	const position0 = Number(args.position ?? 0) || 0;
	// A mailbox newest-first, optionally narrowed to some of your addresses (addressedTo).
	const fast = filter && typeof filter.inMailbox === "string" && Object.keys(filter).every((k) => k === "inMailbox" || k === "addressedTo");
	if (fast && newestFirst && position0 >= 0 && !args.calculateTotal) {
		const limit = Math.min(Number(args.limit ?? QUERY_LIMIT) || QUERY_LIMIT, QUERY_LIMIT);
		const narrow = filter.addressedTo === undefined ? undefined : compileFilter({ addressedTo: filter.addressedTo });
		const scope = scopeSql(ctx);
		const extra = { sql: `${narrow?.sql ?? "1"} AND ${scope.sql}`, params: [...(narrow?.params ?? []), ...scope.params] };
		// queryState in parallel: canCalculateChanges is false, so it needn't match the ids' snapshot.
		const [ids, state] = await Promise.all([newestInMailbox(ctx, account, filter.inMailbox as string, !!args.collapseThreads, position0, limit, extra), currentState(ctx, account)]);
		if (ids) return { accountId: account, queryState: String(state), canCalculateChanges: false, position: position0, ids, limit };
	}
	// A search in a mailbox, which is every search the app makes. A word with few matches goes to the general
	// query below, which starts from the matches. A common word would make that load and sort a full row
	// per match (3 s for "larry" on a cold 65k-message mailbox), so it walks the mailbox by date instead.
	const words = filter && typeof filter.inMailbox === "string" && Object.keys(filter).every((k) => k === "inMailbox" || k === "addressedTo" || Object.hasOwn(FTS_COLUMNS, k))
		? Object.keys(FTS_COLUMNS).filter((k) => k in filter).map((k) => ftsQuery(String(filter[k]), FTS_COLUMNS[k])).filter((m): m is string => !!m)
		: [];
	if (words.length && newestFirst && position0 >= 0 && !args.calculateTotal) {
		const limit = Math.min(Number(args.limit ?? QUERY_LIMIT) || QUERY_LIMIT, QUERY_LIMIT);
		const narrow = filter!.addressedTo === undefined ? undefined : compileFilter({ addressedTo: filter!.addressedTo });
		const scope = scopeSql(ctx);
		const extra = { sql: `${narrow?.sql ?? "1"} AND ${scope.sql}`, params: [...(narrow?.params ?? []), ...scope.params] };
		const box = filter!.inMailbox as string;
		const collapse = !!args.collapseThreads;
		// One round trip for the usual search, one rare word: the state, the count that says whether the word
		// is rare, and the rare-word answer itself, which is bounded and simply dropped if the word is common.
		// Each sequential D1 call costs about 35 ms, more than this query does.
		const single = words.length === 1;
		const began = Date.now();
		const r = await ctx.db.batch([
			stateStmt(ctx, account),
			...words.map((m) => ctx.db.prepare(`SELECT count(*) AS n FROM (SELECT rowid FROM emails_fts WHERE emails_fts MATCH ? LIMIT ${FTS_FEW + 1})`).bind(m)),
			...(single ? [matchStmt(ctx, account, box, extra, words[0]!, windowFor(collapse, position0 + limit))] : []),
		]);
		// Timings only, never the words: where a slow search went, the SQL or the trip to the database.
		console.log("search:", JSON.stringify({ wall: Date.now() - began, sql: r.map((x) => Math.round((x.meta?.duration ?? 0) * 10) / 10), read: r.map((x) => x.meta?.rows_read ?? 0) }));
		const state = (r[0]!.results[0] as { modseq: number } | undefined)?.modseq ?? 0;
		const counts = words.map((_, i) => (r[1 + i]!.results[0] as { n: number } | undefined)?.n ?? 0);
		const common = counts.every((n) => n > FTS_FEW);
		// Several rare words at once go to the general query.
		const ids = common
			? await newestInMailbox(ctx, account, box, collapse, position0, limit, extra, words)
			: single ? await matchesInMailbox(ctx, account, box, collapse, position0, limit, extra, words[0]!, r.at(-1)!.results as { id: string; thread_id: string }[], counts[0]!) : null;
		if (ids) return { accountId: account, queryState: String(state), canCalculateChanges: false, position: position0, ids, limit };
	}
	const filtered = compileFilter(args.filter);
	const scope = scopeSql(ctx);
	const where = { sql: `(${filtered.sql}) AND ${scope.sql}`, params: [...filtered.params, ...scope.params] };
	const order = compileSort(args.sort);
	const limit = Math.min(Number(args.limit ?? QUERY_LIMIT) || QUERY_LIMIT, QUERY_LIMIT);
	// A search starts from its matches. The + keeps the planner off the account indexes: without table
	// statistics it prefers them, walks every message in the account and tests each against the match list.
	const base = `SELECT e.id, e.thread_id, e.received_at, e.sent_at, e.size FROM emails e WHERE ${filtered.fts ? "+" : ""}e.account_id = ? AND e.destroyed_modseq IS NULL AND (${where.sql})`;
	const from = args.collapseThreads
		? `(SELECT * FROM (SELECT f.*, ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY ${order}) AS rn FROM (${base}) f) WHERE rn = 1)`
		: `(${base})`;
	const params = [account, ...where.params];

	let total: number | undefined;
	let position = Number(args.position ?? 0) || 0;
	if (args.calculateTotal || position < 0) {
		total = (await ctx.db.prepare(`SELECT count(*) AS n FROM ${from}`).bind(...params).first<{ n: number }>())?.n ?? 0;
		if (position < 0) position = Math.max(0, total + position);
	}
	const [rows, state] = await Promise.all([
		ctx.db.prepare(`SELECT id FROM ${from} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...params, limit, position).all<{ id: string }>(),
		currentState(ctx, account),
	]);
	return {
		accountId: account,
		queryState: String(state),
		canCalculateChanges: false,
		position,
		ids: rows.results.map((r) => r.id),
		...(args.calculateTotal ? { total } : {}),
		limit,
	};
};

// ---------- Email/get ----------

const DEFAULT_PROPS = [
	"id", "blobId", "threadId", "mailboxIds", "keywords", "size", "receivedAt", "messageId", "inReplyTo", "references",
	"sender", "from", "to", "cc", "bcc", "replyTo", "subject", "sentAt", "hasAttachment", "preview",
	"bodyValues", "textBody", "htmlBody", "attachments", "deliveredTo",
];
// Properties we don't keep in D1; asking for any of them means parsing the raw message from R2.
const RAW_PROPS = new Set(["inReplyTo", "references", "sender", "bcc", "replyTo", "bodyValues", "textBody", "htmlBody", "attachments"]);

const bareIds = (h: string | undefined) => h?.match(/<([^<>\s]+)>/g)?.map((s) => s.slice(1, -1)) ?? null;
const addrs = (list: unknown) => (Array.isArray(list) ? list : list ? [list] : []).flatMap((a: any) =>
	a.group ? a.group.map((g: any) => ({ name: g.name || null, email: g.address })) : [{ name: a.name || null, email: a.address }]) as { name: string | null; email: string }[];

function truncate(value: string, max: number) {
	if (!max || new TextEncoder().encode(value).length <= max) return { value, isEncodingProblem: false, isTruncated: false };
	let out = value.slice(0, max);
	while (new TextEncoder().encode(out).length > max) out = out.slice(0, -1);
	return { value: out, isEncodingProblem: false, isTruncated: true };
}

// ponytail: flat body model (one text part, one html part, attachments). No bodyStructure or
// per-part headers; add when a client needs the full MIME tree.
async function rawProps(ctx: Ctx, id: string, blobKey: string, args: Record<string, unknown>) {
	const obj = await ctx.mail.get(blobKey);
	if (!obj) return {};
	const m = await PostalMime.parse(await obj.arrayBuffer());
	const textPart = m.text != null ? { partId: "text", blobId: null, size: m.text.length, type: "text/plain", charset: "utf-8", disposition: null, cid: null, name: null } : null;
	const htmlPart = m.html != null ? { partId: "html", blobId: null, size: m.html.length, type: "text/html", charset: "utf-8", disposition: null, cid: null, name: null } : null;
	const max = Number(args.maxBodyValueBytes ?? 0) || 0;
	const all = !!args.fetchAllBodyValues;
	const bodyValues: Record<string, unknown> = {};
	if (textPart && (all || args.fetchTextBodyValues)) bodyValues.text = truncate(m.text!, max);
	if (htmlPart && (all || args.fetchHTMLBodyValues)) bodyValues.html = truncate(m.html!, max);
	return {
		inReplyTo: bareIds(m.inReplyTo),
		references: bareIds(m.references),
		sender: m.sender ? addrs(m.sender) : null,
		bcc: m.bcc ? addrs(m.bcc) : null,
		replyTo: m.replyTo ? addrs(m.replyTo) : null,
		textBody: textPart ? [textPart] : htmlPart ? [htmlPart] : [],
		htmlBody: htmlPart ? [htmlPart] : textPart ? [textPart] : [],
		bodyValues,
		// The AMP alternative (text/x-amp-html) parses as an attachment; it's a body, so hide it. Indexes
		// stay the parser's, since blobIds point at them.
		attachments: m.attachments.flatMap((a, i) => a.mimeType === "text/x-amp-html" ? [] : [{
			partId: `a${i}`,
			blobId: `${id}_${i}`,
			size: typeof a.content === "string" ? a.content.length : a.content.byteLength,
			name: a.filename ?? null,
			type: a.mimeType,
			charset: null,
			disposition: a.disposition,
			cid: a.contentId?.replace(/^<|>$/g, "") ?? null,
		}]),
	};
}

const HEADER_MAX = 65536;

/**
 * The raw header block, through the blank line, one char per byte so non-UTF-8 headers survive JSON.
 * A range read: IMAP clients sync a folder by fetching headers of every message, and the bodies
 * would be most of the bytes.
 */
async function rawHeader(mail: R2Bucket, key: string): Promise<string | null> {
	const obj = await mail.get(key, { range: { offset: 0, length: HEADER_MAX } });
	if (!obj) return null;
	const b = new Uint8Array(await obj.arrayBuffer());
	let end = b.length;
	for (let i = 0; i < b.length - 1; i++) {
		if (b[i] !== 10) continue;
		if (b[i + 1] === 10) { end = i + 2; break; }
		if (b[i + 1] === 13 && b[i + 2] === 10) { end = i + 3; break; }
	}
	let s = "";
	for (let i = 0; i < end; i++) s += String.fromCharCode(b[i]!);
	return s;
}

const emailGet: Method<Ctx> = async (args, ctx) => {
	const account = accountId(args, ctx);
	const ids = idList(args.ids);
	if (!ids) throw new MethodError("requestTooLarge", "ids: null is not supported; query first");
	const props = [...new Set(["id", ...(idList(args.properties, "properties") ?? DEFAULT_PROPS)])];
	if (!ids.length) return { accountId: account, state: String(await currentState(ctx, account)), list: [], notFound: [] };

	const parts = chunked(ids);
	const scope = scopeSql(ctx);
	const [results, state] = await withState(ctx, account, parts.flatMap((part) => {
		const marks = part.map(() => "?").join(",");
		return [
			ctx.db.prepare(`SELECT * FROM emails e WHERE +e.account_id = ? AND e.destroyed_modseq IS NULL AND e.id IN (${marks}) AND ${scope.sql}`).bind(account, ...part, ...scope.params),
			ctx.db.prepare(`SELECT email_id, mailbox_id, uid FROM email_mailboxes WHERE email_id IN (${marks})`).bind(...part),
		];
	}));
	const rows = { results: results.filter((_, i) => i % 2 === 0).flat() };
	const boxes = { results: results.filter((_, i) => i % 2 === 1).flat() };
	const mailboxIds = new Map<string, Record<string, true>>();
	const imapUids = new Map<string, Record<string, number>>();
	for (const b of boxes!.results as { email_id: string; mailbox_id: string; uid: number }[]) {
		mailboxIds.set(b.email_id, { ...mailboxIds.get(b.email_id), [b.mailbox_id]: true });
		imapUids.set(b.email_id, { ...imapUids.get(b.email_id), [b.mailbox_id]: b.uid });
	}
	const needRaw = props.some((p) => RAW_PROPS.has(p));
	const list = await Promise.all((rows!.results as Record<string, any>[]).map(async (e) => {
		const full: Record<string, unknown> = {
			id: e.id,
			blobId: e.id,
			threadId: e.thread_id,
			mailboxIds: mailboxIds.get(e.id) ?? {},
			// Ours (IMAP capability): the email's IMAP UID in each of its mailboxes. Only when asked for.
			imapUids: imapUids.get(e.id) ?? {},
			keywords: JSON.parse(e.keywords_json),
			size: e.size,
			receivedAt: new Date(e.received_at).toISOString(),
			messageId: e.message_id ? [e.message_id.replace(/^<|>$/g, "")] : null,
			from: JSON.parse(e.from_json),
			to: JSON.parse(e.to_json),
			cc: JSON.parse(e.cc_json),
			// Not JMAP: the Delivered-To path, first hop first (see migration 0010).
			deliveredTo: e.delivered_json ? JSON.parse(e.delivered_json) : null,
			subject: e.subject,
			sentAt: e.sent_at ? new Date(e.sent_at).toISOString() : null,
			hasAttachment: !!e.has_attachment,
			preview: e.preview,
			...(needRaw ? await rawProps(ctx, e.id, e.blob_key, args) : {}),
			// Ours (IMAP capability). Only when asked for.
			...(props.includes("imapHeader") ? { imapHeader: await rawHeader(ctx.mail, e.blob_key) } : {}),
		};
		return pick(full, props);
	}));
	// Same order as requested, so a client can zip it with the query's ids.
	const byId = new Map(list.map((e) => [e.id as string, e]));
	return { accountId: account, state, list: ids.filter((id) => byId.has(id)).map((id) => byId.get(id)), notFound: ids.filter((id) => !byId.has(id)) };
};

const emailChanges: Method<Ctx> = async (args, ctx) => {
	const account = accountId(args, ctx);
	const current = await currentState(ctx, account);
	const since = sinceState(args, current);
	const max = Math.min(Number(args.maxChanges ?? 0) || LIMITS.maxObjectsInGet, LIMITS.maxObjectsInGet);
	// Every write bumps modseq per email, so no two rows share one and a page can end on any row.
	const scope = scopeSql(ctx);
	// The purge floor rides in the same round trip. Below it, some destroyed emails have no row left to
	// report (server/lib/purge.ts), so the honest answer is that the changes can't be worked out.
	const [found, floor] = await ctx.db.batch([
		ctx.db
			.prepare(`SELECT e.id, e.created_modseq, e.updated_modseq, e.destroyed_modseq FROM emails e WHERE e.account_id = ? AND e.updated_modseq > ? AND ${scope.sql} ORDER BY e.updated_modseq LIMIT ?`)
			.bind(account, since, ...scope.params, max + 1),
		ctx.db.prepare("SELECT purged_modseq FROM accounts WHERE id = ?").bind(account),
	]);
	if (since < ((floor!.results[0] as { purged_modseq: number } | undefined)?.purged_modseq ?? 0)) throw new MethodError("cannotCalculateChanges");
	const rows = found as D1Result<{ id: string; created_modseq: number; updated_modseq: number; destroyed_modseq: number | null }>;
	const more = rows.results.length > max;
	const page = rows.results.slice(0, max);
	const created: string[] = [];
	const updated: string[] = [];
	const destroyed: string[] = [];
	for (const r of page) {
		const isNew = r.created_modseq > since;
		if (r.destroyed_modseq !== null) {
			if (!isNew) destroyed.push(r.id); // created and destroyed since: the client never saw it
		} else (isNew ? created : updated).push(r.id);
	}
	return {
		accountId: account,
		oldState: String(since),
		newState: String(more ? page.at(-1)!.updated_modseq : current),
		hasMoreChanges: more,
		created,
		updated,
		destroyed,
	};
};

// ---------- Email/imapUids (ours, IMAP capability) ----------

const UIDS_LIMIT = 5000;

/**
 * Every email in one mailbox as [uid, emailId, keywords, size, receivedAt], in uid order, paged by afterUid. What an IMAP
 * SELECT needs, in pages far bigger than Email/query's. Then Email/changes from `state` keeps it current.
 */
const emailImapUids: Method<Ctx> = async (args, ctx) => {
	const account = accountId(args, ctx);
	if (typeof args.mailboxId !== "string") throw new MethodError("invalidArguments", "mailboxId");
	const afterUid = Number(args.afterUid ?? 0);
	if (!Number.isInteger(afterUid) || afterUid < 0) throw new MethodError("invalidArguments", "afterUid");
	const limit = Math.min(Number(args.limit ?? UIDS_LIMIT) || UIDS_LIMIT, UIDS_LIMIT);
	// State first: anything written after it shows up in Email/changes, possibly twice, which is harmless.
	const state = String(await currentState(ctx, account));
	const box = await ctx.db
		.prepare("SELECT uidvalidity, uidnext FROM mailboxes WHERE id = ? AND account_id = ?")
		.bind(args.mailboxId, account)
		.first<{ uidvalidity: number; uidnext: number }>();
	if (!box) throw new MethodError("notFound", "mailboxId");
	const scope = scopeSql(ctx);
	const rows = await ctx.db
		.prepare(
			`SELECT em.uid, e.id, e.keywords_json, e.size, e.received_at FROM email_mailboxes em JOIN emails e ON e.id = em.email_id
			WHERE em.mailbox_id = ? AND e.account_id = ? AND e.destroyed_modseq IS NULL AND em.uid > ? AND ${scope.sql} ORDER BY em.uid LIMIT ?`,
		)
		.bind(args.mailboxId, account, afterUid, ...scope.params, limit + 1)
		.all<{ uid: number; id: string; keywords_json: string; size: number; received_at: number }>();
	const page = rows.results.slice(0, limit);
	return {
		accountId: account,
		mailboxId: args.mailboxId,
		state,
		uidValidity: box.uidvalidity,
		uidNext: box.uidnext,
		// [uid, emailId, keywords, size, receivedAt in ms]: everything a client's folder sync asks for but headers.
		list: page.map((r) => [r.uid, r.id, Object.keys(JSON.parse(r.keywords_json)), r.size, r.received_at]),
		hasMore: rows.results.length > limit,
	};
};

const emailImportMethod: Method<Ctx> = async (args, ctx) => {
	const account = accountId(args, ctx);
	await requireInScope(ctx, account, refsIn(args.emails));
	const r = await ctx.writer(account).emailImport(account, args, ctx.createdIds);
	if (r.error) throw new MethodError(r.error);
	Object.assign(ctx.createdIds, r.createdIds);
	return r.response!;
};

const emailSetMethod: Method<Ctx> = async (args, ctx) => {
	const account = accountId(args, ctx);
	if (ctx.scope) {
		const ids = [...Object.keys((args.update ?? {}) as object), ...((args.destroy ?? []) as string[]), ...refsIn(args.create)];
		await requireInScope(ctx, account, ids);
	}
	const r = await ctx.writer(account).emailSet(account, args, ctx.createdIds);
	if (r.error) throw new MethodError(r.error);
	Object.assign(ctx.createdIds, r.createdIds);
	return r.response!;
};

const mailboxSetMethod: Method<Ctx> = async (args, ctx) => {
	const account = accountId(args, ctx);
	if (ctx.scope) throw outOfScope();
	const r = await ctx.writer(account).mailboxSet(account, args);
	if (r.error) throw new MethodError(r.error);
	Object.assign(ctx.createdIds, r.createdIds);
	return r.response!;
};

const submissionSetMethod: Method<Ctx> = async (args, ctx) => {
	const account = accountId(args, ctx);
	if (ctx.scope) {
		const mine = new Set((await identities(ctx.db, account)).filter((i) => addressInScope(i.email, ctx.scope)).map((i) => i.id));
		const creates = Object.values((args.create ?? {}) as Record<string, { identityId?: unknown }>);
		if (creates.some((c) => typeof c?.identityId !== "string" || !mine.has(c.identityId))) throw outOfScope();
		await requireInScope(ctx, account, refsIn(args.create));
		// Undo or reschedule of a held send acts on an existing submission; keep those to the scope too.
		const held = new Map((await scheduledSubmissions(ctx.db, account)).map((s) => [s.id, s.identityId]));
		const touched = [...Object.keys((args.update ?? {}) as object), ...((args.destroy ?? []) as string[])];
		if (touched.some((id) => held.has(id) && !mine.has(held.get(id)!))) throw outOfScope();
	}
	const r = await ctx.writer(account).submit(account, args, ctx.createdIds);
	Object.assign(ctx.createdIds, r.createdIds);
	return { ...r.response!, ...(r.also && { [ALSO]: [r.also] }) };
};

const identityGet: Method<Ctx> = async (args, ctx) => {
	const account = accountId(args, ctx);
	const list = (await identities(ctx.db, account)).filter((i) => addressInScope(i.email, ctx.scope));
	const ids = idList(args.ids);
	return {
		accountId: account,
		state: "0",
		list: ids ? list.filter((i) => ids.includes(i.id)) : list,
		notFound: ids ? ids.filter((id) => !list.some((i) => i.id === id)) : [],
	};
};

const identitySet: Method<Ctx> = async (args, ctx) => {
	const account = accountId(args, ctx);
	if (ctx.scope) throw outOfScope();
	if (args.create || args.destroy) throw new MethodError("invalidArguments", "identities are managed by the operator; only update is supported");
	return identityUpdate(ctx.db, account, args.update as Record<string, unknown>);
};

/** Only held (scheduled) submissions are kept; sent ones aren't stored. */
const submissionGet: Method<Ctx> = async (args, ctx) => {
	const account = accountId(args, ctx);
	const mine = new Set((await identities(ctx.db, account)).filter((i) => addressInScope(i.email, ctx.scope)).map((i) => i.id));
	const list = (await scheduledSubmissions(ctx.db, account)).filter((s) => mine.has(s.identityId));
	const ids = idList(args.ids);
	return {
		accountId: account,
		state: "0",
		list: ids ? list.filter((s) => ids.includes(s.id)) : list,
		notFound: ids ? ids.filter((id) => !list.some((s) => s.id === id)) : [],
	};
};

export const mailMethods: Record<string, Method<Ctx>> = {
	"Core/echo": (args) => args,
	"Mailbox/get": mailboxGet,
	"Mailbox/changes": mailboxChanges,
	"Mailbox/set": mailboxSetMethod,
	"Thread/get": threadGet,
	"Email/query": emailQuery,
	"Email/get": emailGet,
	"Email/changes": emailChanges,
	"Email/set": emailSetMethod,
	"Email/import": emailImportMethod,
	"Email/imapUids": emailImapUids,
	"EmailSubmission/set": submissionSetMethod,
	"Identity/get": identityGet,
	"Identity/set": identitySet,
	"EmailSubmission/get": submissionGet,
};
