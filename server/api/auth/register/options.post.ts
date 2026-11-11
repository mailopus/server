export default defineEventHandler(async (event) => {
	const { invite } = await readBody(event);
	return registrationOptions(event, await inviteUser(event, invite));
});
