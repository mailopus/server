# Agent guide

This is a spam classifier for Mailopus: a Cloudflare Worker that gets a message's header block and returns the name of the rule that marks it as spam, or null. Mailopus files a message with a rule name in Junk and delivers the rest.

## Commands

- `pnpm check` runs the type check and every test. Run it before calling any change done.
- `pnpm test` runs the tests only (`node --test 'tests/*.test.ts'`, Node 23.6 or later, no build step).
- `pnpm dev` serves the Worker locally. `pnpm run deploy` deploys it.

## Files

- `src/rules.ts` holds the rules. Most changes happen here.
- `src/protocol.ts` defines the request and response Mailopus depends on.
- `src/index.ts` is the Worker: auth, parsing, then `classify()`.
- `tests/fixtures/*.txt` are header blocks, and `tests/fixtures/expected.json` says which rule each one must trigger under which context.
- `tests/rules.test.ts` checks the fixtures and the invariants below. `tests/protocol.test.ts` checks the HTTP contract.

## Adding or changing a rule

1. Put a header block that shows the problem in `tests/fixtures/<name>.txt`. Headers only, never a body. Replace real addresses, names and IPs with `example` domains and documentation IPs (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24).
2. Add cases to `tests/fixtures/expected.json`: the context Mailopus would send and the rule that must fire. Add a near miss with `"rule": null` too, such as the same sender when `firstContact` is false.
3. Run `pnpm test` and watch the new cases fail.
4. Change `src/rules.ts` until `pnpm check` passes.

## Rules that must hold

The tests enforce most of these. Don't weaken a test to make a rule pass.

- **An unknown fact never junks mail.** Mailopus leaves a context field out when its lookup failed. `needs({})` must be false for every rule. Compare with `=== true` and `=== false`, never with truthiness.
- **Match tooling and infrastructure, not wording.** Mailers, Message-ID formats, Received chains and sending platforms are expensive for a sender to change. Subject lines and pitches are cheap. A single common signal is a false positive waiting to happen, so pair it with a second one or with a context fact.
- **First match wins.** Put the most specific rule first, since its name is what the user sees.
- **Rule names** are lowercase with dashes, unique, and at most 64 characters.
- **Regexes must stay linear.** No nested quantifiers like `(a+)+`. A test runs every rule against a 200 KB header line and fails over 50 ms.
- **The protocol doesn't change here alone.** Mailopus (`server/lib/ingest.ts`, `askRemote`) sends `{headers, ctx}` with a Bearer key and reads `{rule}`. It waits 1.5 s and treats every non-200 as no verdict.
- **Keep nothing.** No D1, KV, R2 or logging of headers. They are other people's mail metadata.
