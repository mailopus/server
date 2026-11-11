import type { H3Event } from "h3";
import type { Ctx, Writer } from "../lib/jmap/mail";
import { userAccounts } from "../lib/auth";
import { requireAuth } from "./session";

/** The JMAP context for the signed-in user: only accounts they own are addressable, and for a limited app password only mail to its addresses. */
export async function jmapContext(event: H3Event): Promise<Ctx & { userId: string; accountRows: { id: string; name: string }[] }> {
	const { userId, scope } = await requireAuth(event);
	const env = cfEnv(event);
	const rows = await userAccounts(env.DB, userId);
	const writer = (account: string) => env.ACCOUNT.get(env.ACCOUNT.idFromName(account)) as unknown as Writer;
	return { userId, db: env.DB, mail: env.MAIL, accounts: new Set(rows.map((r) => r.id)), accountRows: rows, writer, createdIds: {}, scope };
}
