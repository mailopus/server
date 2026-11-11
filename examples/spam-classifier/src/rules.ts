// Your rules. Replace these examples with your own.
//
// A rule fires when every pattern in `all` matches the header block and `needs`, if given, is true.
// The first rule that fires names the verdict, so put the most specific rules first.
//
// Match the sender's tooling and infrastructure, not wording: a pitch is cheap to rewrite, a mail
// pipeline isn't. And never let a missing context fact fire a rule (see Context in protocol.ts).
import type { Context } from "./protocol.ts";

export type Rule = {
	/** Stored with the message as the reason it is in Junk. Lowercase with dashes, at most 64 characters. */
	name: string;
	/** Patterns that must all match the unfolded header block. Empty means the rule is context only. */
	all: RegExp[];
	needs?: (c: Context) => boolean;
};

export const RULES: Rule[] = [
	{
		// A bulk-mail library talking to someone for the first time. Each half alone is common.
		name: "bulk-library-first-contact",
		all: [/^X-Mailer: (PHPMailer|Nodemailer)\b/im],
		needs: (c) => c.firstContact === true,
	},
	{
		// A domain registered a few weeks ago writing to you out of nowhere.
		name: "new-domain-first-contact",
		all: [],
		needs: (c) => c.firstContact === true && c.senderDomainAgeDays !== undefined && c.senderDomainAgeDays < 30,
	},
	{
		// Legitimate mail servers almost always have reverse DNS. Only false fires, never undefined.
		name: "sender-without-reverse-dns",
		all: [],
		needs: (c) => c.senderHasRdns === false,
	},
];

/** Header continuation lines joined, so a pattern can span a folded header. */
export const unfold = (headers: string) => headers.replace(/\r?\n[ \t]+/g, " ");

/** The name of the first rule that fires, or null. */
export function classify(headers: string, ctx: Context, rules: Rule[] = RULES): string | null {
	const h = unfold(headers);
	for (const r of rules) {
		if (r.all.every((p) => p.test(h)) && (!r.needs || r.needs(ctx))) return r.name;
	}
	return null;
}
