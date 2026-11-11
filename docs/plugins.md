# Plugins

A plugin is a Worker you deploy that your server tells about mail as it arrives and as it goes out. A plugin can watch, and if you let it, it can file received mail or stop a send. You run a plugin's own commands through `pnpm mailopus with <plugin> ...`.

[`examples/gotmail`](../examples/gotmail/README.md) is a working one. It alerts you by Slack, webhook, text message or a sound when mail you're waiting for arrives.

## Connect a plugin

A plugin runs as its own Worker in the same Cloudflare account as your server. Your server reaches it over a service binding, so the plugin has no public address and needs no key. Nothing outside your account can call it.

Deploy the plugin first, following its README. Then, from your Mailopus clone:

```sh
pnpm mailopus plugin add gotmail
pnpm run deploy
```

`plugin add` does two things. It records the plugin in your database, and it adds a service binding to `wrangler.jsonc`:

```jsonc
"services": [
	{ "binding": "PLUGIN_GOTMAIL", "service": "mailopus-gotmail", "entrypoint": "Plugin" }
],
```

The deploy turns the binding on. If your server deploys from GitHub, as it does after the Deploy button, commit and push `wrangler.jsonc` instead, or the next build drops the binding. The deploy fails if the plugin's Worker doesn't exist yet, which is why the plugin goes first.

| Option | Default | What it does |
|---|---|---|
| `--service <worker>` | `mailopus-<name>` | The plugin Worker's name, from its own `wrangler.jsonc` |
| `--binding <NAME>` | `PLUGIN_<NAME>` | The binding's name on your server |
| `--events receive,send` | both | Which events the plugin hears about |
| `--wants envelope\|headers\|body` | `envelope` | How much of each message it sees. See [What a plugin sees](#what-a-plugin-sees). |
| `--act` | off | The server waits for the plugin's answer and follows it. See [Plugins that act](#plugins-that-act). |

Give a plugin only what its README says it needs. Adding the same name again replaces its entry, so that is also how you change an option.

```sh
pnpm mailopus plugin list
pnpm mailopus plugin remove gotmail
```

Removing a plugin stops the events at once. Its binding stays in `wrangler.jsonc` and its Worker stays deployed. Take the binding out and deploy before you delete the plugin's Worker, or your next deploy fails.

Until the binding is deployed, your server finds no plugin behind the name and carries on without it. Mail is not held up.

### A plugin somewhere else

A plugin that can't live in your account can be reached over https with a key:

```sh
pnpm mailopus plugin add gotmail https://mailopus-gotmail.<your subdomain>.workers.dev
```

It prints a key. Set that key on the plugin as the secret its README names. No binding and no deploy of your server are needed.

Prefer the binding. Over https the plugin has a public address guarded by one key, that key sits in your database in plain text so the command line can use it, and message data leaves your account for wherever the URL points. Use this only for a plugin you run and trust.

## Test a plugin

```sh
pnpm mailopus plugin test gotmail
```

This sends the plugin a made-up received message and prints its answer. No mail is stored or sent. Shape the message to match what you're testing:

```sh
pnpm mailopus plugin test gotmail receive --from thedude72@gmail.com --subject "The rug"
pnpm mailopus plugin test gotmail send --to hr@corpo.example
```

The event carries `"test": true`, so a plugin can tell it from real mail.

## Run a plugin's commands

```sh
pnpm mailopus with gotmail help
pnpm mailopus with gotmail once receive --from thedude72 slack
```

Everything after the plugin's name goes to the plugin as you typed it. Each plugin defines its own commands, and `help` is the convention for listing them. Put `-c <file>` before `with`.

### How the command line reaches a bound plugin

A bound plugin has no address, so `with` and `plugin test` go through your server, which passes them over the binding. To prove the call is yours, the command line first writes a random token's hash into your database, which takes your Cloudflare login. Your server accepts that token for five minutes. This is the same root of trust as `pnpm mailopus invite`: whoever holds the cloud account is the admin.

The command line finds your server through your domain's `_mailopus` TXT record. If that record isn't there, name the server before the command:

```sh
pnpm mailopus --server https://mailopus.<your subdomain>.workers.dev with gotmail list
```

`MAILOPUS_SERVER` does the same.

## What a plugin sees

| `--wants` | The plugin gets |
|---|---|
| `envelope` | From, To, Cc, subject, Message-ID, date, and for received mail the delivery address and whether it went to Junk |
| `headers` | The envelope and the full header block |
| `body` | The envelope, the headers and the plain text of the message |

No plugin gets attachments or the raw message. The default is `envelope`, and the body leaves your server only for a plugin you added with `--wants body`.

## Plugins that act

Without `--act` a plugin only watches. Your server tells it after a received message is stored and after a send goes out, and ignores what it answers.

With `--act` the server asks the plugin first and waits up to 1.5 seconds:

- **On receive**, the plugin can send the message to Junk or set keywords such as `$seen` (read) and `$flagged` (starred). A message a plugin junked shows `plugin:<name>` as its reason in `pnpm mailopus junk <address>`.
- **On send**, the plugin can stop the message. Nobody receives it, and the app shows the plugin's reason as the send error. A scheduled send that a plugin stops goes back to Drafts.

A plugin can never lose mail. If it's slow, down, or answers with something the server doesn't understand, the server carries on as if it had said nothing: received mail is delivered and sends go out. Don't use a plugin as the only guard on something that must never be sent.

Plugins that act are asked one after another in the order you added them, so each one can add up to 1.5 seconds to a delivery or a send.

## Write a plugin

A plugin is a Worker that answers two `POST` requests. Export a `WorkerEntrypoint` class named `Plugin` with a `fetch` method. Your server's binding names that entrypoint, and only a Worker you bound in your own account can call it, so it checks no key:

```ts
import { WorkerEntrypoint } from "cloudflare:workers";

export class Plugin extends WorkerEntrypoint<Env> {
	override fetch(request: Request): Promise<Response> {
		return handle(request, this.env);
	}
}
```

Set `"workers_dev": false` in the plugin's `wrangler.jsonc` and give it no route, so it has no public address at all.

A plugin meant to be reached over https serves the same two requests from its default `fetch` handler instead. It gets `Authorization: Bearer <key>` and must answer `401` to anything else.

### `POST /v1/event`

Your server sends this for each message:

```json
{
  "event": "receive",
  "account": "<account id>",
  "message": {
    "from": { "name": "The Dude", "email": "thedude72@gmail.com" },
    "to": ["sam@example.com"],
    "cc": [],
    "subject": "The rug",
    "messageId": "<abc@mail.gmail.com>",
    "date": 1794268800000,
    "rcpt": "sam@example.com",
    "junk": false
  },
  "headers": "...",
  "body": "..."
}
```

| Field | Meaning |
|---|---|
| `event` | `receive` or `send` |
| `account` | The id of the Mailopus account the message belongs to |
| `message.date` | The Date header in milliseconds since 1970, or `null` |
| `message.rcpt`, `message.junk` | Received mail only: the address it was delivered to, and whether it went to Junk |
| `headers` | Only with `--wants headers` or `body`. Unfolded, one header per line. |
| `body` | Only with `--wants body`. Plain text, capped at 100,000 characters. |
| `test` | `true` when it came from `mailopus plugin test` |

A send is one event with every recipient in `message.to`, Bcc included.

Answer `2xx` with a JSON object. A watching plugin can answer `{}`. A plugin that acts answers with what to do:

| Event | Answer | Effect |
|---|---|---|
| `receive` | `{"junk": true}` | Files the message in Junk |
| `receive` | `{"keywords": ["$seen"]}` | Sets up to 8 keywords on the message |
| `send` | `{"block": "<reason>"}` | Stops the send and shows the reason |

Anything else in the answer is ignored, so a plugin may add fields of its own. `plugin test` prints them.

### `POST /v1/command`

`mailopus with <plugin> <words>` sends the words as typed:

```json
{ "args": ["once", "receive", "--from=thedude72", "slack"] }
```

Answer with JSON:

| Field | Effect on the command line |
|---|---|
| `text` | Printed |
| `sound` | Plays a sound on the machine running the command. `true` plays a default one, and a string is a file path on that machine. |
| `again` | Runs the same command again after this many seconds. This is how a command such as gotmail's `listen` keeps waiting. |

A status other than `2xx` prints `text` and makes the command fail, so use `400` for a command the plugin can't parse.

### Start from the example

Copy [`examples/gotmail`](../examples/gotmail/README.md). Its `src/index.ts` has the bound entrypoint and the keyed public handler, `src/app.ts` has both endpoints, and its tests run the whole plugin without a network. A plugin keeps its own data in its own storage. Your Mailopus database is not shared with it.
