# Troubleshooting

Start with the logs. From your clone:

```sh
pnpm mailopus logs
```

It streams every request and every inbound message live. Older logs are in the dashboard under Workers & Pages > mailopus > Logs. Each received message logs `email: stored`. Each refused one logs `email: no account for recipient` with the address.

These show what your server knows. Run them from your clone:

```sh
pnpm mailopus status
```

```sh
pnpm mailopus address list
```

```sh
pnpm mailopus identity list
```

`status` says whether the server is claimed and what each domain's `_mailopus` record points at. `address list` is every address that receives mail, and `identity list` is every address someone sends as.

For anything these don't cover, `pnpm mailopus sql "<SQL>"` runs a query against your live database.

## Deploying

**`pnpm run deploy` fails with an authentication error.** Run `pnpm mailopus login`, or set `CLOUDFLARE_API_TOKEN` to a token that can edit Workers, D1, R2 and Queues. Check the account with `pnpm mailopus whoami` and pass its id as `CLOUDFLARE_ACCOUNT_ID`.

**The deploy worked but the app shows errors about missing tables.** Migrations didn't run. Run them yourself:

```sh
pnpm mailopus migrate
```

A Deploy-button setup whose deploy command isn't `pnpm run deploy` skips migrations on every update. Fix the command in the dashboard under the Worker's Settings > Build.

**`pnpm mailopus` fails with a syntax error on a `.ts` import.** Your Node.js is too old to strip types. Use 22.18 or later.

**A command says "no account sends as ..." or can't find the database.** `pnpm mailopus` uses the `DB` binding in `wrangler.jsonc` and your Cloudflare login. Run it from your clone, and check `pnpm mailopus whoami` names the account the Worker is in.

## Claiming and signing in

**The claim page says "This server already has an owner."** Someone claimed it, possibly you on an earlier try. Check:

```sh
pnpm mailopus status
```

If it was you, sign in instead. If you lost the passkey, see [Lost every passkey](sign-in.md#lost-every-passkey). If it wasn't you, someone had your claim code. Delete the Worker, its D1 database and its R2 bucket, then deploy again and keep the new code to yourself.

**The claim page or sign-in talks to app.mailopus.net instead of your Worker.** The browser didn't find a usable `_mailopus` TXT record. Check what the record says:

```sh
pnpm mailopus status
```

It lists each of your domains with the URL its record holds, or says what is wrong with it. The record must hold an `https://` URL. Common mistakes are a record on the wrong name, such as `_mailopus.example.com.example.com`, a value with a path, or `http://`. A new record can take a few minutes. To claim before DNS catches up, put your Worker in the link:

```
https://app.mailopus.net/auth/claim#server=https://mailopus.<your subdomain>.workers.dev
```

**Sign-in says "Sign-in failed."** In order of likelihood:

- The TXT record is missing or wrong, as above, so the page asked app.mailopus.net.
- You picked a passkey made for a different Mailopus server.
- `APP_ORIGIN` or `RP_ID` changed since you made the passkey. A passkey works only with the `RP_ID` it was made for.

**The claim page says "That claim code is wrong."** Use the code `pnpm run deploy` printed on your first deploy. Lost it? Set a new one from your clone with `pnpm mailopus secret put CLAIM_CODE`, then claim with that.

**The claim page says "This server has no claim code yet."** The first deploy didn't get as far as setting it, or the server was deployed without `pnpm run deploy`. Set one with `pnpm mailopus secret put CLAIM_CODE`.

**"Too many attempts. Wait a minute."** Each IP gets 20 sign-in, claim or invite calls a minute. Wait a minute.

**"Cancelled."** The browser's passkey prompt was closed or timed out. Try again.

**The invite page says "That did not work. The invite may be used or expired."** Invite links work once and for 24 hours. Make a new one. Also check that the link has `&server=` with your Worker, as in [Add a passkey](sign-in.md#add-a-passkey-or-another-device). Without it the invite goes to app.mailopus.net. `pnpm mailopus invite` adds it from your domain's `_mailopus` TXT record, or from `--server`.

**Signed out after a while.** Sessions last 30 days. Sign in again. Clearing the site's data for app.mailopus.net also removes the stored session token.

**A white screen after an update.** Reload. The app's HTML is sent `no-store`, so a reload always gets the current version.

## Receiving

**Senders get a bounce saying "Address not found".** The Worker has no route for that address. Run the `addresses` query above. Either add the address in Settings > Addresses, use **Receive mail** on it, or turn on the domain's catch-all as in [Addresses](addresses.md#the-catch-all-route).

**Nothing arrives, and nothing shows in the logs.** Mail isn't reaching the Worker:

- Email Routing is off for the domain, or its MX records are missing or point somewhere else. The Email Routing page shows the state of its DNS records.
- The catch-all rule is disabled, or its action isn't **Send to a Worker** with `mailopus`.
- The zone is in a different Cloudflare account from the Worker. See [Domains in another account](addresses.md#domains-in-another-cloudflare-account).

**Mail arrives in the wrong account.** An exact route beats a `+` alias, and both beat a domain catch-all. Check which account each matching route points at with the `addresses` query.

**Good mail goes to Junk.** Three possible reasons:

- The sender's DMARC failed. That's common with forwarded mail and badly set up mailing lists. Ask the sender to fix their SPF and DKIM.
- You blocked the sender or their domain. Check Settings > Mail > Blocked senders.
- A spam rule matched. Find which one with the query in [Spam](spam.md), then fix or drop the rule.

**Spam isn't filtered.** A fresh server has no spam rules. See [Spam](spam.md) to add a classifier. If you did add one, look for `spam: classifier answered` or `spam: classifier failed` in the logs. A 401 means a wrong key, and a timeout means it took over 1.5 seconds. `spam: SPAM_CLASSIFIERS is not valid JSON` means the secret needs setting again.

## Sending

**Sending fails for every recipient.** Email Sending isn't set up or verified for the From domain. Open Email > Email Sending and check the domain's status and DNS records.

**Can't pick an address in the From menu.** Mailopus only sends as identities. Add the address in Settings > Addresses, or for a new domain follow [More domains](addresses.md#more-domains).

**Settings won't add an address: "isn't set up for Mailopus yet".** The domain has no address in your account yet. Add the first one with `pnpm mailopus identity add`, as in [More domains](addresses.md#more-domains).

**"That's the last address you send as."** Every account needs one address to send as. Add another before you remove this one.

## Mail apps

**The app password section says there's no IMAP proxy.** `IMAP_HOST` isn't set. Add it to `vars` and deploy, as in [Mail apps](proxy.md#5-show-the-hosts-in-settings).

**A mail app can't connect at all.**

- The DNS records for `imap.` and `smtp.` must be DNS only, the grey cloud. Cloudflare's proxy doesn't carry mail ports.
- The server's firewall must allow 993, 465 and 587.
- `IMAP_BIND` must be `0.0.0.0` on a server. The default listens on localhost only.
- From the server, `docker compose logs --tail 100` shows TLS or certificate errors. With `TLS_MODE=acme`, check that `CF_API_TOKEN` can edit DNS on the zone.

**The app connects but sign-in fails.**

- The username must be your full email address, and the password an app password, not your passkey.
- Make sure the proxy's `MAILOPUS_URL` is your Worker, not app.mailopus.net.
- Five failures in 15 minutes lock the IP out of the proxy for 15 minutes. Wait it out.
- A log line saying the server lacks IMAP support means your Worker is older than the proxy. Update and deploy the Worker.

**A mail app sees only some mail.** The app password is limited to some addresses. Settings > App passwords shows what each one sees. Make a new one with **All mail** if needed.

**Can't create or rename folders from the mail app.** The proxy doesn't support that yet.

## Notifications

**The Turn on button is missing on iPhone.** Add Mailopus to the home screen with Share > Add to Home Screen and open it from there. Safari only allows notifications for home-screen apps.

**"Notifications are blocked in this browser's site settings."** Allow notifications for app.mailopus.net in the browser's site settings, then reload.

**Notifications stopped after moving servers.** The VAPID keys changed. Turn notifications off and on again on each device.

## Gmail import

**`status` shows `unauthorized_client` as the last error.** Domain-wide delegation for `gmail.readonly` isn't granted to the service account's client ID yet, or Google hasn't applied it. It can take a few minutes after you add it.

**`secret GOOGLE_SA_WORK is not set`.** The secret name doesn't match the name passed to `import start`. The server uppercases it, so `work` reads `GOOGLE_SA_WORK`.

**A job stays `pending`.** The cron starts jobs every 5 minutes. If it's still pending after 10 minutes, check that the `crons` trigger is in `wrangler.jsonc` and that the Worker deployed with it.

**Some messages failed.** `rescan <job id>` walks the mailbox again and fetches only what's missing.
