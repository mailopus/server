# Mailopus spam classifier

A starting point for your own Mailopus spam rules. It's a Cloudflare Worker that Mailopus calls once for each inbound message. Mailopus sends the header block and three facts it knows about the sender. The Worker answers with the name of the rule that matched, or `null`. A named message goes to Junk, and Mailopus stores the name with it as the reason.

The body never leaves your Mailopus server, and this Worker keeps nothing.

## Deploy

```sh
pnpm install
pnpm check
openssl rand -base64 32 | npx wrangler secret put CLASSIFIER_KEY   # keep a copy for the next step
pnpm run deploy
```

Then add it to your Mailopus server's `SPAM_CLASSIFIERS` secret. It's a list, asked in order, and the first rule name wins:

```sh
echo '[{"url":"https://mailopus-spam-classifier.<your subdomain>.workers.dev/v1/check","key":"<the key>"}]' \
  | pnpm mailopus secret put SPAM_CLASSIFIERS   # run in your Mailopus checkout
```

## Try it

```sh
curl -s https://mailopus-spam-classifier.<your subdomain>.workers.dev/v1/check \
  -H "authorization: Bearer <the key>" -H "content-type: application/json" \
  -d '{"headers":"X-Mailer: PHPMailer 6.9\r\nFrom: a@b.example\r\n","ctx":{"firstContact":true}}'
# {"rule":"bulk-library-first-contact"}
```

## The protocol

`POST /v1/check` with `Authorization: Bearer <key>` and this JSON body:

| Field | Type | Meaning |
|---|---|---|
| `headers` | string | The message's header block as received, up to 256 KB. Header names keep their case. |
| `ctx.firstContact` | boolean, optional | True when the account has never sent mail to the From address. |
| `ctx.senderHasRdns` | boolean, optional | Whether the connecting IP has reverse DNS. |
| `ctx.senderDomainAgeDays` | number, optional | Days since the From domain was registered. |

A missing `ctx` field means Mailopus couldn't find out. Rules must treat that as "don't know", never as a match.

The answer is `200 {"rule": "<name>"}` or `200 {"rule": null}`. Anything else, including a reply slower than 1.5 seconds, counts as no verdict, so a broken classifier delays nothing and junks nothing.

## Writing rules

The rules are in `src/rules.ts`, and each one is regexes over the headers plus an optional check on the facts. Test cases are header blocks in `tests/fixtures/` with expectations in `tests/fixtures/expected.json`. [AGENTS.md](AGENTS.md) has the steps and the rules every change has to keep. It's written so that a coding agent can follow it too.

## License

[PolyForm Shield 1.0.0](LICENSE). Change the rules freely for your own use. Keep the `Required Notice` line from `LICENSE` with any copy.
