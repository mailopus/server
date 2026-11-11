import PostalMime, { type Address } from "postal-mime";

export type Addr = { name: string; email: string };

export type ParsedEmail = {
	messageId: string | null;
	/** In-Reply-To then References, oldest last. Used for threading. */
	refs: string[];
	subject: string | null;
	from: Addr[];
	to: Addr[];
	cc: Addr[];
	sentAt: number | null;
	preview: string;
	/** Plain text for search, capped. */
	body: string;
	hasAttachment: boolean;
	/** Our own Authentication-Results (the first one, added by mx.cloudflare.net). */
	authResults: string | null;
	dmarcFail: boolean;
	/** Delivered-To addresses, first hop first (an alias or group, then where it forwarded to). */
	deliveredTo: string[];
};

const BODY_CAP = 100_000;

/**
 * Delivered-To header values in message order (newest hop on top) to addresses, first hop first.
 * A hop that repeats the one before it (Gmail stamps some twice) counts once.
 */
export function deliveryPath(topFirst: string[]): string[] {
	const out: string[] = [];
	for (const v of [...topFirst].reverse()) {
		const email = (v.match(/<([^<>\s]+)>/)?.[1] ?? v).trim().toLowerCase();
		if (email.includes("@") && out.at(-1) !== email) out.push(email);
	}
	return out;
}

/** The Delivered-To values from a raw header block (no body parse); for backfilling stored mail. */
export function deliveredToFromHeaders(head: string): string[] {
	const end = head.search(/\r?\n\r?\n/);
	const unfolded = (end < 0 ? head : head.slice(0, end)).replace(/\r?\n[ \t]+/g, " ");
	return deliveryPath(unfolded.split(/\r?\n/).filter((l) => /^delivered-to:/i.test(l)).map((l) => l.slice(13)));
}

export function messageIds(header: string | null | undefined): string[] {
	return header?.match(/<[^<>\s]+>/g) ?? [];
}

function flatten(list: Address[] | Address | undefined): Addr[] {
	const out: Addr[] = [];
	for (const a of list ? (Array.isArray(list) ? list : [list]) : []) {
		if ("group" in a && a.group) out.push(...flatten(a.group));
		else if (a.address) out.push({ name: a.name ?? "", email: a.address.toLowerCase() });
	}
	return out;
}

// ponytail: the named entities mail actually uses, not the full HTML5 table; others become a space.
const ENTITIES: Record<string, string> = {
	amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "\u2019", lsquo: "\u2018", rdquo: "\u201d",
	ldquo: "\u201c", mdash: "\u2014", ndash: "\u2013", hellip: "\u2026", bull: "\u2022", middot: "\u00b7", copy: "\u00a9",
	reg: "\u00ae", trade: "\u2122", zwnj: "", zwj: "", shy: "", eacute: "\u00e9", euro: "\u20ac", pound: "\u00a3",
};

/** One pass, so "&amp;#8217;" stays the literal text "&#8217;" as the sender wrote it. */
export function decodeEntities(s: string): string {
	return s.replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (m, e: string) => {
		if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? " ";
		const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
		// fromCodePoint throws past U+10FFFF; a bad number in spam mustn't fail the parse.
		return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : " ";
	});
}

// ponytail: crude HTML-to-text for search and preview only, never for display.
function htmlToText(html: string): string {
	// Comments first: Outlook conditionals (<!--[if mso]>…<![endif]-->) carry text that isn't shown.
	return decodeEntities(
		html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " "),
	);
}

// The inbox line, as most clients show it: from the HTML part when there is one, so images drop out and
// links keep only their text. Plain-text parts written by newsletter tools carry markdown links,
// "[image: x]" and bare URLs; those go too. Preheader padding (zero-width and combining spacers) goes.
export function previewText(text: string | undefined, html: string | undefined): string {
	const src = html ? htmlToText(html) : (text ?? "")
		.replace(/!?\[([^\]]*)\]\(\s*[a-z]+:[^)]*\)/gi, (m, label: string) => (m[0] === "!" || /\b(logo|image|icon)\b/i.test(label) ? " " : label))
		.replace(/\[image:[^\]]*\]/gi, " ")
		.replace(/<?https?:\/\/\S+>?/g, " ")
		.replace(/\(\s*\)/g, " ") // Mailchimp's "text ( url )"
		.replace(/(!?\[[^\]]*(\]\(?)?|\()\s*$/, " "); // a link the 256-character cut left open
	return src.replace(/[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u2060-\u2064\ufeff]/g, "")
		.replace(/\s+/g, " ").trim().slice(0, 256);
}

export async function parseEmail(raw: ArrayBuffer): Promise<ParsedEmail> {
	const m = await PostalMime.parse(raw);
	const text = (m.text ?? (m.html ? htmlToText(m.html) : "")).replace(/\s+/g, " ").trim();
	const authResults = m.headers.find((h) => h.key === "authentication-results")?.value ?? null;
	const date = m.date ? Date.parse(m.date) : NaN;
	return {
		messageId: messageIds(m.messageId)[0] ?? null,
		refs: [...messageIds(m.inReplyTo), ...messageIds(m.references).reverse()],
		subject: m.subject ?? null,
		from: flatten(m.from),
		to: flatten(m.to),
		cc: flatten(m.cc),
		sentAt: Number.isNaN(date) ? null : date,
		preview: previewText(m.text, m.html),
		body: text.slice(0, BODY_CAP),
		hasAttachment: m.attachments.some((a) => a.disposition !== "inline" && a.mimeType !== "text/x-amp-html"),
		authResults,
		dmarcFail: /\bdmarc=fail\b/i.test(authResults ?? ""),
		deliveredTo: deliveryPath(m.headers.filter((h) => h.key === "delivered-to").map((h) => h.value)),
	};
}
