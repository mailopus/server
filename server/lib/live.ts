// /jmap/ws: hands an authenticated WebSocket to the user's socket hub, a Durable Object that pushes changes
// for all their accounts and answers JMAP requests (RFC 8887).
import { type Auth, requestAuth, sessionToken, sha256, socketTicket, takeSocketTicket } from "./auth.ts";
import { type SocketAuth, appPasswordCred, sessionCred } from "./socket.ts";

export const LIVE_PATH = "/jmap/ws";

/** The hub is an Account object under a name no account id can take. */
export const hubName = (userId: string) => `user:${userId}`;

/**
 * Closes the sockets a credential opened. A socket is checked once, at the upgrade, so without this one
 * opened with a leaked app password would keep reading and sending after the password was revoked.
 * Never throws: signing out and revoking must still succeed.
 */
export async function closeSockets(env: Env, userId: string, cred: string) {
	try {
		await (env.ACCOUNT.get(env.ACCOUNT.idFromName(hubName(userId))) as unknown as { closeSockets(cred: string): Promise<number> }).closeSockets(cred);
	} catch (e) {
		console.warn("closeSockets:", (e as Error).message);
	}
}

export async function liveSocket(request: Request, env: Env): Promise<Response> {
	if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected a WebSocket upgrade", { status: 426 });
	// The gate already required a session or app password; resolve whose it is.
	// A ticket (the UI on another origin) is spent here; the gate let it through unchecked for that.
	const ticket = socketTicket(request.headers);
	const ticketed = ticket ? await takeSocketTicket(env.DB, ticket) : null;
	const auth: Auth | null = ticket ? ticketed && { userId: ticketed.userId, scope: null } : await requestAuth(env.DB, request.headers, LIVE_PATH);
	if (!auth) return new Response(null, { status: 401 });
	// The web app follows one account (?account=); a standard client gets every account it can see.
	const account = new URL(request.url).searchParams.get("account");
	if (account && !(await env.DB.prepare("SELECT 1 FROM accounts WHERE id = ? AND user_id = ?").bind(account, auth.userId).first())) {
		return new Response(null, { status: 403 });
	}
	const token = sessionToken(request.headers);
	const cred = ticketed ? sessionCred(ticketed.tokenHash) : auth.appPassword ? appPasswordCred(auth.appPassword) : token ? sessionCred(await sha256(token)) : undefined;
	const headers = new Headers(request.headers);
	headers.set("x-mailopus-socket", JSON.stringify({ userId: auth.userId, scope: auth.scope, account, cred } satisfies SocketAuth));
	return env.ACCOUNT.get(env.ACCOUNT.idFromName(hubName(auth.userId))).fetch(new Request(request.url, { headers }));
}
