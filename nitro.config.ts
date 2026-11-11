// The mail server alone, without the UI: what a customer's Worker runs (`pnpm build`). app.mailopus.net
// builds this same server/ together with the UI from its own Nuxt config, so the settings below (entry,
// moduleSideEffects, handlers) have to match that config's nitro block.
import { defineNitroConfig } from "nitropack/config";

export default defineNitroConfig({
	compatibilityDate: "2026-11-01",
	srcDir: "server",
	preset: "cloudflare_module",
	entry: "./entry.ts",
	// Nitro treats packages as side-effect free and would drop the bare import in entry.ts.
	moduleSideEffects: ["reflect-metadata"],
	// JMAP autodiscovery (RFC 8620 §2.2) points at the same session handler.
	handlers: [{ route: "/.well-known/jmap", handler: "./server/routes/jmap/session.get.ts" }],
	// pnpm e2e builds this next to the full build in .output, so it puts this one elsewhere.
	...(process.env.MAILOPUS_SERVER_OUT && { output: { dir: process.env.MAILOPUS_SERVER_OUT } }),
});
