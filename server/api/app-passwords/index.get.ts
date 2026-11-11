// The signed-in user's app passwords. Never the passwords themselves: only their hashes are stored.
// lastIp: the network (a /24 or /48) it was last used from, never the full address.
// hosts: where the imap/ proxy listens, or null when this instance runs none (IMAP_HOST unset).
export default defineEventHandler(async (event) => {
	const userId = await requireSessionUser(event);
	const env = cfEnv(event) as Env & { IMAP_HOST?: string; SMTP_HOST?: string };
	const r = await env
		.DB.prepare("SELECT id, name, scope_json, created_at AS createdAt, last_used_at AS lastUsedAt, last_ip AS lastIp, expires_at AS expiresAt FROM app_passwords WHERE user_id = ? ORDER BY created_at DESC")
		.bind(userId)
		.all<{ id: string; name: string; scope_json: string | null; createdAt: number; lastUsedAt: number | null; lastIp: string | null; expiresAt: number | null }>();
	// The last month of sign-ins (migrations/0036): passwordId "" is a wrong password for one of your addresses.
	const signins = await env.DB.prepare(
		"SELECT password_id AS passwordId, address, network, ok, count, last_at AS lastAt FROM app_password_signins WHERE user_id = ? AND last_at > ? ORDER BY last_at DESC LIMIT 100",
	).bind(userId, Date.now() - 30 * 86_400_000).all<{ passwordId: string; address: string; network: string; ok: number; count: number; lastAt: number }>();
	const hosts = env.IMAP_HOST ? { imap: env.IMAP_HOST, smtp: env.SMTP_HOST || null } : null;
	return { hosts, signins: signins.results.map((s) => ({ ...s, ok: !!s.ok })), passwords: r.results.map(({ scope_json, ...p }) => ({ ...p, scope: scope_json ? (JSON.parse(scope_json) as string[]) : null })) };
});
