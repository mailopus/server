import { issueSocketTicket } from "../lib/auth";

// A one-time ticket for the live socket, so the session token never rides in a WebSocket header, which
// request logs keep (WS_TICKET_PREFIX in server/lib/auth.ts). Session only: an app password uses Basic auth.
export default defineEventHandler(async (event) => {
	const userId = await requireSessionUser(event);
	return { ticket: await issueSocketTicket(cfEnv(event).DB, userId, await sessionHash(event)) };
});
