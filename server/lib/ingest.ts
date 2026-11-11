// Delivers one inbound message to its account: route lookup, raw to R2, parse, then the account's
// Durable Object. Used by the Email Routing hook and by /api/ingest (relayed domains).
import { junked } from "./jmap/write.ts";
import { askPlugins, pluginsFor, tellPlugins, type MailEvent } from "./plugin-hooks.ts";
import { headerBlock } from "./spam/headers.ts";
import { type SpamContext, match } from "./spam/rules.ts";
import { parseEmail } from "../utils/mail.ts";

export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024; // Email Routing's own limit

// Lookup order for a recipient: the exact address, then without its +tag (Gmail's subaddressing,
// which the imported mail uses a lot), then the domain's catch-all.
export function routeCandidates(to: string): [string, string, string] {
	const at = to.lastIndexOf("@");
	const local = to.slice(0, at), domain = to.slice(at + 1);
	const plus = local.indexOf("+");
	return [to, `${plus > 0 ? local.slice(0, plus) : local}@${domain}`, `*@${domain}`];
}

/** The IP that connected to Cloudflare, from the Received header Email Routing adds. */
export function connectingIp(headers: string): string | null {
	const m = headers.match(/^Received: from \S+ \(([0-9a-fA-F.:]+)\)[^\n]*by cloudflare-email\.net/m);
	return m?.[1] ?? null;
}

/**
 * Read a cached sender fact, or compute and store it (migration 0019).
 *
 * `ttlMs` is how long an UNKNOWN answer is trusted. A known answer for a key whose TTL is
 * Infinity is kept forever, which is right for a registration date and wrong for a PTR
 * record, so the PTR caller passes a finite one for both.
 *
 * Every failure path returns undefined, which is what keeps the rules fail-open: a rule that
 * needs this fact simply cannot fire.
 */
async function cachedFact(
	env: Env,
	key: string,
	knownTtlMs: number,
	unknownTtlMs: number,
	lookup: () => Promise<number | null>,
): Promise<number | undefined> {
	try {
		const hit = await env.DB.prepare("SELECT value, checked_at FROM sender_facts WHERE key = ?")
			.bind(key)
			.first<{ value: number | null; checked_at: number }>();
		if (hit) {
			const age = Date.now() - hit.checked_at;
			const fresh = hit.value === null ? age < unknownTtlMs : age < knownTtlMs;
			if (fresh) return hit.value ?? undefined;
		}
		const value = await lookup();
		await env.DB.prepare("INSERT OR REPLACE INTO sender_facts (key, value, checked_at) VALUES (?, ?, ?)")
			.bind(key, value, Date.now())
			.run();
		return value ?? undefined;
	} catch (e) {
		console.warn(`spam: ${key} lookup failed:`, (e as Error).message);
		return undefined;
	}
}

const DAY = 86_400_000;

/**
 * Whether the connecting IP has a PTR record, or undefined when that cannot be established.
 *
 * Workers have no resolver, so this asks 1.1.1.1 over DoH. An ordinary PTR lookup, unlike a
 * DNSBL query: Spamhaus and friends refuse queries that arrive via public resolvers, which is
 * why reject_rbl_client has no equivalent here.
 *
 * IPv4 only. Every IPv6 sender seen so far is a large provider with correct reverse DNS, so
 * building nibble-reversed ip6.arpa names earns nothing; v6 returns undefined and the rule
 * that uses this does not fire.
 */
async function hasReverseDns(env: Env, ip: string): Promise<boolean | undefined> {
	if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) return undefined;
	// 7 days for both answers: an address can gain or lose reverse DNS, and a host that just
	// got a PTR record should not stay blocked for a month on a cached 0.
	const v = await cachedFact(env, `ptr:${ip}`, 7 * DAY, 7 * DAY, async () => {
		const name = `${ip.split(".").reverse().join(".")}.in-addr.arpa`;
		try {
			const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${name}&type=PTR`, {
				headers: { accept: "application/dns-json" },
				signal: AbortSignal.timeout(2000),
			});
			if (!r.ok) return null;
			const dns = (await r.json()) as { Status?: number; Answer?: { type?: number }[] };
			// 0 = NOERROR, 3 = NXDOMAIN. Anything else (SERVFAIL, refused) is not evidence either way.
			if (dns.Status === 3) return 0;
			if (dns.Status !== 0) return null;
			return (dns.Answer ?? []).some((a) => a.type === 12) ? 1 : 0;
		} catch {
			return null;
		}
	});
	return v === undefined ? undefined : v === 1;
}

/**
 * The registrable domain of a host: the part someone actually bought. Two labels, or three
 * where the public suffix itself has two (co.uk, sch.id, co.in). Deliberately a short list
 * rather than the full Public Suffix List, because a wrong answer here only ever means the
 * RDAP lookup misses and the rule does not fire.
 */
export function registrableDomain(host: string): string {
	const p = host.toLowerCase().replace(/\.$/, "").split(".");
	const twoLevel = /^(co|com|net|org|ac|gov|edu|sch|ltd|plc)$/;
	return p.length > 2 && p.at(-1)!.length === 2 && twoLevel.test(p.at(-2)!) ? p.slice(-3).join(".") : p.slice(-2).join(".");
}

/**
 * How many days ago the sender's domain was registered, or undefined when unknown.
 *
 * Measured over 161 sender domains (85 from the Gmail spam folders, 76 from real inbox mail):
 * median age 1.8 years for the spam side against 20.8 years for the legitimate side, and
 * nothing legitimate under 90 days against 8 spam domains. Two were registered the week they
 * wrote.
 *
 * Cached in D1 forever once answered, because a registration date does not change.
 * www.rdap.net redirects to the right registry, so this needs no bootstrap table. Use that
 * host and not rdap.org: rdap.org serves Workers a 403 bot challenge, which this read as
 * "no date" and cached, so the rule never fired in production. Checked from a Worker on
 * 2026-11-07: rdap.net answers for .com .net .org .info .blog .uno .press .network .ai .ltd,
 * and 404s for .us and .co, whose registries publish no RDAP.
 */
async function domainAgeDays(env: Env, address: string | undefined): Promise<number | undefined> {
	if (!address) return undefined;
	const at = address.lastIndexOf("@");
	if (at < 0) return undefined;
	const domain = registrableDomain(address.slice(at + 1));
	if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return undefined;
	// A registration date never changes, so a known answer is kept forever. An unknown one is
	// retried after a week, because the usual reason for it is an RDAP 429 rather than a
	// domain with no date, and a rate limit must not blocklist a domain from the rule forever.
	const ms = await cachedFact(env, `domain:${domain}`, Infinity, 7 * DAY, async () => {
		try {
			const r = await fetch(`https://www.rdap.net/domain/${domain}`, {
				headers: { accept: "application/rdap+json" },
				signal: AbortSignal.timeout(3000),
			});
			// 404 no such domain, 429 rate limited, 403 blocked: none of them is a date. Logged
			// because a silent null here is indistinguishable from a genuinely dateless domain,
			// which is how the rdap.org block above went unnoticed for a day.
			if (!r.ok) {
				console.warn(`spam: rdap ${domain} -> HTTP ${r.status}`);
				return null;
			}
			const j = (await r.json()) as { events?: { eventAction?: string; eventDate?: string }[] };
			const d = j.events?.find((e) => e.eventAction === "registration")?.eventDate;
			const t = d ? Date.parse(d) : NaN;
			return Number.isFinite(t) ? t : null;
		} catch {
			return null; // timeout or network
		}
	});
	return ms === undefined ? undefined : Math.floor((Date.now() - ms) / DAY);
}

/** Whether this account has never sent mail to an address (see migration 0018). */
async function isFirstContact(env: Env, account: string, address: string | undefined): Promise<boolean | undefined> {
	if (!address) return undefined;
	try {
		const row = await env.DB.prepare("SELECT 1 AS x FROM correspondents WHERE account_id = ? AND address = ? LIMIT 1")
			.bind(account, address.toLowerCase())
			.first<{ x: number }>();
		return !row;
	} catch (e) {
		console.warn("spam: correspondents lookup failed:", (e as Error).message);
		return undefined;
	}
}

/**
 * "blocked-sender" when this account has blocked the From address, else null.
 *
 * Independent of the spam rules: this is the user's own decision, not a classifier verdict,
 * and it must hold even when the rules throw. Reuses the spamRule column and so the
 * existing junk routing, which is why it returns a rule name rather than a boolean.
 *
 * Fails open like everything else on the delivery path.
 */
async function blockedSender(env: Env, account: string, address: string | undefined): Promise<string | null> {
	if (!address) return null;
	const at = address.lastIndexOf("@");
	if (at < 0) return null;
	const addr = address.toLowerCase();
	const host = addr.slice(at + 1);
	// A row for "@members.wayfair.com" matches that host; one for "@wayfair.com" matches it too,
	// so a block on a parent domain covers its subdomains. The bare TLD is never a candidate.
	const parts = host.split(".");
	const pats = [addr, ...parts.slice(0, -1).map((_, i) => `@${parts.slice(i).join(".")}`)];
	try {
		const hit = await env.DB.prepare(
			`SELECT pattern FROM blocked_senders WHERE account_id = ? AND pattern IN (${pats.map(() => "?").join(", ")}) LIMIT 1`,
		)
			.bind(account, ...pats)
			.first<{ pattern: string }>();
		return hit ? "blocked-sender" : null;
	} catch (e) {
		console.warn("blocked-sender lookup failed, delivering normally:", (e as Error).message);
		return null;
	}
}

/** The classifier: the name of the first matching rule, or null. Tests pass their own. */
export type Classify = (headers: string, ctx: SpamContext) => string | null | Promise<string | null>;

/**
 * The spam rules' verdict for a message, or null.
 *
 * Fails open on purpose. If a rule or a lookup throws, the message goes to Inbox: a filter
 * that can swallow mail is worse than no filter. The context lookups fail open the same
 * way, leaving their field undefined so no rule needing it can fire.
 */
async function spamRuleFor(env: Env, raw: ArrayBuffer, account: string, from: string | undefined, classify: Classify): Promise<string | null> {
	try {
		const headers = headerBlock(raw);
		const ip = connectingIp(headers);
		const [firstContact, senderHasRdns, senderDomainAgeDays] = await Promise.all([
			isFirstContact(env, account, from),
			ip ? hasReverseDns(env, ip) : Promise.resolve(undefined),
			domainAgeDays(env, from),
		]);
		return await classify(headers, { firstContact, senderHasRdns, senderDomainAgeDays });
	} catch (e) {
		console.warn("spam: check failed, delivering to Inbox:", (e as Error).message);
		return null;
	}
}

type SpamEnv = Env & {
	/** An optional spam Worker on a service binding (docs/spam.md). */
	SPAM?: { check(headers: string, ctx?: SpamContext): Promise<string | null> };
	/** Secret, opt-in: JSON [{"url": "https://spam.mailopus.net/v1/check", "key": "msk_..."}]. */
	SPAM_CLASSIFIERS?: string;
};

/** Remote classifiers from SPAM_CLASSIFIERS. A malformed value means none, never a failed delivery. */
function remoteClassifiers(env: SpamEnv): { url: string; key: string }[] {
	if (!env.SPAM_CLASSIFIERS) return [];
	try {
		const list = JSON.parse(env.SPAM_CLASSIFIERS) as { url?: unknown; key?: unknown }[];
		return list.filter((c): c is { url: string; key: string } =>
			typeof c?.url === "string" && c.url.startsWith("https://") && typeof c.key === "string" && c.key.length > 0);
	} catch {
		console.warn("spam: SPAM_CLASSIFIERS is not valid JSON, ignoring it");
		return [];
	}
}

const REMOTE_TIMEOUT_MS = 1500;

/**
 * Asks one remote classifier. Sends the header block and the context facts, never the body. Any
 * failure (timeout, bad key, odd answer) is no verdict.
 */
async function askRemote(c: { url: string; key: string }, headers: string, ctx: SpamContext): Promise<string | null> {
	try {
		const res = await fetch(c.url, {
			method: "POST",
			headers: { authorization: `Bearer ${c.key}`, "content-type": "application/json" },
			body: JSON.stringify({ headers, ctx }),
			signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
		});
		if (!res.ok) {
			console.warn("spam: classifier answered", res.status, new URL(c.url).host);
			return null;
		}
		const { rule } = (await res.json()) as { rule?: unknown };
		return typeof rule === "string" && rule.length > 0 && rule.length <= 64 ? rule : null;
	} catch (e) {
		console.warn("spam: classifier failed", new URL(c.url).host, (e as Error).message);
		return null;
	}
}

/**
 * The rules to run, in order, first verdict wins:
 * 1. A spam Worker on the SPAM binding, when this instance has one (rules then change without a
 *    rebuild). If it throws, the built-in rules instead.
 * 2. Otherwise the built-in rules (server/lib/spam/rules.ts, empty in this repo).
 * 3. Each remote classifier in SPAM_CLASSIFIERS, an owner's opt-in (README.md). They see headers only.
 */
function classifierFor(env: SpamEnv): Classify {
	const spam = env.SPAM;
	const local: Classify = spam
		? async (headers, ctx) => {
				try {
					return await spam.check(headers, ctx);
				} catch (e) {
					console.warn("spam: Worker failed, using built-in rules:", (e as Error).message);
					return match(headers, ctx);
				}
			}
		: match;
	const remotes = remoteClassifiers(env);
	if (!remotes.length) return local;
	return async (headers, ctx) => {
		const own = await local(headers, ctx);
		if (own) return own;
		for (const c of remotes) {
			const rule = await askRemote(c, headers, ctx);
			if (rule) return rule;
		}
		return null;
	};
}

/** classify: tests pass their own; otherwise classifierFor(env). */
export async function ingestRaw(env: Env, m: { from: string; to: string; raw: ArrayBuffer }, classify: Classify = classifierFor(env)) {
	const to = m.to.toLowerCase();
	const [exact, base, any] = routeCandidates(to);
	const route = await env.DB.prepare("SELECT account_id FROM addresses WHERE address IN (?, ?, ?) ORDER BY CASE address WHEN ? THEN 0 WHEN ? THEN 1 ELSE 2 END LIMIT 1")
		.bind(exact, base, any, exact, base)
		.first<{ account_id: string }>();
	if (!route) return null;

	const id = crypto.randomUUID();
	const blobKey = `raw/${route.account_id}/${id}.eml`;
	// Raw first: if anything after this fails, the message is still recoverable from R2.
	await env.MAIL.put(blobKey, m.raw, { httpMetadata: { contentType: "message/rfc822" } });
	const parsed = await parseEmail(m.raw);
	// The user's own block wins, and is checked first so it holds even if the rules throw.
	const spamRule =
		(await blockedSender(env, route.account_id, parsed.from[0]?.email)) ??
		(await spamRuleFor(env, m.raw, route.account_id, parsed.from[0]?.email, classify));
	// Email Routing's envelope recipient is the last hop, whether or not a header says so.
	if (parsed.deliveredTo.at(-1) !== to) parsed.deliveredTo.push(to);
	// Plugins (docs/plugins.md). Those that act are asked first and can file the message. The rest
	// hear about it once it is stored, so the worst a plugin can do is make this handler finish late.
	const plugins = await pluginsFor(env.DB, "receive").catch(() => []);
	const event = (junk: boolean): MailEvent => ({
		event: "receive",
		account: route.account_id,
		message: { from: parsed.from[0] ?? { name: "", email: m.from }, to: parsed.to.map((a) => a.email), cc: parsed.cc.map((a) => a.email), subject: parsed.subject, messageId: parsed.messageId, date: parsed.sentAt, rcpt: to, junk },
		headers: () => headerBlock(m.raw),
		body: () => parsed.body,
	});
	const verdict = await askPlugins(env, plugins, event(junked({ ...parsed, spamRule })));
	const input = { ...parsed, id, blobKey, size: m.raw.byteLength, receivedAt: Date.now(), spamRule: spamRule ?? (verdict.junk ? `plugin:${verdict.junk}` : null), keywords: verdict.keywords };
	const account = env.ACCOUNT.get(env.ACCOUNT.idFromName(route.account_id));
	const stored = await account.ingest(route.account_id, input);
	await tellPlugins(env, plugins, event(junked(input)));
	return stored;
}
