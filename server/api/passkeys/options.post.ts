// Another passkey for the signed-in user, from Settings. Invites do the same without a session (auth/register).
export default defineEventHandler(async (event) => registrationOptions(event, await requireRecentVerification(event)));
