# Set up Mailopus in your own cloud account

Mailopus runs as a Worker in your own Cloudflare account. Your mail sits in your D1 database and R2 bucket. The UI at app.mailopus.net is a static app that talks straight to your Worker from your browser. mailopus.net never receives your mail, never stores it and never holds a token for it.

This page takes you from nothing to a working inbox. Expect about 30 minutes, most of it waiting for DNS.

## What you need

- **A domain.** For example `example.com`. Its DNS has to be on Cloudflare, in the same Cloudflare account as the Worker, because Email Routing only hands mail to a Worker in the zone's own account. If the zone has to live in another account, see [Domains in another Cloudflare account](addresses.md#domains-in-another-cloudflare-account).
- **A Cloudflare account on Workers Paid.** It costs $5 a month. Email Sending needs it, so the free plan can receive mail but can't send.
- **Cloudflare, for now.** Mailopus runs only on Cloudflare today. Other hosts are planned.
- **For a deploy from a clone.** Git, pnpm and Node.js. The `mailopus` command imports TypeScript files directly, so use a Node.js version that strips types on its own, 22.18 or later.

## 1. Deploy the Worker

There are two ways. Both deploy `wrangler.jsonc`, which is the template for your server.

### With the Deploy to Cloudflare button

The button on the [README](../README.md) copies the repo into your GitHub and deploys it from there. Keep the build and deploy commands it fills in. The deploy command is `pnpm run deploy`, and that applies the D1 migrations, which the button doesn't do on its own. Your claim code is in the first build's log, in Workers & Pages > mailopus > Deployments.

Some later jobs, such as adding a person or importing old mail, use the `mailopus` command, which runs from the repo. For those, clone your GitHub copy, run `pnpm install` and sign in with `pnpm mailopus login`. Keep the resource names the button suggests, since the docs use them.

### From a clone

```sh
pnpm install
```

```sh
pnpm mailopus login
```

```sh
pnpm mailopus whoami
```

`whoami` prints your account id. Then deploy:

```sh
CLOUDFLARE_ACCOUNT_ID=<your account id> pnpm run deploy
```

`pnpm run deploy` runs `mailopus deploy`, which does these things in order:

1. `nitro build`, which builds the server. The UI stays at app.mailopus.net.
2. `wrangler d1 migrations apply DB --remote`, only when the database already exists, so an update never runs new code on an old schema
3. `wrangler deploy`
4. `wrangler d1 migrations apply DB --remote` again, so a first deploy gets its tables
5. if the Worker has no `CLAIM_CODE` secret yet, sets a random one and prints it with a claim link

Keep the claim code until step 5. Claiming your server needs it, so nobody who finds your new Worker can claim it before you. If you lose it before claiming, set a new one with `pnpm mailopus secret put CLAIM_CODE`.

The first `wrangler deploy` creates the resources `wrangler.jsonc` names:

| Resource | Name |
|---|---|
| Worker | `mailopus` |
| D1 database | `mailopus` |
| R2 bucket | `mailopus-mail` |
| Queue | `mailopus-import` |
| Durable Object class | `Account` |

`wrangler.jsonc` leaves out resource ids on purpose. Wrangler creates the resources on the first deploy. If it asks to write their ids into `wrangler.jsonc`, say no, or a later `git pull` will conflict on that file.

When it's done the Worker answers at `https://mailopus.<your subdomain>.workers.dev`. Write that URL down. You need it in the next step.

A custom domain works too, for example `mail.example.com`. Add it to the Worker in the dashboard under Workers & Pages > mailopus > Settings > Domains & Routes, then use it everywhere this page says workers.dev.

## 2. Add the `_mailopus` TXT record

The UI finds your Worker through a TXT record on your domain. Add it in the Cloudflare dashboard under your domain's DNS > Records:

| Type | Name | Content |
|---|---|---|
| TXT | `_mailopus` | `https://mailopus.<your subdomain>.workers.dev` |

Cloudflare shows the full name as `_mailopus.example.com`. The content is the Worker's origin: `https://`, the host, and nothing after it. No path, no trailing slash. The UI ignores a record that isn't `https://`.

Check it before you go on:

```sh
dig +short TXT _mailopus.example.com
```

It should print the URL in quotes. [Sign-in and discovery](sign-in.md) explains what reads this record and when.

## 3. Turn on Email Routing

Email Routing receives mail for your domain and hands it to the Worker.

1. In the dashboard, open your domain, then Email > Email Routing.
2. Turn it on. Let it add its MX and SPF records. If the domain already receives mail somewhere else, those records replace that.
3. Under Routing rules, edit the catch-all address. Set the action to **Send to a Worker** and pick `mailopus`. Save and make sure the rule is enabled.

The catch-all sends every address at the domain to the Worker, and the Worker decides what to accept. It looks up the recipient in its own list of routes in D1, in this order:

1. the exact address, `sam+news@example.com`
2. the address without its `+tag`, `sam@example.com`
3. a catch-all route for the domain, `*@example.com`

If none of them is there, the Worker refuses the message during the SMTP conversation with `Address not found`, so the sender gets a bounce instead of a silent loss.

Claiming in step 5 routes only the address you claim with. If you want every address at the domain to reach you, turn on the catch-all afterwards, as in [The catch-all route](addresses.md#the-catch-all-route).

You can route only some addresses in Email Routing instead of the catch-all. Mail to any address without a rule then never reaches Mailopus, and Email Routing handles it by its own rules.

## 4. Turn on Email Sending

1. Open Email > Email Sending.
2. Add `example.com`.
3. Add every DNS record it lists. With the zone on Cloudflare it can add them for you.
4. Wait until the domain shows as verified.

Until then, every send fails. Mailopus only sends From an address that is one of your identities in D1, so even with Email Sending on, nobody can use your Worker to send as an address you haven't added.

## 5. Claim your server

1. Open the claim link the deploy printed, `https://app.mailopus.net/auth/claim#code=...`. It fills in your claim code. You can also open [app.mailopus.net/auth/claim](https://app.mailopus.net/auth/claim) and paste the code. The code stays in the link's fragment, which browsers never send to a server.
2. Enter your name and an address at your domain, for example `sam@example.com`.
3. Press **Create passkey** and save the passkey where your browser offers, such as iCloud Keychain, Google Password Manager or a security key.

The page looks up `_mailopus.example.com`, finds your Worker and registers the passkey there. Claiming creates, in one transaction:

- you, as the owner and admin
- your mail account and its standard mailboxes: Inbox, Drafts, Sent, Archive, Junk, Trash and Scheduled
- a send-as identity for the address you entered
- a route for the address you entered
- your passkey

Nothing is saved until the passkey verifies, so an abandoned claim leaves the server open to whoever has the claim code. Once one claim succeeds, the claim page refuses everyone else for good, code or not. A server with no `CLAIM_CODE` set refuses every claim.

From then on, sign in at [app.mailopus.net](https://app.mailopus.net) with your address and that passkey.

## 6. Check it works

1. Send a message from another account to `sam@example.com`. It should show up in your Inbox within a few seconds.
2. Send one from Mailopus to an outside address. If it fails, Email Sending isn't verified yet.
3. Send one to an address you never added. The sender should get a bounce.

`pnpm mailopus logs` streams your Worker's logs. Each received message logs `email: stored`, and each refused one logs `email: no account for recipient`.

## Updates

Releases are tags, listed with their notes on [GitHub releases](https://github.com/mailopus/server/releases). Nothing updates your server on its own.

**From the Deploy button.** The button made a copy of the repo in your GitHub, not a fork. Pull the release tag into your copy and push it. Each push redeploys and migrates.

**From a clone.**

```sh
git pull https://github.com/mailopus/server.git v1.2.3
```

```sh
pnpm install
```

```sh
CLOUDFLARE_ACCOUNT_ID=<your account id> pnpm run deploy
```

Migrations run before and after the deploy, as in step 1.

## Next

- [Addresses and domains](addresses.md): more addresses, `+` aliases, more domains
- [Mail apps](proxy.md): desktop and phone mail apps through the IMAP and SMTP proxy
- [Spam](spam.md): what your server filters on its own, and how to add rules
- [Configuration](configuration.md): every setting, notifications, Gmail import and backups
