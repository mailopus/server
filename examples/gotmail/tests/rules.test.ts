import assert from "node:assert/strict";
import { test } from "node:test";
import { type MailEvent, type Rule, alertText, matches, parseRule } from "../src/rules.ts";

const received = (over: Partial<MailEvent["message"]> = {}): MailEvent => ({
	event: "receive",
	message: { from: { name: "The Dude", email: "TheDude72@gmail.com" }, to: ["me@example.com"], cc: [], subject: "The rug", rcpt: "me@example.com", junk: false, ...over },
});

test("parseRule reads the two forms of an option and the channel's argument", () => {
	assert.deepEqual(parseRule(["once", "receive", "--from=TheDude72", "sound", "youvegotmail.wav"]), { times: "once", event: "receive", from: "thedude72", channel: "sound", arg: "youvegotmail.wav" });
	assert.deepEqual(parseRule(["every", "send", "--to", "hr@corpo.example", "--subject", "Offer", "slack"]), { times: "every", event: "send", to: "hr@corpo.example", subject: "offer", channel: "slack" });
	assert.deepEqual(parseRule(["once", "receive", "sms", "--from", "dude"]), { times: "once", event: "receive", from: "dude", channel: "sms" });
});

test("parseRule says what is wrong", () => {
	for (const [args, want] of [
		[["sometimes", "receive"], /once or every/],
		[["once", "read"], /receive or send/],
		[["once", "receive", "slack"], /at least one of/],
		[["once", "receive", "--from", "x"], /End with a channel/],
		[["once", "receive", "--from", "x", "pager"], /End with a channel/],
		[["once", "receive", "--body", "x", "slack"], /Unknown option --body/],
		[["once", "receive", "--from", "x", "slack", "extra"], /Too many words/],
		[["once", "receive", "--from"], /needs some text/],
	] as const)
		assert.match(String(parseRule([...args])), want);
});

test("matches needs every filter to hold, on the right event, and skips junk", () => {
	const rule = (over: Partial<Rule>): Rule => ({ id: "r", times: "once", event: "receive", channel: "slack", ...over });
	assert.ok(matches(rule({ from: "thedude72" }), received()));
	assert.ok(matches(rule({ from: "the dude" }), received()), "the display name counts");
	assert.ok(matches(rule({ to: "me@", subject: "rug" }), received()));
	assert.ok(!matches(rule({ from: "thedude72", subject: "bowling" }), received()));
	assert.ok(!matches(rule({ from: "thedude72", event: "send" }), received()));
	assert.ok(!matches(rule({ from: "thedude72" }), received({ junk: true })));
	assert.ok(matches(rule({ to: "list@" }), received({ cc: ["list@example.com"] })));
});

test("alertText names the sender, or the recipients of a send, and marks a test", () => {
	assert.equal(alertText(received()), "You've got mail from The Dude <TheDude72@gmail.com>: The rug");
	assert.equal(alertText({ ...received({ subject: null }), event: "send", test: true }), "[test] You've got mail sent to me@example.com: (no subject)");
});
