// RFC 8058 one-click unsubscribe, sent from the user's Worker so the list sees neither the
// reader's IP nor a browser it could set cookies in. The URL comes from the stored message,
// never from the request, so this route can't be pointed at an arbitrary host.
import PostalMime from "postal-mime";
import { type Ctx, angleUrls, rawHeader, scopeSql } from "./jmap/mail.ts";

export const ONE_CLICK_BODY = "List-Unsubscribe=One-Click";
const TIMEOUT_MS = 10_000;

/** The https URL to POST to, when the headers offer one-click (RFC 8058 3.1); else null. */
export function oneClickUrl(headers: { key: string; value: string }[]): string | null {
	const last = (name: string) => headers.findLast((h) => h.key === name)?.value.trim();
	if (last("list-unsubscribe-post") !== ONE_CLICK_BODY) return null;
	return angleUrls(last("list-unsubscribe") ?? "").find((u) => u.toLowerCase().startsWith("https://")) ?? null;
}

/**
 * Whether the Worker may POST here: https on the default port to a public host name. IP literals
 * and local names are refused outright. ponytail: no DNS check, so a public name that resolves to a
 * private address isn't caught here; Workers' fetch doesn't reach private networks anyway.
 */
export function publicHttps(raw: string): boolean {
	let u: URL;
	try { u = new URL(raw); } catch { return false; }
	const host = u.hostname.toLowerCase().replace(/\.$/, "");
	if (u.protocol !== "https:" || u.port || u.username || u.password) return false;
	if (!host.includes(".") || host.startsWith("[") || /^[\d.]+$/.test(host)) return false;
	return !/(^|\.)(localhost|local|internal|lan|home\.arpa|localdomain)$/.test(host);
}

export type Result = { ok: boolean; status: number; error?: string };

/** Unsubscribes from the list that sent this email. `post` is fetch, swapped out in tests. */
export async function oneClick(ctx: Ctx, account: string, emailId: string, post: typeof fetch = fetch): Promise<Result> {
	const scope = scopeSql(ctx);
	const row = await ctx.db
		.prepare(`SELECT e.blob_key FROM emails e WHERE e.account_id = ? AND e.id = ? AND e.destroyed_modseq IS NULL AND ${scope.sql}`)
		.bind(account, emailId, ...scope.params)
		.first<{ blob_key: string }>();
	if (!row) return { ok: false, status: 404, error: "That message isn't in your mail." };
	const header = await rawHeader(ctx.mail, row.blob_key);
	const url = header ? oneClickUrl((await PostalMime.parse(header)).headers) : null;
	if (!url) return { ok: false, status: 400, error: "This message doesn't offer one-click unsubscribe." };
	if (!publicHttps(url)) return { ok: false, status: 400, error: "The unsubscribe link points somewhere private, so it wasn't followed." };
	try {
		const r = await post(url, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: ONE_CLICK_BODY,
			// A redirect could lead anywhere, including past the check above.
			redirect: "manual",
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		return r.ok ? { ok: true, status: r.status } : { ok: false, status: r.status, error: `The list answered ${r.status}.` };
	} catch (e) {
		const timedOut = (e as Error).name === "TimeoutError";
		return { ok: false, status: 0, error: timedOut ? "The list didn't answer in time." : "Couldn't reach the list." };
	}
}
