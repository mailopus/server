/**
 * The spam rule engine. This repo ships no rules: RULES is empty, and a server gets rules only from
 * a Worker on the SPAM binding or a classifier in SPAM_CLASSIFIERS (server/lib/ingest.ts, docs/spam.md).
 *
 * A rule fires when every pattern in `all` matches the header block and `needs`, if given, holds.
 */
export type Rule = {
	name: string;
	all: RegExp[];
	/** An extra condition on facts the headers cannot carry. A rule with no `all` is pure context. */
	needs?: (c: SpamContext) => boolean;
};

/**
 * Facts the mail Worker looks up that are not in the message. Both are optional and both
 * default to benign when absent: an undefined field never satisfies a `needs`, so a failed
 * lookup or a missing caller can only ever let mail through, never junk it.
 */
export type SpamContext = {
	/** False once this account has sent mail to the From address (correspondents table). */
	firstContact?: boolean;
	/** Whether the connecting IP has a PTR record. undefined when not looked up or unresolvable. */
	senderHasRdns?: boolean;
	/** Days since the From domain was registered (RDAP). undefined when the lookup found nothing. */
	senderDomainAgeDays?: number;
};

/** Built-in rules: none. Kept as a list so a server can carry its own if it wants. */
export const RULES: Rule[] = [];

/** The name of the first rule that matches, or null. */
export function match(headers: string, ctx: SpamContext = {}, rules: Rule[] = RULES): string | null {
	for (const rule of rules) {
		if (!rule.all.every((re) => re.test(headers))) continue;
		if (rule.needs && !rule.needs(ctx)) continue;
		return rule.name;
	}
	return null;
}
