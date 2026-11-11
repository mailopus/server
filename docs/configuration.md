# Configuration

Everything your server reads comes from `wrangler.jsonc`, from Worker secrets, or from rows in D1. This page lists all of it, then covers the optional features: notifications, Swiftly signatures, Gmail import, backups and the JMAP endpoint for other clients.

After editing `wrangler.jsonc`, deploy again with `pnpm run deploy`. Secrets take effect without a deploy.

## The `mailopus` command

The jobs on this page and the others that need your Cloudflare login run through one command, from your clone:

```sh
pnpm mailopus
```

On its own it lists every command. `pnpm mailopus <command> --help` explains one.

| Command | What it does |
|---|---|
| `deploy`, `migrate` | Build, migrate and deploy, or apply migrations alone |
| `invite`, `user create`, `identity add`, `identity list` | Add people and send-as addresses. See [Addresses and people](addresses.md) and [Sign-in](sign-in.md). |
| `address add`, `list`, `remove` | Which addresses receive mail, and in whose account |
| `status` | Whether the server is claimed, and what each domain's `_mailopus` record says |
| `junk <address>` | The newest Junk mail in an account, and why each message is there. See [Spam](spam.md). |
| `relay deploy` | Deploy the relay for a domain in another Cloudflare account |
| `import start`, `status`, `pause`, `resume`, `rescan` | [Gmail import](#gmail-import) |
| `secret put`, `delete`, `list` | [Secrets](#secrets) |
| `plugin add`, `list`, `remove`, `test`, and `with <plugin>` | [Plugins](plugins.md) |
| `logs` | Stream your Worker's logs |
| `sql`, `backup`, `restore` | Query, export or rewind the database. See [Backups](#backups). |
| `login`, `whoami` | Sign in to Cloudflare, or show which account you're in |

It works on the server `wrangler.jsonc` describes. To use another config file, add `-c <file>` or set `MAILOPUS_CONFIG`.

The same command is on npm, so `npx mailopus <command>` also works inside your clone. It still needs the clone, because it reads `wrangler.jsonc` and uses the `wrangler` installed there. `npx` fetches the newest version, which can be ahead of an older clone's database. `pnpm mailopus` is the copy that came with your clone and always matches it, so use that one unless you've just updated.

## Variables

Set these under `vars` in `wrangler.jsonc`.

| Variable | Default | What it does |
|---|---|---|
| `APP_ORIGIN` | `https://app.mailopus.net` | Where the UI runs. Passkey sign-ins must come from this origin, writes and WebSockets from any other origin are refused, and CORS answers only this origin. |
| `RP_ID` | `mailopus.net` | The passkey domain. It must be `APP_ORIGIN`'s host or a parent of it. Change it only together with `APP_ORIGIN`. |
| `IMAP_HOST` | unset | The IMAP proxy's hostname, shown in Settings next to app passwords. Unset means Settings says there's no proxy. See [Mail apps](proxy.md). |
| `SMTP_HOST` | unset | The SMTP hostname, shown with `IMAP_HOST`. Ignored without it. |
| `VAPID_PUBLIC_KEY` | unset | Web Push public key. Set it only together with the `VAPID_PRIVATE_KEY` secret. See [Notifications](#notifications). |
| `PURGE_TOMBSTONES_DAYS` | unset | Deleted messages leave a small marker row behind so mail apps can be told what went. Unset keeps every marker. A number deletes markers older than that many days, a few hundred rows each 5 minutes. A mail app that last synced before a purged marker fetches its folders again from scratch. `30` suits most. |

`DEV_ORIGIN` and `SWIFTLY_BASE` also exist, for local development against a dev server or a local Swiftly. Leave them unset in production.

## Secrets

Set each with `pnpm mailopus secret put <NAME>` from your clone. It asks for the value, so it stays out of your shell history. Remove one with `pnpm mailopus secret delete <NAME>`.

| Secret | What it does |
|---|---|
| `SPAM_CLASSIFIERS` | JSON list of remote spam classifiers. See [Spam](spam.md). |
| `VAPID_PRIVATE_KEY` | Web Push private key as a JWK string, paired with `VAPID_PUBLIC_KEY`. |
| `INGEST_SECRET` | Shared with the relay Worker for domains in another Cloudflare account. See [Addresses](addresses.md#domains-in-another-cloudflare-account). Without it, `/api/ingest` refuses everything. |
| `GOOGLE_SA_<NAME>` | A Google service account key, as JSON, for Gmail import. See [Gmail import](#gmail-import). |

## Bindings and the rest of `wrangler.jsonc`

| Key | Value | What it's for |
|---|---|---|
| `name` | `mailopus` | The Worker's name, and part of its workers.dev URL |
| `main` | `./.output/server/index.mjs` | The built Worker. `pnpm build` makes it. |
| `workers_dev` | `true` | Serves the Worker at `mailopus.<your subdomain>.workers.dev`. Your `_mailopus` TXT record can name that URL. |
| `preview_urls` | `false` | No per-version preview URLs |
| `ratelimits` `AUTH_LIMIT` | 20 a minute | Caps sign-in, invite and claim calls per IP, and failed app-password sign-ins per username |
| `compatibility_date`, `compatibility_flags` | `2026-11-01`, `nodejs_compat` | Workers runtime version and Node.js APIs |
| `observability` | on | Logs in the dashboard. `pnpm mailopus logs` streams them. |
| `d1_databases` `DB` | `mailopus` | Accounts, addresses, message index, sessions, passkeys, settings |
| `durable_objects` `ACCOUNT` | class `Account` | One per account. Runs every write to that account in order, holds the live WebSockets and sends scheduled mail. |
| `migrations` | `v1`, SQLite class `Account` | The Durable Object class's own migration, separate from D1's |
| `send_email` `EMAIL` | | Outbound mail through Email Sending |
| `queues` `IMPORT_QUEUE` | `mailopus-import` | Gmail import, one page per message, up to 4 at once, 10 retries |
| `triggers` `crons` | `*/5 * * * *` | Every 5 minutes: start and restart import jobs, sync Swiftly signatures, backfill old rows |
| `r2_buckets` `MAIL` | `mailopus-mail` | Each message's raw `.eml`, under `raw/<account id>/` |

The template has no `services` entry. Add one to bind a spam Worker of your own. See [Spam](spam.md#a-spam-worker-on-the-spam-binding).

## Settings in D1

Some state lives in the `instance_settings` table:

| Key | What it is |
|---|---|
| `claimed` | When the server was claimed. Its presence keeps the claim page closed. |
| `vapid` | The Web Push key pair the server made for itself |
| `swiftly-connect:<state>` | A Swiftly connection in progress, deleted after 10 minutes |

Per-account settings, such as blocked senders, address groups and highlight exclusions, live in their own tables and are edited in Settings.

## Notifications

Settings > This device > Notifications turns on a push notification for each new Inbox message, per browser. On iPhone and iPad, add Mailopus to the home screen first. Safari only allows notifications there.

Mail filed in Junk, mail you sent yourself, and imported mail never notify. The message is encrypted for your browser, so Apple's and Google's push services carry it without being able to read it.

Push needs no setup. On first use the server makes a VAPID key pair and keeps it in D1. Set `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` only to bring an existing key pair, for example when moving to a new server with existing subscriptions. Changing the keys breaks every existing subscription, so each browser has to turn notifications off and on again.

## Swiftly signatures

[Swiftly](https://swiftly.biz) keeps email signatures up to date across a team. Mailopus can let Swiftly manage an address's signature.

1. Settings > Addresses, then an address's menu > **Signature…**
2. Pick Swiftly and connect. Your browser goes to swiftly.biz to approve, then comes back.
3. Choose whether Swiftly manages this address only or all your addresses.

The connection uses an authorization code with PKCE. The Swiftly token stays on your Worker and never reaches the browser. The 5-minute cron syncs each managed address at most every 30 minutes.

While Swiftly manages a signature, the dialog shows it read-only. Swiftly refuses to sync over an edit made somewhere else. Turning Swiftly on keeps what you wrote, and Swiftly adds its own part. **Disconnect** stops the updates and leaves the signatures as they are.

## Gmail import

Mailopus can copy a Google Workspace mailbox into an account. It's built for Workspace, not personal Gmail. It reads mail through a Google service account with domain-wide delegation, which only a Workspace admin can grant. There's no UI. You drive it with `pnpm mailopus import`.

What comes over:

- Every message, as its original raw file
- Read and starred state, and drafts
- Inbox, Sent, Drafts, Spam and Trash into the matching mailboxes
- Your Gmail labels as labels

It's safe to run again. Each message is stored once per account, so a rerun skips what's already there.

### 1. Make a service account

In Google Cloud:

1. Create a project, or use one you have.
2. Enable the Gmail API.
3. Create a service account with no roles. Create a JSON key for it and download it.
4. Note the service account's numeric client ID.

### 2. Grant domain-wide delegation

As the Workspace's admin, open admin.google.com > Security > Access and data control > API controls > Manage domain-wide delegation. Add the client ID with exactly one scope:

```
https://www.googleapis.com/auth/gmail.readonly
```

This lets the key read every mailbox in the Workspace. Treat the key file like a password, and delete it after the next step.

### 3. Store the key as a secret

Pick a short name for the Workspace, such as `work`. From your clone:

```sh
pnpm mailopus secret put GOOGLE_SA_WORK < path/to/key.json
```

Then delete the downloaded key file.

### 4. Start an import

```sh
pnpm mailopus import start work sam@company.example sam@example.com
```

The arguments are the secret's name without `GOOGLE_SA_`, the Gmail address to read, and any address the target Mailopus account sends as. The 5-minute cron picks up the job, and the queue fetches 100 messages per page.

### Watch and control it

```sh
pnpm mailopus import status
```

| `pnpm mailopus import ...` | What it does |
|---|---|
| `status` | Lists jobs with progress, counts and the last error |
| `pause <job id>` | Stops after the current page |
| `resume <job id>` | Continues where it stopped |
| `rescan <job id>` | Walks the mailbox again from the start. Stored mail is skipped, so only missing messages are fetched. |

A job id prefix is enough.

When you're done, delete the secret with `pnpm mailopus secret delete GOOGLE_SA_WORK` and remove the delegation in the admin console.

## Backups

Mailopus has no backup feature of its own. Your data is in two places, and both need covering:

- **D1** holds accounts, addresses, the message index, flags, mailboxes, sessions and passkeys.
- **R2** holds each message's raw file.

The Account Durable Objects hold only scheduling state, nothing you'd need to restore.

### D1

D1 Time Travel keeps a restore point for every minute of the last 30 days on Workers Paid. To undo a mistake, first see what can be restored:

```sh
pnpm mailopus restore
```

Then rewind to a moment before the mistake:

```sh
pnpm mailopus restore --timestamp <unix time or RFC 3339>
```

A restore replaces the whole database. For a copy outside Cloudflare, export it to a file on a schedule:

```sh
pnpm mailopus backup
```

It writes `mailopus-<today>.sql` in the current directory. Pass a file name to choose another.

### R2

R2 keeps no versions of its own. To copy the bucket somewhere else, make an R2 API token with read access in the dashboard under R2 > Manage API tokens, then use any S3 tool. With rclone set up for R2 as a remote called `r2`:

```sh
rclone sync r2:mailopus-mail /path/to/backup/mailopus-mail
```

Each file is a standard `.eml` that any mail program opens. Together with a D1 export, that's a full copy of your mail.

## JMAP for other clients

Mailopus speaks JMAP, the core of RFC 8620 and the mail methods of RFC 8621 listed below, so a JMAP client can use it directly with no proxy.

| | |
|---|---|
| Session | `https://<your worker>/.well-known/jmap`, also at `/jmap/session` |
| API | `/jmap/api` |
| Upload | `/jmap/upload/{accountId}/` |
| Download | `/jmap/download/{accountId}/{blobId}/{name}` |
| Push | WebSocket at `wss://<your worker>/jmap/ws` (RFC 8887), announced in the session as `urn:ietf:params:jmap:websocket` |
| Auth | HTTP Basic with your email address and an [app password](proxy.md#app-passwords) |

Methods: `Mailbox/get`, `Mailbox/changes`, `Mailbox/set`, `Thread/get`, `Email/get`, `Email/query`, `Email/changes`, `Email/set`, `Email/import`, `Identity/get`, `Identity/set`, `EmailSubmission/get` and `EmailSubmission/set`.

Push works the RFC 8887 way. Open the WebSocket with the `jmap` subprotocol and the same Basic credentials, send `{"@type":"WebSocketPushEnable"}`, and a `StateChange` arrives after every change to any of your accounts: new mail, a flag, a move, a send. It names `Email`, `Mailbox` and `Thread` with the account's current state and ignores `dataTypes`. The socket also answers `Request` messages like `/jmap/api` does. Send the text `ping` to keep it open; the server answers `pong`.

Limits: 25 MB per upload, 10 MB per request, 32 calls per request, 500 objects per get or set, 4 concurrent requests.

What's missing or partial:

- There's no EventSource push. The session still lists an `eventSourceUrl` because RFC 8620 requires the field, but `/jmap/eventsource` returns 404. A client that only knows EventSource gets no push.
- A request sent over the WebSocket can be at most 1 MiB, Cloudflare's message limit.
- `Mailbox/set` creates, renames and destroys labels. A label's name uses `/` for nesting and `parentId` is always null. The standard mailboxes can't be created, renamed or destroyed.
- `Mailbox/query`, `Email/queryChanges`, `Thread/changes`, `SearchSnippet/get` and `VacationResponse` aren't there. `Email/query` answers `canCalculateChanges: false`, so a client refetches the list when the state changes.
- Calendars and contacts aren't there.

Browsers can't call the API from another site. CORS answers only `APP_ORIGIN`. Native and server-side clients aren't affected.
