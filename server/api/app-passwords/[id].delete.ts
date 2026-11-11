// Revokes one app password. New requests are refused within a minute (the gate's per-isolate cache), and
// any WebSocket it opened is closed now.
import { closeSockets } from "../../lib/live";
import { appPasswordCred } from "../../lib/socket";

export default defineEventHandler(async (event) => {
	const userId = await requireSessionUser(event);
	const id = getRouterParam(event, "id");
	const r = await cfEnv(event).DB.prepare("DELETE FROM app_passwords WHERE id = ? AND user_id = ?").bind(id, userId).run();
	if (!r.meta.changes) throw createError({ statusCode: 404 });
	await closeSockets(cfEnv(event), userId, appPasswordCred(id!));
	return { ok: true };
});
