import { generateRecoveryCodes, recoveryStatus } from "../../lib/recovery";

// Replaces the user's recovery codes. The response is the only time they are shown. A code can add a
// passkey, so a stolen session token must not make its own: the passkey is asked for first.
export default defineEventHandler(async (event) => {
	const userId = await requireRecentVerification(event);
	const db = cfEnv(event).DB;
	const codes = await generateRecoveryCodes(db, userId);
	return { codes, ...(await recoveryStatus(db, userId)) };
});
