/**
 * The header block of a raw message, unfolded, with original capitalisation intact.
 *
 * Both of those matter. PostalMime lowercases header keys, so a block rebuilt from its
 * `headers` array silently stops matching rules that name a header by case (X-Example-Tag,
 * Message-ID:). And a folded Received line splits a continuation onto the next line,
 * which breaks any rule spanning it, so this unfolds the same way deliveredToFromHeaders
 * does in server/utils/mail.ts.
 */
export function headerBlock(raw: ArrayBuffer): string {
	const bytes = new Uint8Array(raw);
	// Header/body split: the first blank line. Scan bytes rather than decoding the whole
	// message, which may be megabytes of base64 attachment.
	let end = bytes.length;
	for (let i = 0; i + 1 < bytes.length; i++) {
		if (bytes[i] === 10 && bytes[i + 1] === 10) { end = i; break; }
		if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) { end = i; break; }
	}
	// latin1, not utf-8: headers are ASCII with anything else RFC 2047-encoded, and latin1
	// never throws on a stray high byte the way utf-8 replacement would mangle it.
	const head = new TextDecoder("latin1").decode(bytes.subarray(0, end));
	return head.replace(/\r?\n[ \t]+/g, " ");
}
