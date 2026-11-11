import { type PushEnv, vapidKeys } from "../lib/push";

// The VAPID public key a browser needs to subscribe. Made on first use when the instance has none.
export default defineEventHandler(async (event) => {
	await jmapContext(event);
	return { publicKey: (await vapidKeys(cfEnv(event) as PushEnv)).publicKey };
});
