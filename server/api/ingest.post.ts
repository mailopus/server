import { MAX_MESSAGE_BYTES, ingestRaw } from "../lib/ingest";
import { SIG_HEADERS, verifyIngest } from "../lib/ingest-sig";

// Inbound mail relayed from domains whose zone isn't in this Cloudflare account (relay/).
// No session: the gate lets this path through, and the HMAC signature is the only credential.
export default defineEventHandler(async (event) => {
	const env = cfEnv(event);
	// INGEST_SECRET is a Worker secret (wrangler secret put), which `wrangler types` does not see.
	const secret = (env as Env & { INGEST_SECRET?: string }).INGEST_SECRET;
	// Nothing to check a signature with, or none sent: answer before reading up to 25 MB from a stranger.
	if (!secret || !getHeader(event, SIG_HEADERS.sig) || !getHeader(event, SIG_HEADERS.ts)) throw createError({ statusCode: 401 });
	const length = Number(getHeader(event, "content-length") ?? 0);
	if (length > MAX_MESSAGE_BYTES) throw createError({ statusCode: 413 });
	const body = await readRawBody(event, false);
	if (!body || body.byteLength > MAX_MESSAGE_BYTES) throw createError({ statusCode: body ? 413 : 400 });
	const raw = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
	if (!(await verifyIngest(secret, event.headers, raw))) throw createError({ statusCode: 401 });
	// A signature is good for five minutes (MAX_SKEW_S), so each is taken once: a replay inside that window
	// answers ok without storing the message again. Older rows are past their window and go.
	const now = Date.now();
	const first = await env.DB.batch([
		env.DB.prepare("DELETE FROM ingest_seen WHERE at < ?").bind(now - 15 * 60_000),
		env.DB.prepare("INSERT OR IGNORE INTO ingest_seen (sig, at) VALUES (?, ?)").bind(getHeader(event, SIG_HEADERS.sig)!, now),
	]);
	if (!first[1]!.meta.changes) return { ok: true, duplicate: true };

	const result = await ingestRaw(env, { from: getHeader(event, SIG_HEADERS.from) ?? "", to: getHeader(event, SIG_HEADERS.to)!, raw });
	// 404 tells the relay to reject the message at SMTP time instead of accepting it into a void.
	if (!result) throw createError({ statusCode: 404, statusMessage: "no account for recipient" });
	return { ok: true };
});
