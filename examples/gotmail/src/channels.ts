// The places an alert can go. Each needs its own secrets (wrangler.jsonc lists them). The sound
// channel isn't here: a Worker can't play audio, so index.ts queues those for `listen`.
import type { Rule } from "./rules.ts";

export type ChannelEnv = {
	SLACK_WEBHOOK_URL?: string;
	WEBHOOK_URL?: string;
	TWILIO_ACCOUNT_SID?: string;
	TWILIO_AUTH_TOKEN?: string;
	TWILIO_FROM?: string;
	SMS_TO?: string;
};

/** The secrets a rule's channel still needs, as a sentence, or null when it can send. */
export function missing(env: ChannelEnv, rule: Pick<Rule, "channel" | "arg">): string | null {
	const need = {
		slack: ["SLACK_WEBHOOK_URL"],
		webhook: ["WEBHOOK_URL"],
		sms: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM", ...(rule.arg ? [] : ["SMS_TO"])],
		sound: [],
	}[rule.channel].filter((k) => !env[k as keyof ChannelEnv]);
	return need.length ? `The ${rule.channel} channel isn't set up. Set ${need.join(", ")} on this Worker with wrangler secret put.` : null;
}

/** Sends one alert. Throws with the reason when the service refuses it. */
export async function send(env: ChannelEnv, rule: Rule, text: string, event: unknown): Promise<void> {
	const not = missing(env, rule);
	if (not) throw new Error(not);
	const post = async (url: string, init: RequestInit) => {
		const res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(5000), ...init });
		if (!res.ok) throw new Error(`${rule.channel} answered ${res.status}`);
	};
	const json = (body: unknown) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	if (rule.channel === "slack") return post(env.SLACK_WEBHOOK_URL!, json({ text }));
	if (rule.channel === "webhook") return post(env.WEBHOOK_URL!, json({ text, rule, event }));
	if (rule.channel === "sms")
		return post(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
			headers: { authorization: `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`, "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ To: rule.arg ?? env.SMS_TO!, From: env.TWILIO_FROM!, Body: text }),
		});
}
