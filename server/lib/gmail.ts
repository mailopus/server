// Read-only Gmail API access for importing Workspace mailboxes, via a service account with
// domain-wide delegation of https://www.googleapis.com/auth/gmail.readonly. Plain module (no Nitro).

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users";
let API = GMAIL;
/** Where the Gmail API is. Google's, unless the key names another (`gmail_api`): scripts/e2e.mjs runs a stand-in. */
export const useGmailApi = (base?: string) => void (API = base || GMAIL);

/** A Google key file's fields. token_uri and gmail_api are Google's own unless the key says otherwise. */
export type ServiceAccount = { client_email: string; private_key: string; token_uri?: string; gmail_api?: string };

const b64url = (data: ArrayBuffer | Uint8Array | string) => {
	const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

function pemToPkcs8(pem: string) {
	const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
	return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

/** The signed JWT a service account trades for an access token acting as `user`. */
export async function serviceAccountJwt(sa: ServiceAccount, user: string, now = Date.now()) {
	const iat = Math.floor(now / 1000);
	const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const claims = b64url(JSON.stringify({
		iss: sa.client_email, sub: user, scope: GMAIL_SCOPE,
		aud: sa.token_uri ?? "https://oauth2.googleapis.com/token", iat, exp: iat + 3600,
	}));
	const key = await crypto.subtle.importKey("pkcs8", pemToPkcs8(sa.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
	const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`));
	return `${header}.${claims}.${b64url(sig)}`;
}

const tokens = new Map<string, { token: string; until: number }>();

export async function accessToken(sa: ServiceAccount, user: string): Promise<string> {
	const k = `${sa.client_email}|${user}`;
	const hit = tokens.get(k);
	if (hit && hit.until > Date.now()) return hit.token;
	const res = await fetch(sa.token_uri ?? "https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: await serviceAccountJwt(sa, user) }),
	});
	const body = (await res.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
	if (!res.ok || !body.access_token) {
		// unauthorized_client here means domain-wide delegation for gmail.readonly isn't granted yet.
		throw new GmailError(res.status, `token for ${user}: ${body.error ?? res.status} ${body.error_description ?? ""}`.trim());
	}
	tokens.set(k, { token: body.access_token, until: Date.now() + ((body.expires_in ?? 3600) - 300) * 1000 });
	return body.access_token;
}

export class GmailError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
	/** Worth retrying later rather than counting the message as failed. */
	get transient() {
		return this.status === 429 || this.status >= 500;
	}
}

async function get<T>(token: string, url: string): Promise<T> {
	const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
	if (!res.ok) throw new GmailError(res.status, `${res.status} ${url.replace(/\?.*/, "")}: ${(await res.text()).slice(0, 200)}`);
	return res.json() as Promise<T>;
}

export const listPage = (token: string, user: string, pageToken?: string | null, size = 100) =>
	get<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string; resultSizeEstimate?: number }>(
		token,
		`${API}/${encodeURIComponent(user)}/messages?includeSpamTrash=true&maxResults=${size}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
	);

/** Gmail's size for a message, without downloading it (so the importer can budget memory). */
export async function messageSize(token: string, user: string, id: string): Promise<number> {
	const m = await get<{ sizeEstimate?: number }>(token, `${API}/${encodeURIComponent(user)}/messages/${id}?format=minimal&fields=sizeEstimate`);
	return m.sizeEstimate ?? 0;
}

type FromBase64 = (s: string, o: { alphabet: "base64url" }) => Uint8Array;

/** base64url to bytes with one copy where the runtime has Uint8Array.fromBase64. */
export function decodeBase64Url(s: string): Uint8Array {
	const native = (Uint8Array as unknown as { fromBase64?: FromBase64 }).fromBase64;
	if (native) return native(s, { alphabet: "base64url" });
	const bin = atob(s.replace(/[-_]/g, (c) => (c === "-" ? "+" : "/")));
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

/**
 * One message, raw. Gmail sends it base64 inside JSON, so a 20 MB message arrives as ~27 MB of text;
 * the response text and the parsed copy are dropped before decoding so only one of them is alive.
 */
export async function rawMessage(token: string, user: string, id: string) {
	let m: { id: string; threadId: string; labelIds?: string[]; internalDate: string; raw?: string } | null =
		await get(token, `${API}/${encodeURIComponent(user)}/messages/${id}?format=raw`);
	const { raw = "", ...meta } = m!;
	m = null;
	return { ...meta, bytes: decodeBase64Url(raw) };
}

/** How many messages the mailbox holds, by Gmail's count (spam and trash included). */
export async function messagesTotal(token: string, user: string): Promise<number | null> {
	const p = await get<{ messagesTotal?: number }>(token, `${API}/${encodeURIComponent(user)}/profile`);
	return p.messagesTotal ?? null;
}

export async function labelNames(token: string, user: string): Promise<Record<string, string>> {
	const { labels = [] } = await get<{ labels?: { id: string; name: string; type: string }[] }>(token, `${API}/${encodeURIComponent(user)}/labels`);
	return Object.fromEntries(labels.filter((l) => l.type === "user").map((l) => [l.id, l.name]));
}

const ROLE_FOR: Record<string, string> = { INBOX: "inbox", SENT: "sent", DRAFT: "drafts", SPAM: "junk", TRASH: "trash" };

/**
 * Gmail labels -> where the message goes in Mailopus. System labels map to role mailboxes; user labels
 * become role-less mailboxes by name; UNREAD/STARRED become keywords. Category and IMPORTANT labels are
 * Gmail-only presentation and are dropped. Spam and Trash win over everything else, as in Gmail.
 */
export function mapLabels(labelIds: string[], userLabels: Record<string, string>) {
	const set = new Set(labelIds);
	const keywords: Record<string, true> = {};
	if (!set.has("UNREAD")) keywords.$seen = true;
	if (set.has("STARRED")) keywords.$flagged = true;
	if (set.has("DRAFT")) keywords.$draft = true;
	if (set.has("SPAM")) return { roles: ["junk"], labels: [], keywords };
	if (set.has("TRASH")) return { roles: ["trash"], labels: [], keywords };
	const roles = labelIds.map((l) => ROLE_FOR[l]).filter((r): r is string => !!r);
	const labels = labelIds.map((l) => userLabels[l]).filter((n): n is string => !!n);
	return { roles, labels, keywords };
}
