// Creates a user, their account, the role mailboxes, and a sending identity. Ids are random and
// carry no meaning. Used by `mailopus user create` in cli/cli.mjs (production) and the tests, so both build the
// same rows.

export const ROLES = [
	["inbox", "Inbox"],
	["drafts", "Drafts"],
	["sent", "Sent"],
	["archive", "Archive"],
	["junk", "Junk"],
	["trash", "Trash"],
	["scheduled", "Scheduled"],
] as const;
export type Role = (typeof ROLES)[number][0];

export const newId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");

export type Provisioned = {
	userId: string;
	accountId: string;
	identityId: string;
	mailboxes: Record<Role, string>;
	statements: { sql: string; params: (string | number)[] }[];
};

/**
 * @param routes recipient patterns that deliver to this account: exact addresses or "*@domain".
 */
export function provision(o: {
	name: string;
	email: string;
	routes?: string[];
	userId?: string;
	/** Tests pass fixed ids; everything else gets random ones. */
	makeId?: (kind: string) => string;
}): Provisioned {
	const id = o.makeId ?? newId;
	const userId = o.userId ?? id("user");
	const accountId = id("account");
	const identityId = id("identity");
	const now = Math.floor(Date.now() / 1000);
	const mailboxes = Object.fromEntries(ROLES.map(([role]) => [role, id(`mailbox:${role}`)])) as Record<Role, string>;
	const statements: Provisioned["statements"] = [];
	if (!o.userId) statements.push({ sql: "INSERT INTO users (id, name) VALUES (?, ?)", params: [userId, o.name] });
	statements.push(
		{ sql: "INSERT INTO accounts (id, name, user_id) VALUES (?, ?, ?)", params: [accountId, o.email, userId] },
		...ROLES.map(([role, name]) => ({
			sql: "INSERT INTO mailboxes (id, account_id, name, role, uidvalidity) VALUES (?, ?, ?, ?, ?)",
			params: [mailboxes[role], accountId, name, role, now],
		})),
		{ sql: "INSERT INTO identities (id, account_id, name, email) VALUES (?, ?, ?, ?)", params: [identityId, accountId, o.name, o.email.toLowerCase()] },
		...(o.routes ?? [o.email]).map((r) => ({ sql: "INSERT INTO addresses (address, account_id) VALUES (?, ?)", params: [r.toLowerCase(), accountId] })),
	);
	return { userId, accountId, identityId, mailboxes, statements };
}

/** Inlines params for `wrangler d1 execute --command`. Only for operator-supplied values in scripts. */
export function toSql(statements: Provisioned["statements"]) {
	const lit = (v: string | number) => (typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`);
	return statements.map((s) => {
		let i = 0;
		return s.sql.replace(/\?/g, () => lit(s.params[i++]!));
	}).join(";\n") + ";";
}
