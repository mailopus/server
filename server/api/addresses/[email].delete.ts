// Removes /api/addresses/<email>: no more sending as it or receiving to it. See server/lib/addresses.ts.
// The address is in the path: a DELETE body doesn't survive every proxy on the way.
import { AddressError, listAddresses, removeAddress } from "../../lib/addresses";

export default defineEventHandler(async (event) => {
	// Asks for the passkey first: a stolen session token must not cut an address off.
	await requireRecentVerification(event);
	const { db, accountRows } = await jmapContext(event);
	if (!accountRows[0]) throw createError({ statusCode: 404 });
	try {
		await removeAddress(db, accountRows[0].id, decodeURIComponent(getRouterParam(event, "email") ?? ""));
	} catch (e) {
		if (e instanceof AddressError) throw createError({ statusCode: e.status, statusMessage: e.message });
		throw e;
	}
	return listAddresses(db, accountRows[0].id);
});
