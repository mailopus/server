// The rows behind a one-time passkey invite (`mailopus invite` in cli/cli.mjs, and the tests). An invite also
// gives the invitee's address its exact route, in the same batch, so a domain whose catch-all is off
// still delivers to them. A new person gets their user, account, mailboxes and identity too (provision).
import { provision, type Provisioned } from "./provision.ts";

type Statements = Provisioned["statements"];

export function inviteStatements(o: { tokenHash: string; expiresAt: number } & ({ userId: string; email?: string } | { name: string; email: string })) {
	const statements: Statements = [];
	let userId: string;
	if ("name" in o) {
		// provision routes the exact address by default.
		const p = provision({ name: o.name, email: o.email });
		statements.push(...p.statements);
		userId = p.userId;
	} else {
		userId = o.userId;
		// Existing user: route the address they were invited by, unless something already routes it
		// (theirs, or another account's, which the invite mustn't take over).
		if (o.email) statements.push({
			sql: `INSERT INTO addresses (address, account_id)
				SELECT i.email, i.account_id FROM identities i JOIN accounts a ON a.id = i.account_id
				WHERE lower(i.email) = ? AND a.user_id = ? AND NOT EXISTS (SELECT 1 FROM addresses WHERE address = ?) LIMIT 1`,
			params: [o.email.toLowerCase(), userId, o.email.toLowerCase()],
		});
	}
	statements.push({ sql: "INSERT INTO invites (token_hash, user_id, expires_at) VALUES (?, ?, ?)", params: [o.tokenHash, userId, o.expiresAt] });
	return { userId, statements };
}
