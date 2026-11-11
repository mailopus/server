// Renames an address or turns receiving on or off: { email, name?, receive? }. See server/lib/addresses.ts.
import { AddressError, listAddresses, updateAddress } from "../../lib/addresses";

export default defineEventHandler(async (event) => {
	const { db, accountRows } = await jmapContext(event);
	if (!accountRows[0]) throw createError({ statusCode: 404 });
	try {
		await updateAddress(db, accountRows[0].id, await readBody(event));
	} catch (e) {
		if (e instanceof AddressError) throw createError({ statusCode: e.status, statusMessage: e.message });
		throw e;
	}
	return listAddresses(db, accountRows[0].id);
});
