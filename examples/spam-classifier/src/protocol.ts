// The Mailopus classifier protocol, version 1. Mailopus depends on exactly this, so change it only
// together with Mailopus (server/lib/ingest.ts, askRemote).
//
// Request:  POST /v1/check
//           Authorization: Bearer <key>
//           Content-Type: application/json
//           {"headers": "<header block>", "ctx": {firstContact?, senderHasRdns?, senderDomainAgeDays?}}
// Response: 200 {"rule": "<rule name>"} files the message in Junk with that name.
//           200 {"rule": null} delivers it normally.
//           Anything else (401, 429, 5xx, a timeout over 1.5 s) also delivers normally: Mailopus fails open.

/**
 * Facts Mailopus looks up itself and sends along, because a classifier can't see the mailbox.
 * Each is optional. A missing one means the lookup failed or found nothing, so a rule needing it
 * must not fire: an unknown fact can only let mail through, never junk it.
 */
export type Context = {
	/** True when the account has never sent mail to the From address. */
	firstContact?: boolean;
	/** Whether the connecting IP has a PTR record. */
	senderHasRdns?: boolean;
	/** Days since the From domain was registered, from RDAP. */
	senderDomainAgeDays?: number;
};

export type CheckRequest = { headers: string; ctx: Context };

/** Larger than any real header block; anything bigger is refused rather than scanned. */
export const MAX_HEADERS = 256 * 1024;
/** Mailopus ignores a rule name that is empty or longer than this. */
export const MAX_RULE_NAME = 64;

/** The request body, or null when it isn't one. Context fields of the wrong type are dropped, not trusted. */
export function parseRequest(body: unknown): CheckRequest | null {
	const b = body as { headers?: unknown; ctx?: unknown } | null;
	if (typeof b?.headers !== "string" || b.headers.length > MAX_HEADERS) return null;
	const c = (b.ctx ?? {}) as Record<string, unknown>;
	const ctx: Context = {};
	if (typeof c.firstContact === "boolean") ctx.firstContact = c.firstContact;
	if (typeof c.senderHasRdns === "boolean") ctx.senderHasRdns = c.senderHasRdns;
	if (typeof c.senderDomainAgeDays === "number" && Number.isFinite(c.senderDomainAgeDays)) ctx.senderDomainAgeDays = c.senderDomainAgeDays;
	return { headers: b.headers, ctx };
}
