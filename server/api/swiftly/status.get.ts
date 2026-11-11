import { connectionInfo } from "../../lib/swiftly-connect";

// Who you're connected to Swiftly as ({memberEmail, org, connectedAt}), or null. Never the token.
export default defineEventHandler(async (event) => {
	const ctx = await jmapContext(event);
	const account = ctx.accountRows[0]?.id;
	return account ? await connectionInfo(ctx.db, account) : null;
});
