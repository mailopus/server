// The handshake between the UI and a mail server that may be older or newer than it.
// The UI at app.mailopus.net is always the latest build, while a customer's Worker runs whatever they last
// deployed. The server says which API level it speaks in its JMAP session, under SERVER.
// Plain module: the session route, the UI and tests/api.test.ts all import it.

/** Our session capability. A name, not a host: the same string on every instance. */
export const SERVER = "https://mailopus.net/jmap/server";

/**
 * The API level this build speaks. Bump it when the UI starts relying on something a server built before
 * the bump doesn't have: a new method, property or route. Bug fixes and server-only changes don't bump it.
 */
export const API = 7;

/**
 * The oldest server API level this UI still drives. Raise it only once the level being dropped
 * has been superseded for 90 days. A server deployed before the handshake existed reports no
 * level, which counts as 0.
 */
export const MIN_SERVER_API = 0;

/**
 * How a server's session fits this UI.
 * - "ok": same API level.
 * - "behind": older but supported; features that need a newer level are off. Nudge an update.
 * - "unsupported": older than MIN_SERVER_API. The UI can't promise to work, so it stops and says update.
 * - "ahead": newer than this UI, so this tab holds an old build. Reloading fixes it.
 */
export type Fit = "ok" | "behind" | "unsupported" | "ahead";

/** The server's API level from a JMAP session. 0 when it predates the handshake. */
export function serverApi(session: { capabilities?: Record<string, unknown> }): number {
	const api = (session.capabilities?.[SERVER] as { api?: unknown } | undefined)?.api;
	return Number.isInteger(api) ? (api as number) : 0;
}

export function fit(server: number, ui = API, min = MIN_SERVER_API): Fit {
	if (server > ui) return "ahead";
	if (server < min) return "unsupported";
	return server < ui ? "behind" : "ok";
}
