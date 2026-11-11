import { kickJobs, runPages } from "../lib/importer";
import { backfillDelivered, deliveredPending } from "../lib/backfill";

type Job = { jobId: string } | { backfill: "delivered" };

export default defineNitroPlugin((nitro) => {
	nitro.hooks.hook("cloudflare:queue", async ({ batch, env }) => {
		for (const msg of (batch as MessageBatch<Job>).messages) {
			if ("backfill" in msg.body) {
				console.log("backfill: delivered_json filled", await backfillDelivered(env as Env).catch((e) => (console.warn("backfill failed", e), 0)));
				msg.ack();
				continue;
			}
			try {
				if (await runPages(env as Env, msg.body.jobId)) await (env as Env).IMPORT_QUEUE.send({ jobId: msg.body.jobId });
				msg.ack();
			} catch (e) {
				console.warn("import: page failed, retrying", msg.body.jobId, (e as Error).message);
				await (env as Env).DB.prepare("UPDATE import_jobs SET last_error = ?, updated_at = ? WHERE id = ?")
					.bind(`${(e as Error).stack ?? (e as Error).message}`.slice(0, 1500), Date.now(), msg.body.jobId).run();
				msg.retry({ delaySeconds: 60 });
			}
		}
	});
	nitro.hooks.hook("cloudflare:scheduled", async ({ env }) => {
		const n = await kickJobs(env as Env);
		if (n) console.log("import: kicked", n, "jobs");
		if (await deliveredPending(env as Env)) await (env as Env).IMPORT_QUEUE.send({ backfill: "delivered" });
	});
});
