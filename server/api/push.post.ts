import { isSubscription } from "../lib/push";

// Saves this browser's push subscription for the signed-in user. Re-subscribing replaces it.
export default defineEventHandler(async (event) => {
	const { userId, db } = await jmapContext(event);
	const sub = await readBody(event);
	if (!isSubscription(sub)) throw createError({ statusCode: 400 });
	await db.prepare(`INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`)
		.bind(sub.endpoint, userId, sub.keys.p256dh, sub.keys.auth, Date.now()).run();
	return { ok: true };
});
