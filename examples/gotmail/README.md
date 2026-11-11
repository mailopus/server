# gotmail: you've got mail

A Mailopus plugin that alerts you when mail you're waiting for arrives, or when a message you care about goes out. It's also the example to copy when you write your own plugin.

```sh
pnpm mailopus with gotmail once receive --from thedude72 sound youvegotmail.wav
pnpm mailopus with gotmail every send --to hr@corpo.example slack
```

gotmail sees the envelope and subject of each message, never the body. It keeps your rules in its own KV namespace and nothing else.

## Deploy

gotmail runs in the same Cloudflare account as your Mailopus server, which reaches it over a service binding. It has no public address and needs no key.

In this folder:

```sh
pnpm install
pnpm check
pnpm run deploy
```

Then, in your Mailopus clone:

```sh
pnpm mailopus plugin add gotmail
pnpm run deploy
```

The first command adds the binding to your server's `wrangler.jsonc`, and the deploy turns it on. If your server deploys from GitHub, commit and push that file instead. gotmail only watches, so it needs no other `plugin add` options.

Check it:

```sh
pnpm mailopus plugin test gotmail
```

### In another account

To run gotmail away from your server's account, set `"workers_dev": true` in `wrangler.jsonc`, deploy, and connect it by URL:

```sh
pnpm mailopus plugin add gotmail https://mailopus-gotmail.<your subdomain>.workers.dev
```

It prints a key. Set it here with `npx wrangler secret put PLUGIN_KEY`. The plugin then has a public address guarded by that key, so prefer the binding when you can.

## Set up the channels you want

Each channel needs its own secrets on this Worker, set with `npx wrangler secret put <NAME>`. Set up only the ones you'll use.

| Channel | Secrets | Notes |
|---|---|---|
| `slack` | `SLACK_WEBHOOK_URL` | A Slack incoming webhook URL |
| `webhook` | `WEBHOOK_URL` | Gets a JSON `POST` with `text`, the `rule` and the `event`. Works with ntfy, Discord, Zapier and the like. |
| `sms` | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `SMS_TO` | Needs a Twilio account and number. `SMS_TO` is your default number, and a rule can name another. |
| `sound` | none | Plays on your own machine. See [Sound alerts](#sound-alerts). |

`pnpm mailopus with gotmail list` shows which channels are set up.

## Rules

```
once|every receive|send [--from <text>] [--to <text>] [--subject <text>] <channel>
```

- `once` alerts one time and removes the rule. `every` keeps alerting.
- `receive` watches mail coming in, `send` watches mail going out.
- `--from`, `--to` and `--subject` each match a piece of text, in any letter case. `--from thedude72` matches `TheDude72@gmail.com`, and `--from "the dude"` matches the sender's name. A rule needs at least one, and all of them must match.
- The channel is `slack`, `webhook`, `sms [number]` or `sound [file]`.

Mail that goes to Junk never alerts.

```sh
pnpm mailopus with gotmail list
pnpm mailopus with gotmail remove <id>
pnpm mailopus with gotmail help
```

## Try a rule before the mail comes

```sh
pnpm mailopus plugin test gotmail receive --from thedude72@gmail.com --subject "The rug"
```

This sends gotmail a made-up message. A matching rule alerts for real, with `[test]` in front, and a `once` rule stays in place. The answer shows how many rules fired, and any channel that refused the alert.

## Sound alerts

A Worker can't play audio, so a sound plays on the machine where you leave this running:

```sh
pnpm mailopus with gotmail listen
```

It checks every 5 seconds and plays the rule's file when an alert fires. The file path is read on that machine, relative to where you ran `listen`. With no file, or a file that isn't there, it plays a default sound on macOS and rings the terminal bell elsewhere. Playback uses `afplay` on macOS and `aplay` on Linux.

An alert waits up to 10 minutes for a listener, then is dropped. A sound alert can't reach you while `listen` isn't running, so pair it with another channel for mail you can't miss.

## How it works

- `src/index.ts` is how the plugin is reached: the `Plugin` entrypoint for your server's binding, and a public handler that needs `PLUGIN_KEY`.
- `src/app.ts` is what it does: `POST /v1/event` from your server and `POST /v1/command` from `mailopus with gotmail`.
- `src/rules.ts` reads a rule from the command words and decides whether a message matches. It touches no network or storage.
- `src/channels.ts` sends an alert to Slack, a webhook or Twilio.

The protocol is in the Mailopus docs under Plugins. `pnpm test` runs the whole Worker with KV as a `Map` and `fetch` stubbed, so no test sends anything.

Rules and waiting sound alerts are each one KV value that is read, changed and written back. Two changes in the same second can lose one. That is fine for one person's alerts. Use a Durable Object if you build something busier on this.
