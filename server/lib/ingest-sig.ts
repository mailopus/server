// Signs and checks relayed inbound mail (e.g. a domain whose zone lives in another Cloudflare account).
// Shared by the relay Worker (relay/) and /api/ingest.

export const SIG_HEADERS = { ts: "x-mailopus-timestamp", sig: "x-mailopus-signature", from: "x-mailopus-from", to: "x-mailopus-to" } as const;
const MAX_SKEW_S = 300;

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function mac(secret: string, ts: string, from: string, to: string, raw: ArrayBuffer) {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const bodyHash = hex(await crypto.subtle.digest("SHA-256", raw));
	return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}\n${from}\n${to}\n${bodyHash}`)));
}

export async function signIngest(secret: string, from: string, to: string, raw: ArrayBuffer, now = Date.now()) {
	const ts = String(Math.floor(now / 1000));
	return { [SIG_HEADERS.ts]: ts, [SIG_HEADERS.from]: from, [SIG_HEADERS.to]: to, [SIG_HEADERS.sig]: await mac(secret, ts, from, to, raw) };
}

/** True only for a fresh, correctly signed request. */
export async function verifyIngest(secret: string | undefined, headers: Headers, raw: ArrayBuffer, now = Date.now()) {
	if (!secret) return false;
	const ts = headers.get(SIG_HEADERS.ts) ?? "";
	const sig = headers.get(SIG_HEADERS.sig) ?? "";
	const from = headers.get(SIG_HEADERS.from) ?? "";
	const to = headers.get(SIG_HEADERS.to) ?? "";
	if (!/^\d+$/.test(ts) || Math.abs(now / 1000 - Number(ts)) > MAX_SKEW_S || !to) return false;
	const expected = await mac(secret, ts, from, to, raw);
	if (expected.length !== sig.length) return false;
	let diff = 0;
	for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
	return diff === 0;
}
