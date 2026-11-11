import { CORE, IMAP, LIMITS, MAIL, SUBMISSION, WEBSOCKET } from "../../lib/jmap/core";
import { LIVE_PATH } from "../../lib/live";
import { API, SERVER } from "../../../shared/api";

// The JMAP Session resource (RFC 8620 §2). Also served at /.well-known/jmap (nuxt.config serverHandlers).
export default defineEventHandler(async (event) => {
	const ctx = await jmapContext(event);
	const user = await ctx.db.prepare("SELECT name FROM users WHERE id = ?").bind(ctx.userId).first<{ name: string }>();
	const accounts = Object.fromEntries(ctx.accountRows.map((a) => [a.id, {
		name: a.name,
		isPersonal: true,
		isReadOnly: false,
		accountCapabilities: {
			[MAIL]: {
				maxMailboxesPerEmail: null,
				maxMailboxDepth: null,
				maxSizeMailboxName: 255,
				maxSizeAttachmentsPerEmail: 25_000_000,
				emailQuerySortOptions: ["receivedAt", "sentAt", "size"],
				mayCreateTopLevelMailbox: true,
			},
			// A year of delayed send, asked for with HOLDUNTIL or HOLDFOR (holdUntil in lib/jmap/write.ts).
			[SUBMISSION]: { maxDelayedSend: 366 * 86_400, submissionExtensions: { FUTURERELEASE: [] } },
			[IMAP]: {},
		},
	}]));
	// Full URLs: some clients (Stalwart's jmap-client, reqwest) can't resolve a bare path. The raw request URL
	// names this Worker, like the passkey check (utils/webauthn.ts).
	const origin = new URL((event.context.cloudflare?.request as Request | undefined)?.url ?? getRequestURL(event)).origin;
	const ws = origin.replace(/^http/, "ws") + LIVE_PATH;
	return {
		// SERVER: the API level, for a UI newer or older than this Worker (shared/api.ts).
		capabilities: { [CORE]: LIMITS, [MAIL]: {}, [SUBMISSION]: {}, [IMAP]: {}, [WEBSOCKET]: { url: ws, supportsPush: true }, [SERVER]: { api: API } },
		accounts,
		primaryAccounts: { [MAIL]: ctx.accountRows[0]?.id ?? null },
		username: user?.name ?? ctx.userId,
		apiUrl: `${origin}/jmap/api`,
		downloadUrl: `${origin}/jmap/download/{accountId}/{blobId}/{name}?type={type}`,
		uploadUrl: `${origin}/jmap/upload/{accountId}/`,
		// Not served: push is over the WebSocket above. RFC 8620 §2 makes the property required, and clients
		// that parse the session strictly would refuse a session without it.
		eventSourceUrl: `${origin}/jmap/eventsource?types={types}&closeafter={closeafter}&ping={ping}`,
		// ponytail: constant until accounts can change; derive from the account list once Gmail/IMAP accounts connect.
		state: "0",
	};
});
