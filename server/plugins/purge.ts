import { purgeTombstones, sweepUploads } from "../lib/purge";

// Housekeeping on the 5-minute cron (server/lib/purge.ts): uploads nobody attached within a week, app-password
// sign-ins older than a month, and tombstones, which are purged only when PURGE_TOMBSTONES_DAYS is set.
export default defineNitroPlugin((nitro) => {
	nitro.hooks.hook("cloudflare:scheduled", async ({ env }) => {
		const n = await purgeTombstones(env as Env).catch((e) => (console.warn("purge failed", (e as Error).message), 0));
		if (n) console.log("purge: removed", n, "tombstones");
		const u = await sweepUploads((env as Env).MAIL).catch((e) => (console.warn("upload sweep failed", (e as Error).message), 0));
		if (u) console.log("purge: removed", u, "stale uploads");
		// Settings shows a month of app-password sign-ins (migrations/0036).
		await (env as Env).DB.prepare("DELETE FROM app_password_signins WHERE last_at < ?").bind(Date.now() - 30 * 86_400_000).run()
			.catch((e) => console.warn("signin sweep failed", (e as Error).message));
	});
});
