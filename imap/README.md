# Mailopus IMAP and SMTP proxy

Lets ordinary desktop and phone mail apps use Mailopus. Clients speak IMAP on 993 and SMTP submission on 465 or 587. The proxy speaks JMAP over HTTPS to Mailopus. It keeps no database: mail, flags and IMAP UIDs live in Mailopus.

## Setting it up

[docs/proxy.md](../docs/proxy.md) covers running it on your own server, DNS, certificates, app passwords and setting up mail apps. One proxy serves one Mailopus server, set by `MAILOPUS_URL`.

Each app signs in with its own app password from Mailopus Settings > App passwords, and your email address as the user name. A wrong password 5 times in 15 minutes locks that IP out for 15 minutes.

## Run it locally

```sh
cp .env.example .env    # set MAILOPUS_URL to your Worker; TLS_MODE=self-signed
docker compose up --build
```

Then point a client at `localhost`, port 1993 (IMAP) and 1465 or 1587 (SMTP), and accept the self-signed certificate. A quick check with curl:

```sh
curl -k --url imaps://localhost:1993/INBOX -u 'you@example.com:<app password>' -X 'STATUS INBOX (MESSAGES UNSEEN)'
```

The proxy needs a Mailopus server with the IMAP capability (migration 0022 or later). Against an older server, login fails with a log line saying so.

## Tests

```sh
go test ./...
```

`unit_test.go` covers the UID index (new mail, moves, expunges, a message moved out and back, replays), flag mapping and the lockout. `proxy_test.go` runs a real IMAP and SMTP client against the proxy and a fake Mailopus: login and lockout, LIST, SELECT, FETCH, STORE, MOVE, EXPUNGE, APPEND, IDLE, submission, and a check that logs never hold the password or message content. The Mailopus side has its own tests in `tests/imap.test.ts` (`pnpm test` from the repo root).

## What's not there yet

- CONDSTORE. go-imap's server side doesn't implement it. Clients resync flags without it.
- Creating, renaming or deleting folders from a client. The proxy refuses CREATE, RENAME and DELETE.
- SENTSINCE and SENTBEFORE search on the received date, not the Date header.

## Deploying

- [deploy/cloud.md](deploy/cloud.md): DigitalOcean and AWS, with rough costs.
