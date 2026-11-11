// Worker entry: the auth gate in front of Nitro, plus our Durable Object classes.
// First: SimpleWebAuthn's verifiers load @peculiar/x509 -> tsyringe, which throws at import without this polyfill.
import "reflect-metadata";
import nitro from "nitropack/presets/cloudflare/runtime/cloudflare-module";
import { gate } from "./lib/gate";
import { ingestRaw } from "./lib/ingest";
import { LIVE_PATH, liveSocket } from "./lib/live";

export { Account } from "./durable/account";

export default {
	...nitro,
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const live = new URL(request.url).pathname === LIVE_PATH;
		return gate(request, env, () => (live ? liveSocket(request, env) : nitro.fetch(request, env, ctx)));
	},
	// Email Routing hands us every address on a routed domain. Handled here rather than in a Nitro hook,
	// which runs in waitUntil, so an unknown address can be refused at SMTP time and the sender gets a bounce.
	async email(message: ForwardableEmailMessage, env: Env) {
		// Email Routing caps messages at 25 MiB, so buffering is fine.
		const raw = await new Response(message.raw).arrayBuffer();
		const result = await ingestRaw(env, { from: message.from, to: message.to, raw });
		if (!result) {
			console.warn("email: no account for recipient", message.to);
			message.setReject("Address not found");
		} else console.log("email: stored", result);
	},
};
