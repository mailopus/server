// Admin: starts a Gmail import, { workspace, sourceEmail, accountId }. See startImport in server/lib/import-jobs.ts.
import { importOverview, startImport } from "../../lib/import-jobs";

export default defineEventHandler((event) =>
	// true: asks for the passkey first, since a job copies a whole mailbox into an account.
	importApi(event, async (db, env) => {
		await startImport(db, env, await readBody(event));
		return importOverview(db, env);
	}, true));
