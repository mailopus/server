// Fills emails.delivered_json for mail stored before migration 0010, from each raw message's headers.
// The cron queues a run while rows are missing one; a run stops after RUN_MS, before the next tick,
// so runs never overlap. When nothing is missing, the cron's check is one indexed lookup.
import { deliveredToFromHeaders } from "../utils/mail.ts";

const CHUNK = 200; // D1 has thrown "overloaded" under import load; keep write batches modest.
const CONCURRENCY = 24;
const HEAD_BYTES = 32 * 1024; // Delivered-To sits at the top; a header block past this is cut short.
const RUN_MS = 4 * 60_000;

export async function deliveredPending(env: Env) {
	return !!(await env.DB.prepare("SELECT 1 FROM emails WHERE delivered_json IS NULL LIMIT 1").first());
}

/** Returns how many rows it filled. */
export async function backfillDelivered(env: Env, budgetMs = RUN_MS): Promise<number> {
	const until = Date.now() + budgetMs;
	let done = 0;
	while (Date.now() < until) {
		const { results } = await env.DB.prepare("SELECT id, blob_key FROM emails WHERE delivered_json IS NULL LIMIT ?")
			.bind(CHUNK).all<{ id: string; blob_key: string }>();
		if (!results.length) break;
		const paths: string[] = new Array(results.length);
		let next = 0;
		await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
			while (next < results.length) {
				const i = next++;
				const obj = await env.MAIL.get(results[i]!.blob_key, { range: { offset: 0, length: HEAD_BYTES } });
				// A missing blob still gets [] so the run doesn't pick it up forever.
				paths[i] = JSON.stringify(obj ? deliveredToFromHeaders(await obj.text()) : []);
			}
		}));
		await env.DB.batch(results.map((r, i) => env.DB.prepare("UPDATE emails SET delivered_json = ? WHERE id = ?").bind(paths[i], r.id)));
		done += results.length;
	}
	return done;
}
