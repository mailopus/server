import { CALLBACK_PATH, exchange, saveConnection, takePending } from "../../lib/swiftly-connect";

// Swiftly sends you back here with ?code&state (or ?error). Looks the state up (takePending), swaps the code for a token server-to-server, saves it, and returns you to your mail.
export default defineEventHandler(async (event) => {
	const ctx = await jmapContext(event);
	const q = getQuery(event);
	const saved = typeof q.state === "string" ? await takePending(ctx.db, q.state) : null;
	// Absolute: under BYOC this answer comes from the customer's Worker, and a relative Location would
	// resolve against it instead of the UI you started from.
	const back = (result: string) => sendRedirect(event, `${saved?.base ?? cfEnv(event).APP_ORIGIN}/mail/inbox?swiftly=${result}`);
	if (!saved || !ctx.accounts.has(saved.account)) return back("expired");
	if (q.error || typeof q.code !== "string") return back("canceled");
	try {
		const c = await exchange(q.code, saved.verifier, `${saved.base}${CALLBACK_PATH}`, saved.swiftly);
		const { failed } = await saveConnection(ctx.db, saved.account, c, saved.all ? "all" : saved.identity ? [saved.identity] : []);
		return back(failed ? "unsynced" : "connected");
	} catch (e) {
		console.error("swiftly connect", (e as Error).message);
		return back("failed");
	}
});
