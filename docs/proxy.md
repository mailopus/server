# Mail apps and the IMAP proxy

Mailopus speaks JMAP. Most desktop and phone mail apps speak IMAP and SMTP. The proxy in `imap/` sits between them. Clients connect to it on the usual ports, and it talks JMAP over HTTPS to your Worker. It keeps no database. Mail, flags and IMAP UIDs all live in Mailopus, so you can rebuild or move the proxy at any time.

Workers can't accept raw TCP connections, so the proxy has to run on a machine you control. Each proxy talks to exactly one Mailopus server, set by `MAILOPUS_URL`. The proxy app.mailopus.net uses serves only that server and can't reach yours, so run your own copy. That also keeps your app passwords and mail off machines you don't control.

## What it supports

| Protocol | Port | Security |
|---|---|---|
| IMAP | 993 | SSL/TLS |
| IMAP | 143 | STARTTLS |
| SMTP submission | 465 | SSL/TLS |
| SMTP submission | 587 | STARTTLS |

On the plain ports, sign-in stays off until STARTTLS is up.

Not there yet:

- CONDSTORE. Clients resync flags without it, which costs more traffic on big mailboxes.
- Creating, renaming or deleting folders from a mail app. The proxy refuses all three. Mailopus can rename and delete labels over JMAP, but the proxy doesn't pass that through, and no one can create a folder yet.
- SENTSINCE and SENTBEFORE searches use the received date, not the Date header.

Limits:

- Messages up to 25 MiB, the same as Email Routing.
- 50 recipients per message.
- 20 connections per IP.
- 5 failed sign-ins in 15 minutes lock that IP out for 15 minutes. Your Worker separately allows 20 failed app-password attempts a minute per username.

## App passwords

Each mail app signs in with its own app password, made in Settings > Account > App passwords. The username is your email address.

1. Type a name, such as "Phone".
2. Pick which mail it can see. **All mail**, or **Only** one address or one address group.
3. Pick when it expires: never, in 90 days or in 1 year. Your Worker refuses an expired password, and the list keeps showing it as expired until you revoke it.
4. Press **Create** and copy the password. It's 32 letters and digits, and Settings shows it only once.

One app password per app means you can revoke one without touching the others. The list shows when each was made and last used, the network it was last used from, and when it expires. **Revoke** stops it at once. A revoked password can keep working for up to a minute on a Worker instance that cached it.

The network is the first part of the mail app's IP address, such as `203.0.113.0/24`, or a `/48` for IPv6. Your Worker never stores the full address. The proxy passes the mail app's address along with each request, and your Worker accepts it only next to a valid app password. A network you don't recognize is a reason to revoke that password. It isn't proof of anything by itself: whoever holds the password can send any address they like. The network updates about once a minute while the password is in use, not on every request.

A password limited to some addresses:

- sees only mail sent to those addresses
- sends only as identities among them
- can't change folders or identities

App passwords work on the JMAP paths only, `/jmap/*` and `/.well-known/jmap`. They can't reach `/api/*`, so they can't make or revoke app passwords or touch passkeys.

The username can be any address the account sends as or receives, including one at a catch-all domain.

## Run the proxy

You need a small Linux server with a public IPv4 address, Docker, and DNS names for it. A 1 GB VPS is plenty. The proxy's container is capped at 256 MB. [imap/deploy/cloud.md](../imap/deploy/cloud.md) compares DigitalOcean and AWS.

### 1. DNS

Add two A records, for example `imap.example.com` and `smtp.example.com`, pointing at the server. Set them to **DNS only**, the grey cloud. Cloudflare's proxy doesn't carry mail ports.

### 2. A token for certificates

The proxy gets Let's Encrypt certificates by DNS-01 through Cloudflare. In the dashboard, under My Profile > API Tokens, create a token with **Zone > DNS > Edit** on your zone and nothing else. That token can change any DNS record in the zone, including your mail routing, and it sits on a machine that faces the internet. To limit what a break-in there could do, point `_acme-challenge.imap` and `_acme-challenge.smtp` at a spare zone with CNAME records and give the proxy a token for that zone only, or use `TLS_MODE=files` with a certificate you renew elsewhere. You'll paste it into the server's `.env` in the next step. Don't commit it.

### 3. Configure

On the server:

```sh
git clone https://github.com/mailopus/server.git mailopus
```

```sh
cd mailopus/imap && cp .env.example .env
```

Edit `.env`. The example file uses placeholder names and a self-signed certificate, so change these:

```sh
MAILOPUS_URL=https://mailopus.<your subdomain>.workers.dev
TLS_MODE=acme
TLS_HOSTNAMES=imap.example.com,smtp.example.com
SMTP_HOSTNAME=smtp.example.com
CF_API_TOKEN=<the token from step 2>
ACME_EMAIL=you@example.com
IMAP_BIND=0.0.0.0
IMAP_PORT=993
IMAP_STARTTLS_PORT=143
SMTPS_PORT=465
SUBMISSION_PORT=587
```

| Variable | Meaning |
|---|---|
| `MAILOPUS_URL` | Your Worker's origin. One proxy serves one Mailopus server. |
| `TLS_MODE` | `acme` for Let's Encrypt, `files` for your own certificate, `self-signed` for testing |
| `TLS_HOSTNAMES` | Names on the certificate, comma-separated |
| `SMTP_HOSTNAME` | The name SMTP announces in its greeting |
| `CF_API_TOKEN` | `acme` only. The DNS token. |
| `ACME_EMAIL` | `acme` only, optional. Let's Encrypt's expiry notices go here. |
| `ACME_CHALLENGE_DOMAIN` | `acme` only, optional. Writes the DNS challenge to this name instead, for a hostname in a zone the token can't edit. Point `_acme-challenge.<hostname>` at it with a CNAME. |
| `ACME_CA` | `acme` only, optional. Defaults to Let's Encrypt. Set `https://acme-staging-v02.api.letsencrypt.org/directory` to try a new setup without using up the real rate limits. |
| `TLS_CERT`, `TLS_KEY` | `files` only. Paths inside the container, for example under `/data/certs`. |
| `IMAP_BIND` | The host address the ports listen on. `127.0.0.1` by default, so set `0.0.0.0` on a server. |
| `IMAP_PORT`, `IMAP_STARTTLS_PORT`, `SMTPS_PORT`, `SUBMISSION_PORT` | Host ports. They default to 1993, 1143, 1465 and 1587 so a laptop needs no root. |

Certificates are kept in the `certs` Docker volume and renewed on their own.

### 4. Start it

```sh
docker compose up -d --build
```

Open 993, 143, 465 and 587 in the server's firewall. Docker's published ports bypass ufw, so the port list in `compose.yaml` and `.env` is what really decides.

Check the logs:

```sh
docker compose logs --tail 100
```

They're JSON lines and never hold passwords or message content.

### 5. Show the hosts in Settings

Add the hostnames to `vars` in `wrangler.jsonc`:

```jsonc
"vars": {
	"APP_ORIGIN": "https://app.mailopus.net",
	"RP_ID": "mailopus.net",
	"IMAP_HOST": "imap.example.com",
	"SMTP_HOST": "smtp.example.com"
}
```

Deploy again. Settings > App passwords then shows the servers and ports next to each new password. Without `IMAP_HOST`, Settings says the server has no IMAP proxy.

### Test it from a laptop first

```sh
cd imap && cp .env.example .env
```

Set `MAILOPUS_URL` to your Worker and leave `TLS_MODE=self-signed`. Then:

```sh
docker compose up --build
```

```sh
curl -k --url imaps://localhost:1993/INBOX -u 'sam@example.com:<app password>' -X 'STATUS INBOX (MESSAGES UNSEEN)'
```

The proxy's own tests run with `go test ./...` from `imap/`.

### Update it

```sh
git pull && docker compose up -d --build
```

## Set up mail apps

Every app uses the same settings:

| | Server | Port | Security | Username | Password |
|---|---|---|---|---|---|
| Incoming, IMAP | `imap.example.com` | 993 | SSL/TLS | your email address | the app password |
| Outgoing, SMTP | `smtp.example.com` | 465 | SSL/TLS | your email address | the app password |

Port 587 with STARTTLS works for outgoing too, if a network blocks 465.

### Apple Mail on Mac

1. Mail > Add Account. Pick **Other Mail Account**.
2. Enter your name, email address and the app password. Press **Sign In**.
3. Mail can't find the servers on its own. When it asks, set Account Type to IMAP, Incoming Mail Server to `imap.example.com` and Outgoing Mail Server to `smtp.example.com`, with your address as the username both times.
4. If it still fails, open Mail > Settings > Accounts, select the account, then Server Settings. Turn off **Automatically manage connection settings** for both servers and enter the ports and TLS from the table.

### iPhone and iPad Mail

1. Settings > Apps > Mail > Mail Accounts > Add Account > Other > Add Mail Account.
2. Enter your name, address, the app password and a description. Tap **Next**.
3. Pick **IMAP**. Fill in the incoming and outgoing host names, with your address and the app password for both.
4. Tap **Next**, then **Save**.

### Thunderbird

1. Account Settings > Account Actions > Add Mail Account.
2. Enter your name, address and the app password. Press **Configure manually**.
3. Incoming: IMAP, `imap.example.com`, port 993, SSL/TLS, Normal password.
4. Outgoing: SMTP, `smtp.example.com`, port 465, SSL/TLS, Normal password.
5. Username for both is your email address. Press **Re-test**, then **Done**.

### Outlook

The new Outlook for Windows and Outlook for Mac both add IMAP accounts:

1. Add account, then type your email address. Pick **IMAP** when Outlook asks for the provider, or open the advanced or manual settings.
2. IMAP incoming server `imap.example.com`, port 993, SSL/TLS.
3. SMTP outgoing server `smtp.example.com`, port 465, SSL/TLS.
4. Your email address as the username for both, and the app password.

Outlook menus move between versions. I haven't checked these steps against every one, so expect the labels to differ a little.

### Folders

Your mail apps see the standard mailboxes, Inbox, Drafts, Sent, Archive, Junk and Trash, plus your labels as folders. Point the app's Sent, Drafts, Junk and Trash settings at the matching folders if it doesn't pick them itself.
