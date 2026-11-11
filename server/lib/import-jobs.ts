// Gmail import jobs for Settings (server/api/import): the admin starts one, watches it, pauses, resumes
// and rescans. The same rows and SQL as `mailopus import` in cli/cli.mjs, which stays as the terminal way. The cron
// starts pending jobs and the queue runs them (server/lib/importer.ts).
// Plain module: no Nitro imports, so tests/import-jobs.test.ts runs it against node:sqlite.
import { EMAIL } from "./addresses.ts";
import { newId } from "./provision.ts";

export class ImportError extends Error {
	status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}

export type ImportAction = "pause" | "resume" | "rescan";

// The same updates as `mailopus import`, by exact id instead of an id prefix. RETURNING says whether a row moved.
const ACTIONS: Record<ImportAction, string> = {
	pause: "UPDATE import_jobs SET status = 'paused', updated_at = ? WHERE id = ? AND status != 'done' RETURNING id",
	resume: "UPDATE import_jobs SET status = 'pending', updated_at = ? WHERE id = ? AND status != 'done' RETURNING id",
	// Walks the mailbox again from the start. Stored mail is skipped, so only missing messages are fetched.
	rescan: "UPDATE import_jobs SET status = 'pending', page_token = NULL, failed = 0, last_error = NULL, updated_at = ? WHERE id = ? AND status IN ('done', 'paused', 'failed') RETURNING id",
};

/** Import reads a whole Workspace mailbox with the server's key, so it is the admin's alone. */
export async function requireAdmin(db: D1Database, userId: string) {
	const row = await db.prepare("SELECT is_admin FROM users WHERE id = ?").bind(userId).first<{ is_admin: number }>();
	if (!row?.is_admin) throw new ImportError("Only the admin can import mail.", 403);
}

/**
 * The workspaces this Worker holds a service-account key for: GOOGLE_SA_<NAME> secrets, as lowercased
 * names. Names only, never the values. Upper case only, since that is the name the importer reads.
 */
export const workspaces = (env: object) =>
	Object.entries(env).flatMap(([k, v]) => {
		const name = /^GOOGLE_SA_([A-Z0-9]+)$/.exec(k)?.[1];
		return name && typeof v === "string" && v ? [name.toLowerCase()] : [];
	}).sort();

type Row = {
	id: string; source_email: string; account_id: string; account_name: string; status: string; pages: number; imported: number;
	merged: number; skipped: number; failed: number; messages_total: number | null; last_error: string | null; created_at: number; updated_at: number;
};

/** Every job on the server, oldest first, with the workspaces a new one can use. */
export async function importOverview(db: D1Database, env: object) {
	const { results } = await db.prepare(
		`SELECT j.id, j.source_email, j.account_id, a.name AS account_name, j.status, j.pages, j.imported, j.merged, j.skipped, j.failed,
			j.messages_total, j.last_error, j.created_at, j.updated_at
		FROM import_jobs j JOIN accounts a ON a.id = j.account_id ORDER BY j.created_at`,
	).all<Row>();
	return {
		workspaces: workspaces(env),
		jobs: results.map((j) => ({
			id: j.id, sourceEmail: j.source_email, account: { id: j.account_id, name: j.account_name }, status: j.status, pages: j.pages,
			imported: j.imported, merged: j.merged, skipped: j.skipped, failed: j.failed, messagesTotal: j.messages_total,
			// The queue stores a whole stack trace (server/plugins/import.ts). Settings gets its first line.
			lastError: j.last_error?.split("\n")[0]!.trim().slice(0, 200) || null,
			createdAt: j.created_at, updatedAt: j.updated_at,
		})),
	};
}

/** Queues a job: { workspace, sourceEmail, accountId }. The cron starts it within 5 minutes. */
export async function startImport(db: D1Database, env: object, input: { workspace?: unknown; sourceEmail?: unknown; accountId?: unknown } | null, now = Date.now()) {
	const workspace = typeof input?.workspace === "string" ? input.workspace.toLowerCase() : "";
	const source = typeof input?.sourceEmail === "string" ? input.sourceEmail.trim().toLowerCase() : "";
	const account = typeof input?.accountId === "string" ? input.accountId : "";
	if (!/^[a-z0-9]+$/.test(workspace) || !workspaces(env).includes(workspace)) throw new ImportError("This server has no service account key by that name.");
	if (!EMAIL.test(source)) throw new ImportError("That isn't an email address.");
	if (!(await db.prepare("SELECT 1 FROM accounts WHERE id = ?").bind(account).first())) throw new ImportError("No such account.");
	const id = newId();
	// The script's insert, guarded in the same statement so two clicks can't start the same mailbox twice.
	// A done or failed job doesn't block a new one, though Rescan on it does the same without a second row.
	const r = await db.prepare(
		`INSERT INTO import_jobs (id, account_id, workspace, source_email, created_at, updated_at)
		SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM import_jobs WHERE account_id = ? AND source_email = ? AND status IN ('pending', 'running', 'paused')) RETURNING id`,
	).bind(id, account, workspace, source, now, now, account, source).first();
	if (!r) throw new ImportError(`An import of ${source} into that account is already under way.`, 409);
	return id;
}

export async function controlImport(db: D1Database, id: unknown, action: unknown, now = Date.now()) {
	const sql = typeof action === "string" && Object.hasOwn(ACTIONS, action) ? ACTIONS[action as ImportAction] : null;
	if (!sql) throw new ImportError("action must be pause, resume or rescan");
	const r = await db.prepare(sql).bind(now, typeof id === "string" ? id : "").first();
	if (!r) throw new ImportError(action === "rescan" ? "Only a finished, paused or failed import can be rescanned." : `No unfinished import to ${action}.`, 409);
}
