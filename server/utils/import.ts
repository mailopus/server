import type { H3Event } from "h3";
import { ImportError, requireAdmin } from "../lib/import-jobs";

/**
 * What every /api/import route shares: a passkey session (never an app password), the admin, and
 * ImportError turned into its status. verify: a passkey check in the last five minutes too.
 */
export async function importApi<T>(event: H3Event, run: (db: D1Database, env: Env) => Promise<T>, verify = false): Promise<T> {
	const env = cfEnv(event);
	try {
		// Admin before the passkey check, so someone who isn't never gets asked for a passkey for nothing.
		await requireAdmin(env.DB, await requireSessionUser(event));
		if (verify) await requireRecentVerification(event);
		return await run(env.DB, env);
	} catch (e) {
		if (e instanceof ImportError) throw createError({ statusCode: e.status, statusMessage: e.message });
		throw e;
	}
}
