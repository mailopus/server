// Minimal D1 over node:sqlite with the real migrations applied, for tests.
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { provision } from "../server/lib/provision.ts";

/** Fixed test ids: "acct", "user", "ident", and "box-<role>" for mailboxes. */
const TEST_IDS = (kind: string) => ({ user: "user", account: "acct", identity: "ident" })[kind] ?? `box-${kind.split(":")[1]}`;
export const ME = "me@mailopus.net";

/** empty: the migrations only, like a fresh deploy before anyone claims it. */
export function testD1(o: { empty?: boolean } = {}) {
	const db = new DatabaseSync(":memory:");
	for (const f of readdirSync("migrations").sort()) db.exec(readFileSync(`migrations/${f}`, "utf8"));
	if (!o.empty) for (const st of provision({ name: "Me", email: ME, routes: ["*@mailopus.net"], makeId: TEST_IDS }).statements) {
		db.prepare(st.sql).run(...st.params);
	}
	// The test user is the instance's admin, as the claimer would be.
	if (!o.empty) db.exec("UPDATE users SET is_admin = 1");
	const stmt = (sql: string, params: unknown[] = []) => ({
		// D1 refuses more than 100 bound parameters per query ("too many SQL variables"); SQLite allows thousands.
		bind: (...p: unknown[]) => {
			if (p.length > 100) throw new Error(`D1_ERROR: too many SQL variables (${p.length})`);
			return stmt(sql, p);
		},
		all: async () => ({ results: db.prepare(sql).all(...(params as never[])) }),
		first: async () => db.prepare(sql).get(...(params as never[])) ?? null,
		// D1 reports changes under meta.
		run: async () => { const r = db.prepare(sql).run(...(params as never[])); return { ...r, meta: { changes: Number(r.changes) } }; },
	});
	return {
		raw: db,
		prepare: (sql: string) => stmt(sql),
		batch: async (list: ReturnType<typeof stmt>[]) => Promise.all(list.map((s) => s.all())),
	} as unknown as D1Database & { raw: DatabaseSync };
}
