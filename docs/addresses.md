# Addresses and domains

Each address in Mailopus can do two things. It can send, which means it's a send-as identity with a display name. And it can receive, which means the Worker has a route for it in D1. Most addresses do both. Settings > Addresses lists them by domain and shows which each one does.

## How the Worker picks an account

Email Routing hands the Worker every message for the domain. The Worker looks for a route for the recipient in this order and takes the first it finds:

1. the exact address, `sam+news@example.com`
2. the same address without its `+tag`, `sam@example.com`
3. the domain's catch-all route, `*@example.com`

No match means the Worker refuses the message at SMTP time with `Address not found`. The sender gets a bounce. The code is `routeCandidates` in `server/lib/ingest.ts`.

An address belongs to one account. Adding an address that another account on your server already receives fails with "belongs to another Mailopus account".

The person who claimed the server is its admin. Only the admin adds or removes addresses, sets catch-alls and invites people. Everyone else sees their own addresses in Settings and can rename them, set signatures and turn receiving on or off. On a server claimed before migration 0031, the earliest user is the admin.

## Add an address

As the admin, open the domain in Settings > Addresses. Type the part before the `@` and the name to send as, then press **Add**. The new address sends and receives right away. No DNS change is needed, since Email Routing's catch-all already sends every address at the domain to the Worker.

Each address's menu has:

- **Rename…** changes the name people see when you send.
- **Signature…** sets the signature, written by you or kept up to date by [Swiftly](configuration.md#swiftly-signatures).
- **Stop receiving** removes its route, so new mail to it is refused. You can still send as it.
- **Receive mail** adds a route back.
- **Remove…** (admin only) stops sending and receiving. Mail already in your account stays. Mailopus won't remove the last address you send as, or one with scheduled sends waiting.

On a domain with the catch-all on, **Stop receiving** and **Remove…** don't stop mail, because the catch-all still takes it. Settings says so on that domain.

## Plus aliases

Mail to `sam+anything@example.com` reaches the account that receives `sam@example.com`. There's nothing to set up. Use a different tag per site, and filter or block by tag later. If you add `sam+news@example.com` as an address of its own, its exact route wins over the plain one.

## Send-only and receive-only addresses

**Send-only.** Add the address, then pick **Stop receiving** from its menu.

**Receive-only.** Settings can't make one yet. Add it from your clone:

```sh
pnpm mailopus address add orders@example.com sam@example.com
```

The first address is the one to receive on. The second is any address the account already sends as, which picks the account. `pnpm mailopus address list` shows every address that receives mail, and `pnpm mailopus address remove orders@example.com` takes one away.

## The catch-all route

A new server has no catch-all. Claiming routes only the address you claimed with, so mail to any address you haven't added bounces, apart from `+` aliases of the ones you have.

If you make up addresses as you go, turn on a catch-all for the domain. As the admin, open the domain in Settings > Addresses and pick an account under **Catch-all**. Every unrouted address at that domain then lands in that account. Typos and dictionary spam get in too. Pick the blank entry to turn it off again. Addresses with their own route keep working either way.

Each domain has at most one catch-all, so on a domain shared by several people, unknown addresses go to the one account you pick.

## More domains

Settings adds addresses only on domains your account already has. A new domain needs Cloudflare set up first, then one command to add its first address.

1. Add the domain's zone to the same Cloudflare account as the Worker.
2. Email Routing for the new domain, with the catch-all set to **Send to a Worker** and `mailopus`, as in [setup step 3](setup.md#3-turn-on-email-routing).
3. Email Sending for the new domain, as in [setup step 4](setup.md#4-turn-on-email-sending).
4. If you'll ever sign in with an address at this domain, add its own `_mailopus` TXT record as in [setup step 2](setup.md#2-add-the-_mailopus-txt-record). Sign-in looks up the domain of the address you type, so a domain you only send and receive on doesn't need one.
5. Add the first address from your clone:

   ```sh
   pnpm mailopus identity add sam@example.com "Sam" sam@second.example sam@second.example
   ```

   The arguments are an address you already send as, which picks the account, then the name, the new address, and the routes to add. Pass `'*@second.example'` as the route instead to take every address at the new domain. Leave the routes out for a send-only address.

   The command works on the `DB` binding in `wrangler.jsonc`, your server's database, with your Cloudflare login.

After that the domain shows in Settings > Addresses and takes new addresses there.

## Domains in another Cloudflare account

Email Routing can only deliver to a Worker in the zone's own account. For a zone you can't move, the repo has a relay Worker in `relay/`. It receives the mail in the zone's account, signs each message with HMAC-SHA256 and POSTs it to your Worker's `/api/ingest`. Your Worker checks the signature and a timestamp no older than 5 minutes, then delivers it like any other message. An unknown recipient gets a 404, and the relay refuses the message at SMTP.

To use it:

1. Make a secret, for example with `openssl rand -base64 32`. Keep it out of shell history and logs.
2. Set it on your Worker as `INGEST_SECRET`. From your clone, run `pnpm mailopus secret put INGEST_SECRET` and paste it at the prompt.
3. Edit `relay/wrangler.jsonc` and set `MAILOPUS_INGEST_URL` to your Worker's address, `https://mailopus.<your subdomain>.workers.dev/api/ingest`.
4. Deploy it into the account that holds the zone with `CLOUDFLARE_ACCOUNT_ID=<that account id> pnpm mailopus relay deploy`, then set the same secret on it with `CLOUDFLARE_ACCOUNT_ID=<that account id> pnpm mailopus secret put INGEST_SECRET -c relay/wrangler.jsonc`.
5. In the other account, point the zone's Email Routing catch-all at `mailopus-relay`.

Sending as that domain still needs Email Sending in the account that runs your Mailopus Worker. Cloudflare may require the zone to be in that account for that. The relay covers inbound mail only.

## Other people on your server

Your server can hold more than one person, on the same domain or different ones. Each gets their own account, mailboxes, passkey and addresses. There's no UI for this yet. As the admin, from your clone:

```sh
pnpm mailopus invite alex@example.com --name "Alex"
```

That creates Alex's user and account, routes `alex@example.com` to it, and prints a one-time sign-in link valid for 24 hours. The link already names your Worker. Alex gets `+` aliases on their address automatically. Any more addresses for Alex, you add from Settings.
