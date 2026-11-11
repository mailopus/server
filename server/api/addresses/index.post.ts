// Adds an address on one of your domains: { email, name, receive? }. See server/lib/addresses.ts.
import { AddressError, addAddress, listAddresses } from "../../lib/addresses";

export default defineEventHandler(async (event) => {
	// Sending and receiving as a new address outlasts a session, so the passkey is asked for first.
	await requireRecentVerification(event);
	const { db, accountRows } = await jmapContext(event);
	if (!accountRows[0]) throw createError({ statusCode: 404 });
	try {
		await addAddress(db, accountRows[0].id, await readBody(event));
	} catch (e) {
		if (e instanceof AddressError) throw createError({ statusCode: e.status, statusMessage: e.message });
		throw e;
	}
	return listAddresses(db, accountRows[0].id);
});
