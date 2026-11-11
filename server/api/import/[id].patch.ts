// Admin: { action: "pause" | "resume" | "rescan" } on one import job. See controlImport in server/lib/import-jobs.ts.
import { controlImport, importOverview } from "../../lib/import-jobs";

export default defineEventHandler((event) =>
	importApi(event, async (db, env) => {
		await controlImport(db, getRouterParam(event, "id"), (await readBody<{ action?: unknown }>(event))?.action);
		return importOverview(db, env);
	}));
