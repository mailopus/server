import { readBlob } from "../../../../../lib/blobs";
import { blobInScope } from "../../../../../lib/jmap/mail";

// blobId is an email id (the raw message), "<emailId>_<n>" (its nth attachment), or an upload.
export default defineEventHandler(async (event) => {
	const ctx = await jmapContext(event);
	const { accountId, blobId, name } = getRouterParams(event, { decode: true });
	if (!accountId || !ctx.accounts.has(accountId) || !blobId) throw createError({ statusCode: 404 });
	if (!(await blobInScope(ctx, accountId, blobId))) throw createError({ statusCode: 404 });
	const blob = await readBlob(ctx.db, ctx.mail, accountId, blobId);
	if (!blob) throw createError({ statusCode: 404 });
	const body = blob.content;
	const type = blob.type;
	// Mail content is attacker-controlled. Never let the browser render it on our origin:
	// force download, forbid sniffing, and sandbox it if something renders it anyway.
	setResponseHeaders(event, {
		"content-type": type,
		"content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name ?? "download")}`,
		"x-content-type-options": "nosniff",
		"content-security-policy": "sandbox; default-src 'none'",
		"cache-control": "private, max-age=3600",
	});
	return body;
});
