// Web Push for new mail. Called by the Account Durable Object after an inbound message is stored in the
// Inbox (never for imports, Junk, or mail from your own addresses). The payload is encrypted for the
// browser (RFC 8291), so Apple's and Google's push services only carry it.
import { buildPushHTTPRequest } from "@pushforge/builder";
import type { Addr } from "../utils/mail.ts";

// Optional: a key pair set as a var and a secret. Without them the instance makes its own (vapidKeys).
export type PushEnv = Env & { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string };

export type VapidKeys = { publicKey: string; privateJWK: string };

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/** A fresh P-256 pair: the private key as a JWK string, the public key as the uncompressed point browsers want. */
export async function generateVapidKeys(): Promise<VapidKeys> {
	const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
	const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
	const point = new Uint8Array([4, ...unb64url(jwk.x!), ...unb64url(jwk.y!)]);
	return { publicKey: b64url(point), privateJWK: JSON.stringify({ kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d }) };
}

/**
 * The instance's VAPID keys. The env pair wins when both are set (app.mailopus.net has
 * subscriptions bound to its key). Otherwise the pair in D1, made on first use. INSERT OR
 * IGNORE then SELECT, so two first uses at once still agree on one pair.
 */
export async function vapidKeys(env: PushEnv): Promise<VapidKeys> {
	if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) return { publicKey: env.VAPID_PUBLIC_KEY, privateJWK: env.VAPID_PRIVATE_KEY };
	const row = await env.DB.prepare("SELECT value FROM instance_settings WHERE key = 'vapid'").first<{ value: string }>();
	if (row) return JSON.parse(row.value) as VapidKeys;
	await env.DB.prepare("INSERT OR IGNORE INTO instance_settings (key, value) VALUES ('vapid', ?)").bind(JSON.stringify(await generateVapidKeys())).run();
	const made = await env.DB.prepare("SELECT value FROM instance_settings WHERE key = 'vapid'").first<{ value: string }>();
	return JSON.parse(made!.value) as VapidKeys;
}

export type Subscription = { endpoint: string; keys: { p256dh: string; auth: string } };

// The push services browsers use: Chrome and Edge on Android (FCM), Firefox, Safari and Windows. The
// server POSTs to the endpoint on every new message, so it isn't left as any URL a client names.
const PUSH_HOSTS = /^(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)$/;

export function isSubscription(x: unknown): x is Subscription {
	const s = x as Subscription;
	let host = "";
	try {
		const u = new URL(s?.endpoint);
		if (u.protocol === "https:") host = u.hostname;
	} catch {}
	return PUSH_HOSTS.test(host)
		&& typeof s.keys?.p256dh === "string" && typeof s.keys?.auth === "string";
}

/** Sender and subject only: what a lock screen shows, no body text. */
export function newMailPayload(from: Addr | undefined, subject: string | null, threadId: string) {
	return {
		title: from?.name || from?.email || "New mail",
		body: subject || "(no subject)",
		url: `/mail/inbox/${threadId}`,
		tag: threadId,
	};
}

export async function pushNewMail(env: PushEnv, account: string, m: { from: Addr[]; subject: string | null }, threadId: string) {
	const from = m.from[0];
	if (from) {
		const own = await env.DB.prepare("SELECT 1 FROM addresses WHERE address = ? AND account_id = ?")
			.bind(from.email.toLowerCase(), account).first();
		if (own) return;
	}
	const subs = await env.DB.prepare(
		"SELECT s.endpoint, s.p256dh, s.auth FROM push_subscriptions s JOIN accounts a ON a.user_id = s.user_id WHERE a.id = ?",
	).bind(account).all<Sub>();
	await send(env, subs.results, newMailPayload(from, m.subject, threadId));
}

/** An app password was used from a network it hasn't been seen on (lookupAppPassword in lib/auth.ts). */
export const newNetworkPayload = (name: string, network: string) => ({
	title: "App password used from a new network",
	body: `"${name}" signed in from ${network}. If that wasn't you, revoke it in Settings.`,
	url: "/mail/inbox",
	tag: `app-password-${network}`,
});

export async function pushNewNetwork(env: PushEnv, userId: string, name: string, network: string) {
	const subs = await env.DB.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?").bind(userId).all<Sub>();
	await send(env, subs.results, newNetworkPayload(name, network));
}

/** A mail app sent a wrong app password for one of your addresses (the gate's app-password branch). */
export const wrongPasswordPayload = (address: string) => ({
	title: "Mail app sign-in failed",
	body: `A mail app tried a wrong password for ${address}. If you made a new app password, update every app and device, incoming and outgoing. Five failures lock that network out for 15 minutes.`,
	url: "/mail/inbox",
	tag: `wrong-password-${address}`,
});

const WRONG_PASSWORD_EVERY_S = 3600;

/** At most once an hour per address. Throttled in the Cache API so a guesser can't flood you; the proxy is
 * one machine, so one data center sees all its failures. Addresses that aren't yours tell no one. */
export async function pushWrongPassword(env: PushEnv, address: string) {
	const user = address.toLowerCase();
	const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
	const key = `https://throttle.invalid/wrong-password/${encodeURIComponent(user)}`;
	if (cache && (await cache.match(key))) return;
	const subs = await env.DB.prepare(
		`SELECT s.endpoint, s.p256dh, s.auth FROM push_subscriptions s WHERE s.user_id IN (
			SELECT a.user_id FROM accounts a
			WHERE a.id IN (SELECT account_id FROM addresses WHERE address = ?1) OR a.id IN (SELECT account_id FROM identities WHERE lower(email) = ?1))`,
	).bind(user).all<Sub>();
	if (!subs.results.length) return;
	await cache?.put(key, new Response(null, { headers: { "cache-control": `max-age=${WRONG_PASSWORD_EVERY_S}` } }));
	await send(env, subs.results, wrongPasswordPayload(user));
}

type Sub = { endpoint: string; p256dh: string; auth: string };

async function send(env: PushEnv, subs: Sub[], payload: object) {
	if (!subs.length) return;
	const { privateJWK } = await vapidKeys(env);
	await Promise.all(subs.map(async (s) => {
		const req = await buildPushHTTPRequest({
			privateJWK,
			subscription: { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
			message: { payload, adminContact: env.APP_ORIGIN, options: { ttl: 86400, urgency: "high" } },
		});
		const res = await fetch(req.endpoint, { method: "POST", headers: req.headers, body: req.body });
		// Gone: the browser unsubscribed or the app was removed.
		if (res.status === 404 || res.status === 410) await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(s.endpoint).run();
		else if (!res.ok) console.warn("push: send failed", res.status, new URL(s.endpoint).host);
	}));
}
