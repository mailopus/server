// JMAP over WebSocket (RFC 8887): what one client message does. Plain module so tests can run it without the Durable Object.
import { RequestError, dispatch } from "./jmap/core.ts";
import { type Ctx, mailMethods } from "./jmap/mail.ts";

/** Who opened the socket, and which account it follows: null for every account the user has (standard clients). */
export type SocketAuth = { userId: string; scope: string[] | null; account: string | null; /** What opened it, so revoking that closes it. */ cred?: string };

/** How a socket names the credential that opened it: a session by its token hash, an app password by its id. */
export const sessionCred = (tokenHash: string) => `session:${tokenHash}`;
export const appPasswordCred = (id: string) => `app:${id}`;

const requestError = (requestId: unknown, e: RequestError) => ({
	"@type": "RequestError",
	...(requestId !== undefined && { requestId }),
	type: e.type,
	status: e.status,
	detail: e.message,
});

/** `push` is the new push setting if the message changed it; `reply` goes back on the socket. */
export async function socketMessage(text: string, ctx: () => Promise<Ctx>): Promise<{ push?: boolean; reply?: unknown }> {
	let msg: { "@type"?: unknown; id?: unknown };
	try {
		msg = JSON.parse(text);
	} catch {
		return { reply: requestError(undefined, new RequestError("urn:ietf:params:jmap:error:notJSON")) };
	}
	const type = msg && typeof msg === "object" ? msg["@type"] : undefined;
	if (type === "WebSocketPushEnable") return { push: true };
	if (type === "WebSocketPushDisable") return { push: false };
	if (type !== "Request") return { reply: requestError(msg?.id, new RequestError("urn:ietf:params:jmap:error:notRequest")) };
	try {
		const r = await dispatch(msg, mailMethods, await ctx());
		return { reply: { "@type": "Response", ...(msg.id !== undefined && { requestId: msg.id }), ...r } };
	} catch (e) {
		if (e instanceof RequestError) return { reply: requestError(msg.id, e) };
		console.error("ws request:", e);
		return { reply: requestError(msg.id, new RequestError("about:blank", 500, "server error")) };
	}
}
