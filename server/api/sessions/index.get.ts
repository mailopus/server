import { listSessions } from "../../lib/sessions";

// Where the user is signed in, for Settings. Ids are a prefix of the token hash, never the hash or the token.
export default defineEventHandler(async (event) => {
	const userId = await requireSessionUser(event);
	return { sessions: await listSessions(cfEnv(event).DB, userId, await sessionHash(event)) };
});
