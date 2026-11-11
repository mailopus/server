# Mailopus

Email you run in your own cloud account. The server speaks JMAP and keeps your mail in your database and file storage. The UI at app.mailopus.net talks straight to it, so your mail stays in your account. mailopus.net never receives it, stores it or holds a token for it. It does serve the app your browser runs, so you trust that code. [What mailopus.net sees](docs/sign-in.md#what-mailopusnet-sees) has the details.

## Run it in your own cloud account

You need a domain on Cloudflare and a Cloudflare account on Workers Paid, $5 a month, which Email Sending requires. Mailopus runs only on Cloudflare today.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mailopus/server)

Or from a clone:

```sh
git clone https://github.com/mailopus/server.git
cd server
pnpm install
CLOUDFLARE_ACCOUNT_ID=<your account id> pnpm run deploy
```

Then add the `_mailopus` TXT record, turn on Email Routing and Email Sending, and claim the server at [app.mailopus.net/auth/claim](https://app.mailopus.net/auth/claim). [docs/setup.md](docs/setup.md) has every step.

## Updates

Releases are tags, `vMAJOR.MINOR.PATCH`, with notes on [GitHub releases](https://github.com/mailopus/server/releases). A major release starts its notes with "Action needed". Nothing updates your server on its own: you read the notes and deploy.

From a clone:

```sh
git pull https://github.com/mailopus/server.git v1.2.3
pnpm run deploy
```

The button made a copy of this repo in your GitHub, not a fork. Pull the tag into your copy the same way and push it, and your Cloudflare build redeploys and migrates. Watch this repo for releases to hear about new ones.

## Documentation

[docs/](docs/README.md) covers setup, addresses and domains, sign-in, mail apps through the IMAP proxy, spam, configuration and troubleshooting.

## Development

```sh
pnpm install
pnpm test
pnpm build
```

`wrangler.jsonc` is the template customers deploy, and `pnpm build` builds the server it runs. The UI at app.mailopus.net isn't in this repo. app.mailopus.net runs this code with its own config and its own spam rules, both kept out of this repo. This repo has only the spam engine, `server/lib/spam/rules.ts`, and no rules.

## License

[PolyForm Shield 1.0.0](LICENSE). You may use, change and share Mailopus for any purpose except offering a product that competes with it, such as reselling it or hosting it for others. Keep the `Required Notice` line from `LICENSE` with any copy. `imap/third_party/go-imap` is upstream go-imap under its own MIT license. Bundled work is listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
