// Run: pnpm test  (Node strips the types; no test framework)
import assert from "node:assert/strict";
import { test } from "node:test";
import { messageIds, parseEmail } from "../server/utils/mail.ts";

const raw = (s: string) => new TextEncoder().encode(s.replace(/\n/g, "\r\n")).buffer as ArrayBuffer;

test("messageIds pulls every <id> out of a header", () => {
	assert.deepEqual(messageIds("<a@x> <b@y>\r\n <c@z>"), ["<a@x>", "<b@y>", "<c@z>"]);
	assert.deepEqual(messageIds(null), []);
});

test("parseEmail: reply threading refs, addresses, DMARC from our own header only", async () => {
	const p = await parseEmail(
		raw(`Authentication-Results: mx.cloudflare.net; dkim=pass; dmarc=pass header.from=x.com
Authentication-Results: evil.example; dmarc=fail
From: "Ann" <Ann@X.com>
To: Team: bob@y.com, cy@z.com;
Subject: Re: hi
Message-ID: <3@x.com>
In-Reply-To: <2@x.com>
References: <1@x.com> <2@x.com>
Date: Thu, 5 Nov 2026 19:45:29 -0500
Content-Type: text/html

<p>Hello&nbsp;<b>there</b></p><style>p{}</style>
`),
	);
	assert.equal(p.messageId, "<3@x.com>");
	// In-Reply-To first, then References newest-first.
	assert.deepEqual(p.refs, ["<2@x.com>", "<2@x.com>", "<1@x.com>"]);
	assert.deepEqual(p.from, [{ name: "Ann", email: "ann@x.com" }]);
	assert.deepEqual(p.to.map((a) => a.email), ["bob@y.com", "cy@z.com"]);
	assert.equal(p.dmarcFail, false, "a later, forged header must not count");
	assert.equal(p.preview, "Hello there");
	assert.equal(p.sentAt, Date.parse("2026-11-06T00:45:29Z"));
});

test("parseEmail: DMARC fail in our header is detected", async () => {
	const p = await parseEmail(raw("Authentication-Results: mx.cloudflare.net; dmarc=fail header.from=x.com\nSubject: s\n\nbody\n"));
	assert.equal(p.dmarcFail, true);
	assert.equal(p.messageId, null);
});

test("previewText: what an inbox line shows", async () => {
	const { previewText } = await import("../server/utils/mail.ts");
	assert.equal(
		previewText("[Bloomscape.com](https://bloomscape.com) No room for a tree? [Nimble logo](http://x.com/) Shop <https://x.com/a> now [image: Hero]", undefined),
		"Bloomscape.com No room for a tree? Shop now",
	);
	assert.equal(previewText("Easter sale [Cla", undefined), "Easter sale");
	assert.equal(previewText("View this email online ( https://x.com/v ) . Hi BestEgg ( https://x.co", undefined), "View this email online . Hi BestEgg");
	assert.equal(previewText("Easter sale [Claim it](https://x.co", undefined), "Easter sale");
	assert.equal(
		previewText("[Logo](https://x.com) plain", '<div style="display:none">Sale ends&nbsp;today&#8199;&zwnj;&#847;</div><img src="a.png" alt="Logo"><a href="https://x.com">Shop</a>'),
		"Sale ends today Shop",
	);
	// Google job alerts: a literal "\n" inside an Outlook conditional comment.
	assert.equal(previewText(undefined, '<div><!--[if mso]>\\n <style>td{}</style>\\n<![endif]-->Sr. Engineer</div>'), "Sr. Engineer");
});

test("decodeEntities: named, numeric, one pass, out-of-range numbers", async () => {
	const { decodeEntities } = await import("../server/utils/mail.ts");
	assert.equal(decodeEntities("I&#8217;m &ldquo;here&rdquo; &amp; I&rsquo;m &#x2014; ok&hellip;"), "I\u2019m \u201chere\u201d & I\u2019m \u2014 ok\u2026");
	assert.equal(decodeEntities("&amp;#8217;"), "&#8217;");
	assert.equal(decodeEntities("x&#99999999;y&bogus;z"), "x y z");
});
