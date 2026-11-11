# Spam

Mailopus files each inbound message in Inbox or Junk. A message goes to Junk when any one of these says so:

1. **DMARC failure.** The Authentication-Results header from Email Routing says `dmarc=fail`. Always on.
2. **A blocked sender.** You blocked the From address or its domain. Always on.
3. **A spam rule.** A rule matched the message's headers. Rules come from a bound spam Worker, from remote classifiers you list, or from rules compiled into your server. A fresh server has none of these, so this step is off until you add one.

Junk mail gets no push notification, and its remote images stay blocked when you open it. A message filed by a rule keeps the rule's name. The UI doesn't show it yet, so to find out why a message landed in Junk, list the newest Junk mail in an account with the reason for each:

```sh
pnpm mailopus junk sam@example.com
```

The address is any one the account sends as. Blocked senders show up as `blocked-sender`, and mail a plugin junked as `plugin:<name>`. A DMARC failure has no rule name.

Everything on this path fails open. If a lookup, a rule or a classifier throws or times out, the message goes to Inbox. A filter that can lose mail is worse than no filter.

## Blocked senders

Open a message, then use its menu to block the sender's address or domain. New mail from a blocked sender goes to Junk. Settings > Mail > Blocked senders lists them and has **Unblock** for each.

A pattern like `@example.com` covers that host and every subdomain, so `@example.com` also blocks `news.example.com`. Blocks are per account and apply only to mail that arrives after you block.

## What a rule sees

For each inbound message the Worker builds:

- **The header block.** Every header as received, unfolded, with names in their original case. Never the body.
- **Three facts about the sender**, each left out when the lookup fails:

| Fact | What it means | How it's found |
|---|---|---|
| `firstContact` | You have never sent mail to the From address. | Your account's correspondents in D1 |
| `senderHasRdns` | The connecting IP has a PTR record. IPv4 only. | DNS-over-HTTPS to `cloudflare-dns.com`, 2 second timeout, cached 7 days |
| `senderDomainAgeDays` | Days since the From domain was registered | RDAP through `www.rdap.net`, 3 second timeout, cached forever once known |

A rule must treat a missing fact as "don't know". It may never fire because a fact is absent.

## The order rules run in

The first verdict wins:

1. The `SPAM` service binding, if your Worker has one. If it throws, the built-in rules run instead.
2. Otherwise the built-in rules in `server/lib/spam/rules.ts`. This repo ships that list empty.
3. Each remote classifier in the `SPAM_CLASSIFIERS` secret, in order, but only if steps 1 and 2 found nothing.

## Remote classifiers in `SPAM_CLASSIFIERS`

This is the simplest way to add rules. `SPAM_CLASSIFIERS` is a Worker secret holding a JSON list of classifiers:

```json
[{ "url": "https://classifier.example.com/v1/check", "key": "..." }]
```

Each entry needs an `https://` URL and a key. The Worker asks each in order and stops at the first rule name. A classifier that answers anything but `200`, or takes longer than 1.5 seconds, counts as no verdict. A value that isn't valid JSON counts as an empty list and logs a warning. It never stops delivery.

### Set it

From your clone:

```sh
echo '[{"url":"https://classifier.example.com/v1/check","key":"<key>"}]' | pnpm mailopus secret put SPAM_CLASSIFIERS
```

Keep the key out of your shell history. One way is to put the JSON in a file outside the repo and run `pnpm mailopus secret put SPAM_CLASSIFIERS < that-file`.

### Turn it off

```sh
pnpm mailopus secret delete SPAM_CLASSIFIERS
```

To drop one classifier, put the secret again without it.

### The hosted rules

app.mailopus.net's own rules are private. You can use them as a remote classifier at `https://spam.mailopus.net/v1/check`. Keys are issued by hand for now. Ask for one, then:

```sh
echo '[{"url":"https://spam.mailopus.net/v1/check","key":"msk_..."}]' | pnpm mailopus secret put SPAM_CLASSIFIERS
```

With it on, your Worker sends spam.mailopus.net each inbound message's header block and the three facts. That includes From, To, Subject and the Received chain. It never includes the body. The service answers with a rule name or nothing and stores neither.

## Your own classifier

`examples/spam-classifier` is a starting point: a Worker with three example rules and tests. It needs Node.js 23.6 or later.

### Deploy it

```sh
cd examples/spam-classifier
```

```sh
pnpm install
```

```sh
pnpm check
```

```sh
openssl rand -base64 32 | npx wrangler secret put CLASSIFIER_KEY
```

That last command sets the key without printing it, so generate it into a file first if you need a copy for the next step. Then deploy:

```sh
pnpm run deploy
```

Add it to your Mailopus Worker, from the repo root:

```sh
echo '[{"url":"https://mailopus-spam-classifier.<your subdomain>.workers.dev/v1/check","key":"<the key>"}]' | pnpm mailopus secret put SPAM_CLASSIFIERS
```

To use both your classifier and the hosted rules, list both. The first one in the list is asked first.

### Try it

```sh
curl -s https://mailopus-spam-classifier.<your subdomain>.workers.dev/v1/check \
  -H "authorization: Bearer <the key>" -H "content-type: application/json" \
  -d '{"headers":"X-Mailer: PHPMailer 6.9\r\nFrom: a@b.example\r\n","ctx":{"firstContact":true}}'
```

It should answer `{"rule":"bulk-library-first-contact"}`.

### The protocol

`POST /v1/check` with `Authorization: Bearer <key>` and this body:

| Field | Type | Meaning |
|---|---|---|
| `headers` | string | The header block, up to 256 KB |
| `ctx.firstContact` | boolean, optional | See the facts table above |
| `ctx.senderHasRdns` | boolean, optional | |
| `ctx.senderDomainAgeDays` | number, optional | |

Answer `200 {"rule": "<name>"}` or `200 {"rule": null}`. Rule names are lowercase with dashes, at most 64 characters. Mailopus stores the name with the message.

### Write rules

Rules live in `examples/spam-classifier/src/rules.ts`. Each one is a list of regexes that must all match the headers, plus an optional `needs` check on the facts. [AGENTS.md](../examples/spam-classifier/AGENTS.md) has the full steps, and it's written so a coding agent can follow it too. The short version:

1. Save a header block that shows the problem as `tests/fixtures/<name>.txt`. Headers only. Replace real addresses, names and IPs with `example` domains and documentation IPs.
2. Add cases to `tests/fixtures/expected.json`, including a near miss that must not match.
3. Run `pnpm test` and watch the new case fail.
4. Change `src/rules.ts` until `pnpm check` passes, then `pnpm run deploy`.

Match the sender's tooling and infrastructure, such as mailer headers, Message-ID formats and Received chains, not the wording. Wording is cheap to change. Pair any common signal with a second one or with a fact. The tests also fail any regex that takes over 50 ms on a 200 KB header line.

The classifier must keep nothing. No D1, KV, R2 or logging of headers, since they're other people's mail metadata.

### Training

There's no learning step. Moving a message into or out of Junk doesn't teach any classifier. You train by adding fixtures and rules as above. Blocked senders are the per-account feedback that works today.

## A spam Worker on the `SPAM` binding

app.mailopus.net gets its own rules this way. A binding skips the HTTP round trip and the 1.5 second timeout, and a rule change deploys in seconds without rebuilding Mailopus.

The customer template, `wrangler.jsonc`, has no `SPAM` binding. You can add one for your own Worker. It must export an entrypoint class with a `check(headers, ctx)` method that returns a rule name or `null`:

```jsonc
"services": [{ "binding": "SPAM", "service": "<your spam worker>", "entrypoint": "SpamFilter" }]
```

```ts
import { WorkerEntrypoint } from "cloudflare:workers";

export class SpamFilter extends WorkerEntrypoint {
	async check(headers: string, ctx: { firstContact?: boolean; senderHasRdns?: boolean; senderDomainAgeDays?: number }) {
		return null; // or a rule name
	}
}
```

`examples/spam-classifier` speaks HTTP, not this interface, so it needs a small wrapper class to work as a binding. I haven't tested that path for customers. A remote classifier in `SPAM_CLASSIFIERS` is the supported route. To turn the binding off, remove the `services` entry and deploy.

## Rules built into your server

`RULES` in `server/lib/spam/rules.ts` is an empty list, and `match()` there runs it when no `SPAM` binding exists. You can add rules to it in your copy of the repo, in the same shape as the example classifier's. They then run on every message with no network call. The cost is a fork to maintain, and every rule change needs a full redeploy.
