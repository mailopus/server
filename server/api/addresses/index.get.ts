// Your addresses by domain, for Settings (server/lib/addresses.ts).
import { listAddresses } from "../../lib/addresses";

export default defineEventHandler(async (event) => {
	const { db, accountRows } = await jmapContext(event);
	if (!accountRows[0]) throw createError({ statusCode: 404 });
	return listAddresses(db, accountRows[0].id);
});
