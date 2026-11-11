import { LIMITS } from "../../../../lib/jmap/core";
import { uploadKey } from "../../../../lib/blobs";

// JMAP upload (RFC 8620 §6.1). The body is the file; the file name rides in ?name= (our extension, so a
// draft can name the attachment without the client repeating it).
// An upload not attached within a week is deleted by the cron (sweepUploads in server/lib/purge.ts).
export default defineEventHandler(async (event) => {
	const ctx = await jmapContext(event);
	const accountId = getRouterParam(event, "accountId");
	if (!accountId || !ctx.accounts.has(accountId)) throw createError({ statusCode: 404 });
	const declared = Number(getHeader(event, "content-length") ?? 0);
	if (declared > LIMITS.maxSizeUpload) throw createError({ statusCode: 413, statusMessage: "Too large" });
	const body = await readRawBody(event, false);
	if (!body?.byteLength) throw createError({ statusCode: 400, statusMessage: "Empty upload" });
	if (body.byteLength > LIMITS.maxSizeUpload) throw createError({ statusCode: 413, statusMessage: "Too large" });
	const type = (getHeader(event, "content-type") ?? "application/octet-stream").split(";")[0]!.trim().toLowerCase();
	const name = String(getQuery(event).name ?? "").slice(0, 255);
	const blobId = `u${[...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
	await ctx.mail.put(uploadKey(accountId, blobId), body, { httpMetadata: { contentType: type }, customMetadata: { name } });
	setResponseStatus(event, 201);
	return { accountId, blobId, type, size: body.byteLength };
});
