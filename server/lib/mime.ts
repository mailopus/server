// Builds RFC 5322 messages for drafts and sending. The stored draft is byte-for-byte what gets sent.

export type Addr = { name?: string | null; email: string };

export type Outgoing = {
	from: Addr[];
	to?: Addr[];
	cc?: Addr[];
	bcc?: Addr[];
	replyTo?: Addr[];
	subject?: string | null;
	inReplyTo?: string[] | null;
	references?: string[] | null;
	messageId: string; // without angle brackets
	date: Date;
	text?: string;
	html?: string;
	/** AMP for Email (text/x-amp-html). Only sent alongside html, which is its fallback. */
	amp?: string;
	attachments?: Part[];
};

/** A file part. With cid it's inline (referenced from the html as cid:...), otherwise an attachment. */
export type Part = { name: string; type: string; content: Uint8Array; cid?: string };

export class MimeError extends Error {}

// Header injection: a CR or LF in any header value would let input add headers or a body.
function safe(value: string, what: string) {
	if (/[\r\n]/.test(value)) throw new MimeError(`${what} contains a line break`);
	return value;
}

const EMAIL = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;

const b64 = (s: string) => {
	const bytes = new TextEncoder().encode(s);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
};

/** RFC 2047 encoded-word when needed; plain ASCII passes through. */
export function encodeWord(s: string) {
	return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`;
}

export function formatAddr(a: Addr) {
	const email = safe(a.email, "address");
	if (!EMAIL.test(email)) throw new MimeError(`invalid address ${email}`);
	if (!a.name) return email;
	const name = safe(a.name, "display name");
	const display = /^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/["\\]/g, "\\$&")}"` : encodeWord(name);
	return `${display} <${email}>`;
}

/** RFC 2045 quoted-printable over UTF-8, keeping the text's own line breaks as hard breaks. */
export function quotedPrintable(text: string): string {
	const enc = new TextEncoder();
	const hex = (b: number) => `=${b.toString(16).toUpperCase().padStart(2, "0")}`;
	return text.split(/\r?\n/).map((line) => {
		let out = "";
		let col = 0;
		const bytes = enc.encode(line);
		for (let i = 0; i < bytes.length; i++) {
			const b = bytes[i]!;
			const last = i === bytes.length - 1;
			// Printable ASCII except "=" stays literal; space and tab only when not ending the line.
			const literal = (b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !last);
			const piece = literal ? String.fromCharCode(b) : hex(b);
			if (col + piece.length > 75) {
				out += "=\r\n";
				col = 0;
			}
			out += piece;
			col += piece.length;
		}
		return out;
	}).join("\r\n");
}

/**
 * Picks the body encoding a normal mail client would: 7bit for plain ASCII with sane line lengths,
 * quoted-printable otherwise. Base64 for plain text is a spam-filter signal (e.g. MIME_BASE64_TEXT).
 */
export function encodeBody(text: string): { cte: string; body: string } {
	const crlf = text.replace(/\r?\n/g, "\r\n");
	const ascii = /^[\x09\x0d\x0a\x20-\x7e]*$/.test(crlf) && crlf.split("\r\n").every((l) => l.length <= 998 && !/^\.$/.test(l));
	return ascii ? { cte: "7bit", body: crlf } : { cte: "quoted-printable", body: quotedPrintable(text) };
}
const msgIds = (ids: string[]) => ids.map((id) => `<${safe(id, "message id").replace(/^<|>$/g, "")}>`).join(" ");

export function buildMime(m: Outgoing): string {
	const headers: string[] = [];
	const add = (name: string, value: string | undefined | null) => value && headers.push(`${name}: ${value}`);
	const list = (a?: Addr[]) => (a?.length ? a.map(formatAddr).join(", ") : undefined);

	if (!m.from.length) throw new MimeError("from is required");
	add("From", list(m.from));
	add("To", list(m.to));
	add("Cc", list(m.cc));
	add("Bcc", list(m.bcc));
	add("Reply-To", list(m.replyTo));
	add("Subject", m.subject ? encodeWord(safe(m.subject, "subject")) : undefined);
	add("Date", m.date.toUTCString().replace("GMT", "+0000"));
	add("Message-ID", msgIds([m.messageId]));
	add("In-Reply-To", m.inReplyTo?.length ? msgIds(m.inReplyTo) : undefined);
	add("References", m.references?.length ? msgIds(m.references) : undefined);
	add("MIME-Version", "1.0");

	const part = (type: string, content: string) => {
		const { cte, body } = encodeBody(content);
		return `Content-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: ${cte}\r\n\r\n${body}\r\n`;
	};
	const multi = (kind: string, parts: string[]) => {
		const boundary = `mo-${crypto.randomUUID()}`;
		return `Content-Type: multipart/${kind}; boundary="${boundary}"\r\n\r\n${parts.map((p) => `--${boundary}\r\n${p}`).join("")}--${boundary}--\r\n`;
	};
	const files = m.attachments ?? [];
	const inline = files.filter((f) => f.cid && m.html !== undefined);
	const attached = files.filter((f) => !inline.includes(f));

	// mixed[ related[ alternative[text, amp, html], inline images ], attachments ]; each layer only when needed.
	// Gmail wants the AMP part before the html part, and ignores it unless html is there too.
	let body = m.html === undefined
		? part("text/plain", m.text ?? "")
		: multi("alternative", [part("text/plain", m.text ?? ""), ...(m.amp ? [part("text/x-amp-html", m.amp)] : []), part("text/html", m.html)]);
	if (inline.length) body = multi("related", [body, ...inline.map(filePart)]);
	if (attached.length) body = multi("mixed", [body, ...attached.map(filePart)]);
	return `${headers.join("\r\n")}\r\n${body}`;
}

/** RFC 2231 filename parameter for non-ASCII names, a quoted one otherwise. */
function filenameParam(name: string) {
	const clean = safe(name, "file name").replace(/[\x00-\x1f]/g, "");
	return /^[\x20-\x7e]*$/.test(clean) ? `filename="${clean.replace(/["\\]/g, "\\$&")}"` : `filename*=UTF-8''${encodeURIComponent(clean)}`;
}

function filePart(f: Part) {
	const type = /^[\w.+-]+\/[\w.+-]+$/.test(f.type) ? f.type : "application/octet-stream";
	let bin = "";
	for (let i = 0; i < f.content.length; i += 0x8000) bin += String.fromCharCode(...f.content.subarray(i, i + 0x8000));
	const b64body = btoa(bin).replace(/.{76}/g, "$&\r\n");
	const cid = f.cid ? `Content-ID: <${safe(f.cid, "content id").replace(/^<|>$/g, "")}>\r\n` : "";
	return `Content-Type: ${type}\r\nContent-Transfer-Encoding: base64\r\n${cid}Content-Disposition: ${f.cid ? "inline" : "attachment"}; ${filenameParam(f.name)}\r\n\r\n${b64body}\r\n`;
}

/** Removes the Bcc header (and any folded continuation lines) before a message leaves. */
export function stripBcc(raw: string): string {
	const end = raw.indexOf("\r\n\r\n");
	const head = end < 0 ? raw : raw.slice(0, end);
	const kept = head.split("\r\n").reduce<{ out: string[]; skipping: boolean }>((acc, line) => {
		if (/^bcc:/i.test(line)) return { out: acc.out, skipping: true };
		if (acc.skipping && /^[ \t]/.test(line)) return acc;
		return { out: [...acc.out, line], skipping: false };
	}, { out: [], skipping: false }).out;
	return kept.join("\r\n") + (end < 0 ? "" : raw.slice(end));
}
