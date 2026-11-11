// Alert rules: reading one from a command line, and deciding whether a mail event matches it.
// Nothing here touches the network or storage, so tests/rules.test.ts covers it directly.

export const CHANNELS = ["slack", "webhook", "sms", "sound"] as const;
export type Channel = (typeof CHANNELS)[number];

export type Rule = {
	id: string;
	/** once: removed after its first alert. every: stays. */
	times: "once" | "every";
	event: "receive" | "send";
	/** Each is a case-insensitive piece of text to find. A rule needs at least one. */
	from?: string;
	to?: string;
	subject?: string;
	channel: Channel;
	/** sms: the number to text. sound: the file to play where `listen` runs. */
	arg?: string;
};

/** The part of a Mailopus event a rule looks at (docs/plugins.md in the Mailopus repo). */
export type MailEvent = {
	event: "receive" | "send";
	test?: boolean;
	message: { from: { name: string; email: string }; to: string[]; cc: string[]; subject: string | null; rcpt?: string; junk?: boolean };
};

export const HELP = `gotmail alerts you when mail you're waiting for arrives or goes out.

  once|every receive|send [--from <text>] [--to <text>] [--subject <text>] <channel>
      once alerts one time and removes the rule. every keeps alerting.
      --from, --to and --subject each match a piece of the address or subject, in any letter case.
      channel is one of:
        slack            posts to your Slack webhook
        webhook          POSTs JSON to your webhook URL
        sms [number]     texts the number, or your default one
        sound [file]     plays the file where "listen" is running
  list                   shows your rules and which channels are set up
  remove <id>            removes a rule
  listen                 waits here and plays sound alerts as they fire. Ctrl-C stops it.

Examples:
  mailopus with gotmail once receive --from thedude72 sound youvegotmail.wav
  mailopus with gotmail every send --to hr@corpo.example slack`;

const FILTERS = ["from", "to", "subject"] as const;

/** A rule from the words after `mailopus with gotmail`, or a sentence saying what is wrong with them. */
export function parseRule(args: string[]): Omit<Rule, "id"> | string {
	const [times, event, ...rest] = args;
	if (times !== "once" && times !== "every") return "Start with once or every.";
	if (event !== "receive" && event !== "send") return `After ${times}, say receive or send.`;
	const rule: Omit<Rule, "id"> = { times, event, channel: "slack" };
	const words: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		const m = rest[i]!.match(/^--([a-z]+)(?:=(.*))?$/s);
		if (!m) {
			words.push(rest[i]!);
			continue;
		}
		const name = FILTERS.find((f) => f === m[1]);
		if (!name) return `Unknown option --${m[1]}. Use --from, --to or --subject.`;
		const value = (m[2] ?? rest[++i] ?? "").trim().toLowerCase();
		if (!value) return `--${name} needs some text to match.`;
		rule[name] = value;
	}
	if (!rule.from && !rule.to && !rule.subject) return "Add at least one of --from, --to or --subject, or every message would alert.";
	const [channel, arg, extra] = words;
	const known = CHANNELS.find((c) => c === channel);
	if (!known) return `End with a channel: ${CHANNELS.join(", ")}.`;
	if (extra !== undefined || (arg !== undefined && known !== "sms" && known !== "sound")) return `Too many words after ${known}.`;
	return { ...rule, channel: known, ...(arg !== undefined && { arg }) };
}

/** Whether this event should fire the rule. Mail that went to Junk never does. */
export function matches(rule: Rule, e: MailEvent): boolean {
	if (rule.event !== e.event || e.message.junk) return false;
	const has = (text: string, piece?: string) => !piece || text.toLowerCase().includes(piece);
	const m = e.message;
	return has(`${m.from.name} ${m.from.email}`, rule.from) && has([...m.to, ...m.cc, m.rcpt ?? ""].join(" "), rule.to) && has(m.subject ?? "", rule.subject);
}

export function alertText(e: MailEvent): string {
	const m = e.message;
	const who = e.event === "receive" ? `from ${m.from.name ? `${m.from.name} <${m.from.email}>` : m.from.email}` : `sent to ${m.to.join(", ")}`;
	return `${e.test ? "[test] " : ""}You've got mail ${who}: ${m.subject || "(no subject)"}`;
}

export function describe(r: Rule): string {
	const filters = FILTERS.filter((f) => r[f]).map((f) => `--${f} ${r[f]}`);
	return `${r.id}  ${r.times} ${r.event} ${filters.join(" ")} ${r.channel}${r.arg ? ` ${r.arg}` : ""}`;
}
