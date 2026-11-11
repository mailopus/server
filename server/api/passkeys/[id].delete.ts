import { removePasskey } from "../../lib/sessions";

// Removes one passkey. Sessions it started stay signed in: Settings > Signed-in devices ends those.
export default defineEventHandler(async (event) => {
	const userId = await requireRecentVerification(event);
	const r = await removePasskey(cfEnv(event).DB, userId, getRouterParam(event, "id")!);
	if (r === "last") throw createError({ statusCode: 409, statusMessage: "last passkey" });
	if (r === "missing") throw createError({ statusCode: 404 });
	return { ok: true };
});
