// Your addresses, for Settings: each is a send-as identity (identities) and usually an exact inbound
// route (addresses). Mail to an address with no route, and no catch-all on its domain, is refused at SMTP
// time (server/lib/ingest.ts). Several people can share a domain, one account per address. Only the
// admin (users.is_admin, migration 0031) adds or removes addresses, and decides per domain whether a
// catch-all (`*@domain`) takes unknown addresses and which account it goes to. Off by default. This replaces `mailopus identity add` for domains already set up; a new
// domain still needs DNS, Email Routing and Email Sending in Cloudflare first.
import { newId } from "./provision.ts";

export type Address = {
	email: string;
	/** Display name when sending; null for a receive-only route. */
	name: string | null;
	identityId: string | null;
	/** Inbound mail to it lands here: an exact route, or a catch-all on its domain. */
	receives: boolean;
	/** An exact route (not just a catch-all), so receiving can be turned off for this address. */
	routed: boolean;
	/** Messages that reached it in the last 30 days (emails.addressed_to). */
	recent: number;
};

export class AddressError extends Error {
	status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}

export const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9-]+\.)+[a-z]{2,}$/;
const domainOf = (e: string) => e.slice(e.lastIndexOf("@") + 1);

async function requireAdmin(db: D1Database, account: string, what: string) {
	const row = await db.prepare("SELECT u.is_admin FROM accounts a JOIN users u ON u.id = a.user_id WHERE a.id = ?").bind(account).first<{ is_admin: number }>();
	if (!row?.is_admin) throw new AddressError(`Only the admin can ${what}.`, 403);
}

export async function listAddresses(db: D1Database, account: string, now = Date.now()) {
	const [ids, routes, recent, admin, catchAllRows, accountRows] = await db.batch([
		db.prepare("SELECT id, name, lower(email) AS email FROM identities WHERE account_id = ?").bind(account),
		db.prepare("SELECT lower(address) AS address FROM addresses WHERE account_id = ?").bind(account),
		db.prepare(
			"SELECT addressed_to AS email, count(*) AS n FROM emails WHERE account_id = ? AND received_at >= ? AND destroyed_modseq IS NULL GROUP BY addressed_to",
		).bind(account, now - 30 * 86_400_000),
		db.prepare("SELECT u.is_admin FROM accounts a JOIN users u ON u.id = a.user_id WHERE a.id = ?").bind(account),
		db.prepare("SELECT substr(lower(address), 3) AS domain, account_id FROM addresses WHERE address LIKE '*@%'"),
		db.prepare("SELECT id, name FROM accounts ORDER BY name"),
	]);
	const isAdmin = !!(admin!.results[0] as { is_admin: number } | undefined)?.is_admin;
	const identities = ids!.results as { id: string; name: string; email: string }[];
	const exact = new Set((routes!.results as { address: string }[]).map((r) => r.address).filter((a) => !a.startsWith("*@")));
	const catchAll = (routes!.results as { address: string }[]).map((r) => r.address).filter((a) => a.startsWith("*@")).map((a) => a.slice(2));
	const counts = new Map((recent!.results as { email: string; n: number }[]).map((r) => [r.email, r.n]));
	const emails = [...new Set([...identities.map((i) => i.email), ...exact])].sort();
	const addresses: Address[] = emails.map((email) => {
		const ident = identities.find((i) => i.email === email);
		return {
			email,
			name: ident?.name ?? null,
			identityId: ident?.id ?? null,
			receives: exact.has(email) || catchAll.includes(domainOf(email)),
			routed: exact.has(email),
			recent: counts.get(email) ?? 0,
		};
	});
	const allCatchAll = catchAllRows!.results as { domain: string; account_id: string }[];
	const domains = [...new Set([...emails.map(domainOf), ...catchAll, ...(isAdmin ? allCatchAll.map((r) => r.domain) : [])])].sort();
	if (!isAdmin) return { addresses, domains, catchAll, admin: false };
	return {
		addresses, domains, catchAll, admin: true,
		/** Every account on the instance, to pick where a catch-all goes. */
		accounts: accountRows!.results as { id: string; name: string }[],
		/** Domain to the account its catch-all delivers to; a domain missing here has none. */
		catchAllTo: Object.fromEntries(allCatchAll.map((r) => [r.domain, r.account_id])) as Record<string, string>,
	};
}

/** A new address on one of your domains: sends as it, and receives unless receive is false. */
export async function addAddress(db: D1Database, account: string, input: { email?: unknown; name?: unknown; receive?: unknown }) {
	const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
	const name = typeof input.name === "string" ? input.name.trim() : "";
	if (!EMAIL.test(email)) throw new AddressError("That isn't an email address.");
	if (!name || name.length > 255 || /[\r\n]/.test(name)) throw new AddressError("A name is needed for sending.");
	await requireAdmin(db, account, "add addresses");
	const { addresses, domains } = await listAddresses(db, account);
	if (!domains.includes(domainOf(email))) {
		throw new AddressError(`${domainOf(email)} isn't set up for Mailopus yet. A new domain needs DNS, Email Routing and Email Sending in Cloudflare first.`);
	}
	if (addresses.some((a) => a.email === email && a.identityId)) throw new AddressError(`${email} is already yours.`);
	const taken = await db.prepare("SELECT account_id FROM addresses WHERE address = ?").bind(email).first<{ account_id: string }>();
	if (taken && taken.account_id !== account) throw new AddressError(`${email} belongs to another Mailopus account.`);
	await db.batch([
		db.prepare("INSERT INTO identities (id, account_id, name, email) VALUES (?, ?, ?, ?)").bind(newId(), account, name, email),
		...(input.receive !== false && !taken ? [db.prepare("INSERT INTO addresses (address, account_id) VALUES (?, ?)").bind(email, account)] : []),
	]);
}

/** Rename the sending name, or turn receiving on or off for this one address. */
export async function updateAddress(db: D1Database, account: string, input: { email?: unknown; name?: unknown; receive?: unknown }) {
	const email = typeof input.email === "string" ? input.email.toLowerCase() : "";
	const { addresses } = await listAddresses(db, account);
	const a = addresses.find((x) => x.email === email);
	if (!a) throw new AddressError(`${email} isn't one of your addresses.`);
	const stmts: D1PreparedStatement[] = [];
	if (input.name !== undefined) {
		const name = typeof input.name === "string" ? input.name.trim() : "";
		if (!a.identityId) throw new AddressError(`You don't send as ${email}.`);
		if (!name || name.length > 255 || /[\r\n]/.test(name)) throw new AddressError("A name is needed for sending.");
		stmts.push(db.prepare("UPDATE identities SET name = ? WHERE id = ?").bind(name, a.identityId));
	}
	if (input.receive === true && !a.routed) {
		const taken = await db.prepare("SELECT account_id FROM addresses WHERE address = ?").bind(email).first<{ account_id: string }>();
		if (taken) throw new AddressError(`${email} belongs to another Mailopus account.`);
		stmts.push(db.prepare("INSERT INTO addresses (address, account_id) VALUES (?, ?)").bind(email, account));
	}
	if (input.receive === false && a.routed) {
		if (!a.identityId) throw new AddressError(`Turning off receiving would leave nothing of ${email}; remove it instead.`);
		stmts.push(db.prepare("DELETE FROM addresses WHERE address = ? AND account_id = ?").bind(email, account));
	}
	if (stmts.length) await db.batch(stmts);
}

/** Stops sending as it and receiving to it. Not the last address you send as, nor one with sends scheduled. */
export async function removeAddress(db: D1Database, account: string, emailIn: unknown) {
	const email = typeof emailIn === "string" ? emailIn.toLowerCase() : "";
	await requireAdmin(db, account, "remove addresses");
	const { addresses } = await listAddresses(db, account);
	const a = addresses.find((x) => x.email === email);
	if (!a) throw new AddressError(`${email} isn't one of your addresses.`);
	if (a.identityId) {
		if (addresses.filter((x) => x.identityId).length === 1) throw new AddressError("That's the last address you send as.");
		const held = await db.prepare("SELECT count(*) AS n FROM scheduled_submissions WHERE identity_id = ?").bind(a.identityId).first<{ n: number }>();
		if (held!.n) throw new AddressError(`${held!.n} scheduled ${held!.n === 1 ? "message sends" : "messages send"} from ${email}. Cancel or send ${held!.n === 1 ? "it" : "them"} first.`);
	}
	await db.batch([
		...(a.identityId ? [db.prepare("DELETE FROM identities WHERE id = ?").bind(a.identityId)] : []),
		db.prepare("DELETE FROM addresses WHERE address = ? AND account_id = ?").bind(email, account),
	]);
}

/** Admin: send unknown addresses at a domain to one account (`to`), or bounce them (`to` null). */
export async function setCatchAll(db: D1Database, account: string, input: { domain?: unknown; to?: unknown }) {
	await requireAdmin(db, account, "change the catch-all");
	const domain = typeof input.domain === "string" ? input.domain.toLowerCase() : "";
	const { domains } = await listAddresses(db, account);
	if (!domains.includes(domain)) throw new AddressError(`${domain} isn't set up for Mailopus yet.`);
	const to = input.to ?? null;
	if (to !== null) {
		if (typeof to !== "string" || !(await db.prepare("SELECT 1 FROM accounts WHERE id = ?").bind(to).first())) throw new AddressError("No such account.");
	}
	await db.batch([
		// Addresses the old catch-all delivered to without an exact route keep receiving: an instance
		// claimed before exact routes would otherwise bounce its own owner's mail.
		db.prepare(
			`INSERT INTO addresses (address, account_id)
			SELECT lower(i.email), i.account_id FROM identities i
			WHERE i.account_id = (SELECT account_id FROM addresses WHERE address = ?) AND lower(i.email) LIKE ?
				AND NOT EXISTS (SELECT 1 FROM addresses WHERE address = lower(i.email))`,
		).bind(`*@${domain}`, `%@${domain}`),
		db.prepare("DELETE FROM addresses WHERE address = ?").bind(`*@${domain}`),
		...(to ? [db.prepare("INSERT INTO addresses (address, account_id) VALUES (?, ?)").bind(`*@${domain}`, to)] : []),
	]);
}
