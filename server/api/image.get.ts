// Remote images in mail load through here, so the sender's server sees Cloudflare instead of the
// reader's IP, cookies or referrer. The sender still learns the message was opened (Gmail's proxy has
// the same trade-off). Signed-in users only; only images come back.
const MAX_BYTES = 10 * 1024 * 1024;

export default defineEventHandler(async (event) => {
	await jmapContext(event);
	const raw = getQuery(event).u;
	let url: URL;
	try {
		url = new URL(String(raw));
	} catch {
		throw createError({ statusCode: 400 });
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") throw createError({ statusCode: 400 });
	// A named public host only: no IP literals, no single-label names. Mail has no reason to point at either.
	if (!/^(?=.*[a-z])[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(url.hostname) || /^[\d.]+$/.test(url.hostname)) throw createError({ statusCode: 400 });

	// Some tracking pixels never answer; an image that hangs would also hold the message frame's load event.
	const res = await fetch(url, { headers: { accept: "image/*", "user-agent": "Mozilla/5.0 (compatible; Mailopus image proxy)" }, redirect: "follow", signal: AbortSignal.timeout(8000) })
		.catch(() => null);
	const type = res?.headers.get("content-type") ?? "";
	// SVG can carry script; the iframe wouldn't run it, but there's no reason to pass it through.
	if (!res?.ok || !type.startsWith("image/") || type.startsWith("image/svg")) throw createError({ statusCode: 404 });
	if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) throw createError({ statusCode: 413 });

	setResponseHeaders(event, {
		"content-type": type,
		"x-content-type-options": "nosniff",
		"content-security-policy": "sandbox; default-src 'none'",
		"cache-control": "private, max-age=86400",
	});
	// Content-Length is the sender's word, and a chunked answer has none. Count what actually arrives.
	let seen = 0;
	return res.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			if ((seen += chunk.byteLength) > MAX_BYTES) controller.error(new Error("image too large"));
			else controller.enqueue(chunk);
		},
	}));
});
