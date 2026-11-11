// How the plugin is reached. What it does is in app.ts.
import { WorkerEntrypoint } from "cloudflare:workers";
import { type Env, handle, handlePublic } from "./app.ts";

/**
 * For your Mailopus server, over a service binding with "entrypoint": "Plugin". Only a Worker in
 * your own account that you bound to this one can call it, so it asks for no key.
 */
export class Plugin extends WorkerEntrypoint<Env> {
	override fetch(request: Request): Promise<Response> {
		return handle(request, this.env);
	}
}

/** The public address, which wrangler.jsonc leaves off. With it on, every call needs PLUGIN_KEY. */
export default { fetch: handlePublic } satisfies ExportedHandler<Env>;
