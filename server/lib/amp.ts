// Live blocks: a fenced block in compose that AMP-capable clients keep up to date, with a snapshot for
// everyone else.
//
//   ```live
//   https://api.example.com/order/123.json
//   Order {{id}} is {{status}}.
//   ```
//
// At send time the server fetches the JSON once and renders the template into the html and text parts
// (the fallback). If any live block is present it also builds a text/x-amp-html part where each block
// is an <amp-list> that refetches the URL when the message is opened.
//
// Limits worth knowing: Gmail renders AMP only from senders Google has registered, and only when the
// endpoint answers with AMP-Email CORS headers. Other clients show the fallback. An AMP part that fails
// validation is ignored by the client, which then shows the html, so this converter can be conservative.

export type Fetcher = (url: string) => Promise<unknown>;

const LIVE_HTML = /<pre><code class="language-live">([\s\S]*?)<\/code><\/pre>/g;
const LIVE_TEXT = /^```live[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm;

const unescapeHtml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

type Block = { url: string; template: string };

function parseBlock(body: string): Block | null {
	const [first, ...rest] = body.split("\n");
	const url = first?.trim() ?? "";
	if (!/^https:\/\/[^\s"<>]+$/.test(url)) return null;
	return { url, template: rest.join("\n").trim() };
}

/** {{a.b}} lookups, the subset of mustache that amp-mustache and this fallback agree on. */
export function render(template: string, data: unknown) {
	return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
		const v = path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), data);
		return v === undefined || v === null || typeof v === "object" ? "" : String(v);
	});
}

/** https only, 5 s, 64 KB. A failure renders the template with blanks rather than blocking the send. */
export const fetchJson: Fetcher = async (url) => {
	try {
		const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000), redirect: "follow" });
		if (!res.ok) return null;
		const body = await res.text();
		return body.length > 65_536 ? null : JSON.parse(body);
	} catch {
		return null;
	}
};

const AMP_HEAD = `<!doctype html><html ⚡4email data-css-strict><head><meta charset="utf-8">`
	+ `<script async src="https://cdn.ampproject.org/v0.js"></script>`
	+ `<script async custom-element="amp-list" src="https://cdn.ampproject.org/v0/amp-list-0.1.js"></script>`
	+ `<script async custom-template="amp-mustache" src="https://cdn.ampproject.org/v0/amp-mustache-0.2.js"></script>`
	+ `<style amp4email-boilerplate>body{visibility:hidden}</style></head><body>`;

// Anything here makes the AMP part pointless to try; the html part covers it.
const NOT_AMP = /<(script|iframe|form|input|button|select|textarea|video|audio|object|embed|svg|link|meta|base|frame)\b/i;

/** Our html, made AMP-shaped: styles and handlers out, sized https images to amp-img, the rest dropped. */
function toAmp(html: string): string | undefined {
	const out = html
		.replace(/<(style|head|title)[\s\S]*?<\/\1>/gi, "")
		.replace(/<\/?(html|body|!doctype)[^>]*>/gi, "")
		.replace(/\s(on\w+|class|id)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
		.replace(/<img\b([^>]*)>/gi, (_, attrs: string) => {
			const get = (n: string) => attrs.match(new RegExp(`\\b${n}\\s*=\\s*["']?([^"'\\s>]+)`, "i"))?.[1];
			const [src, w, h] = [get("src"), get("width"), get("height")];
			if (!src?.startsWith("https://") || !/^\d+$/.test(w ?? "") || !/^\d+$/.test(h ?? "")) return "";
			return `<amp-img src="${src}" width="${w}" height="${h}" alt="${escapeHtml(get("alt") ?? "")}" layout="fixed"></amp-img>`;
		});
	return NOT_AMP.test(out) ? undefined : out;
}

export async function renderLive(parts: { html?: string; text: string }, fetcher: Fetcher = fetchJson) {
	const blocks: Block[] = [];
	for (const m of parts.html?.matchAll(LIVE_HTML) ?? []) {
		const b = parseBlock(unescapeHtml(m[1]!));
		if (b) blocks.push(b);
	}
	for (const m of parts.text.matchAll(LIVE_TEXT)) {
		const b = parseBlock(m[1]!);
		if (b && !blocks.some((x) => x.url === b.url && x.template === b.template)) blocks.push(b);
	}
	if (!blocks.length) return { ...parts, amp: undefined };

	const data = new Map<string, unknown>();
	await Promise.all([...new Set(blocks.map((b) => b.url))].map(async (u) => data.set(u, await fetcher(u))));
	const snapshot = (b: Block) => render(b.template, data.get(b.url));
	const htmlSnapshot = (b: Block) => `<div class="live">${escapeHtml(snapshot(b)).replace(/\n/g, "<br>")}</div>`;

	const text = parts.text.replace(LIVE_TEXT, (all, body: string) => {
		const b = parseBlock(body);
		return b ? snapshot(b) : all;
	});
	if (parts.html === undefined) return { html: undefined, text, amp: undefined };

	let amp = toAmp(parts.html.replace(LIVE_HTML, (all, body: string) => {
		const b = parseBlock(unescapeHtml(body));
		if (!b) return all;
		const tpl = escapeHtml(b.template).replace(/\n/g, "<br>");
		return `<amp-list src="${escapeHtml(b.url)}" layout="fixed-height" height="${Math.max(1, b.template.split("\n").length) * 24}" single-item items="."><template type="amp-mustache">${tpl}</template><div fallback>${escapeHtml(snapshot(b)).replace(/\n/g, "<br>")}</div></amp-list>`;
	}));
	if (amp !== undefined) amp = `${AMP_HEAD}${amp}</body></html>`;

	const html = parts.html.replace(LIVE_HTML, (all, body: string) => {
		const b = parseBlock(unescapeHtml(body));
		return b ? htmlSnapshot(b) : all;
	});
	return { html, text, amp };
}
