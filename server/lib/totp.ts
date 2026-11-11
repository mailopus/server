// Authenticator codes (RFC 6238: HMAC-SHA1, 30-second steps, 6 digits), the optional second step after the
// passkey at sign-in. Plain module: no Nitro auto-imports, so tests import it directly.

const STEP_S = 30;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32(bytes: Uint8Array): string {
	let bits = 0, value = 0, out = "";
	for (const b of bytes) {
		value = (value << 8) | b;
		bits += 8;
		while (bits >= 5) out += B32[(value >>> (bits -= 5)) & 31];
	}
	return bits ? out + B32[(value << (5 - bits)) & 31] : out;
}

export function unbase32(s: string): Uint8Array {
	const out: number[] = [];
	let bits = 0, value = 0;
	for (const c of s.toUpperCase().replace(/[\s=-]/g, "")) {
		const i = B32.indexOf(c);
		if (i < 0) throw new Error("not base32");
		value = (value << 5) | i;
		bits += 5;
		if (bits >= 8) out.push((value >>> (bits -= 8)) & 255);
	}
	return new Uint8Array(out);
}

/** 160 random bits, the size RFC 4226 recommends. */
export const newTotpSecret = () => base32(crypto.getRandomValues(new Uint8Array(20)));

export async function totpCode(secret: string, step: number): Promise<string> {
	const key = await crypto.subtle.importKey("raw", unbase32(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
	const counter = new Uint8Array(8);
	new DataView(counter.buffer).setBigUint64(0, BigInt(step));
	const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
	const o = h[19]! & 15;
	const n = ((h[o]! & 127) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
	return String(n % 1_000_000).padStart(6, "0");
}

export const stepAt = (ms: number) => Math.floor(ms / 1000 / STEP_S);

/**
 * The step a code matches, one step either side of now for clock drift, or null. A step at or before
 * lastStep is refused, so a code that already signed someone in can't do it again.
 */
export async function checkTotp(secret: string, code: unknown, lastStep: number, now = Date.now()): Promise<number | null> {
	if (typeof code !== "string") return null;
	const c = code.replace(/\s/g, "");
	if (!/^\d{6}$/.test(c)) return null;
	const at = stepAt(now);
	for (const step of [at, at - 1, at + 1]) {
		if (step > lastStep && (await totpCode(secret, step)) === c) return step;
	}
	return null;
}

/** For the QR code: what authenticator apps scan. */
export const otpauthUri = (secret: string, account: string, issuer: string) =>
	`otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_S}`;

/** Spends a step: false when another request already used this one or a later one (two tabs, one code). */
export async function spendStep(db: D1Database, userId: string, step: number): Promise<boolean> {
	const r = await db.prepare("UPDATE users SET totp_last_step = ? WHERE id = ? AND totp_last_step < ?").bind(step, userId, step).run();
	return r.meta.changes === 1;
}
