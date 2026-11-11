import { signIngest } from "../../server/lib/ingest-sig";

type Env = { INGEST_SECRET: string; MAILOPUS_INGEST_URL: string };

export default {
	async email(message: ForwardableEmailMessage, env: Env) {
		const raw = await new Response(message.raw).arrayBuffer();
		const res = await fetch(env.MAILOPUS_INGEST_URL, {
			method: "POST",
			headers: { "content-type": "message/rfc822", ...(await signIngest(env.INGEST_SECRET, message.from, message.to, raw)) },
			body: raw,
		});
		if (res.status === 404) return message.setReject("No such recipient here");
		// Anything else unexpected throws, so the message fails loudly in the relay's logs
		// instead of being accepted and silently dropped.
		if (!res.ok) throw new Error(`mailopus ingest returned ${res.status}`);
	},
} satisfies ExportedHandler<Env>;
