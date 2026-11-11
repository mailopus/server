// Signs one device out. No passkey check first: ending a session grants nothing, and it should be quick
// when a device is lost.
export default defineEventHandler(async (event) => {
	const userId = await requireSessionUser(event);
	if (!(await endSessions(event, userId, { id: getRouterParam(event, "id")! }))) throw createError({ statusCode: 404 });
	return { ok: true };
});
