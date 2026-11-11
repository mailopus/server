// Admin: { domain, to } sends unknown addresses at the domain to account `to`; to: null bounces them.
// See setCatchAll in server/lib/addresses.ts.
import { AddressError, listAddresses, setCatchAll } from "../../lib/addresses";

export default defineEventHandler(async (event) => {
	// Asks for the passkey first: the catch-all decides who gets a whole domain's unknown mail.
	await requireRecentVerification(event);
	const { db, accountRows } = await jmapContext(event);
	if (!accountRows[0]) throw createError({ statusCode: 404 });
	try {
		await setCatchAll(db, accountRows[0].id, await readBody(event));
	} catch (e) {
		if (e instanceof AddressError) throw createError({ statusCode: e.status, statusMessage: e.message });
		throw e;
	}
	return listAddresses(db, accountRows[0].id);
});
