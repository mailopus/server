import { RequestError, dispatch } from "../../lib/jmap/core";
import { mailMethods } from "../../lib/jmap/mail";

export default defineEventHandler(async (event) => {
	const ctx = await jmapContext(event);
	let body: unknown;
	try {
		body = await readBody(event);
	} catch {
		body = null;
	}
	try {
		return await dispatch(body, mailMethods, ctx);
	} catch (e) {
		if (!(e instanceof RequestError)) throw e;
		setResponseStatus(event, e.status);
		setResponseHeader(event, "content-type", "application/problem+json");
		return { type: e.type, status: e.status, detail: e.message };
	}
});
