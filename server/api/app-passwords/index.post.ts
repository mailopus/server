import { newAppPassword, sha256 } from "../../lib/auth";
import { newId } from "../../lib/provision";
import { cleanPattern } from "../../lib/addressed";

// Creates an app password for one device. The response is the only time the password is shown.
export default defineEventHandler(async (event) => {
	const userId = await requireRecentVerification(event);
	const { name, scope, expiresDays } = await readBody<{ name?: unknown; scope?: unknown; expiresDays?: unknown }>(event);
	const label = typeof name === "string" ? name.trim().slice(0, 80) : "";
	if (!label) throw createError({ statusCode: 400, statusMessage: "name required" });
	// null: all mail. Otherwise addresses or "@domain" patterns, as in address groups.
	let patterns: string[] | null = null;
	if (scope != null) {
		const list = Array.isArray(scope) ? scope.map(cleanPattern) : [];
		if (!list.length || list.length > 50 || list.some((p) => !p)) throw createError({ statusCode: 400, statusMessage: "scope must be addresses or @domains" });
		patterns = [...new Set(list as string[])];
	}
	// Absent: it works until revoked. Otherwise it stops by itself after that many days.
	if (expiresDays != null && !(Number.isInteger(expiresDays) && (expiresDays as number) > 0 && (expiresDays as number) <= 3650)) throw createError({ statusCode: 400, statusMessage: "expiresDays must be 1 to 3650" });
	const id = newId();
	const password = newAppPassword();
	const createdAt = Date.now();
	const expiresAt = expiresDays == null ? null : createdAt + (expiresDays as number) * 86_400_000;
	await cfEnv(event)
		.DB.prepare("INSERT INTO app_passwords (id, user_id, name, token_hash, created_at, scope_json, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
		.bind(id, userId, label, await sha256(password), createdAt, patterns && JSON.stringify(patterns), expiresAt)
		.run();
	return { id, name: label, scope: patterns, createdAt, lastUsedAt: null, lastIp: null, expiresAt, password };
});
