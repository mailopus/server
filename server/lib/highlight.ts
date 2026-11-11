import { registrableDomain } from "./ingest.ts";

// Mailbox providers: writing to one person there says nothing about everyone else on it,
// so these stay per address instead of highlighting the whole domain.
// ponytail: a short list, not every provider; add to it when one shows up highlighted.
const PROVIDERS = new Set([
	"gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "hotmail.com", "outlook.com", "live.com", "msn.com",
	"icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "fastmail.com", "gmx.com", "hey.com",
]);

/**
 * Hosts and provider addresses you've sent to, minus your own domains. Hosts are kept as written,
 * not reduced to example.com: mail from em.example.com is the marketing platform, not the person.
 */
export function highlightSets(sentTo: string[], own: string[]) {
	const mine = new Set(own.map((a) => registrableDomain(a.slice(a.lastIndexOf("@") + 1))));
	const domains = new Set<string>();
	const addresses = new Set<string>();
	for (const a of sentTo) {
		const at = a.lastIndexOf("@");
		if (at < 1) continue;
		const host = a.slice(at + 1);
		const d = registrableDomain(host);
		if (mine.has(d)) continue;
		if (PROVIDERS.has(d)) addresses.add(a);
		else domains.add(host);
	}
	return { domains: [...domains].sort(), addresses: [...addresses].sort() };
}
