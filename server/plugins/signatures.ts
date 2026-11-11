import { syncDue } from "../lib/signatures";

// Signature providers (Swiftly) sync on the 5-minute cron, each identity at most every 30 minutes.
export default defineNitroPlugin((nitro) => {
	nitro.hooks.hook("cloudflare:scheduled", async ({ env }) => {
		const n = await syncDue((env as Env).DB).catch((e) => (console.warn("signature sync failed", e), 0));
		if (n) console.log("signatures: synced", n);
	});
});
