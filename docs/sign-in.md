# Sign-in and discovery

You sign in at app.mailopus.net, but your account lives on your own Worker. This page explains how the UI finds your Worker, where your passkey and session live, and what mailopus.net can and can't see.

## Finding your Worker

When you type `sam@example.com` on the sign-in page, the browser:

1. takes the domain, `example.com`
2. asks Cloudflare's public DNS-over-HTTPS resolver, `cloudflare-dns.com`, for the TXT record at `_mailopus.example.com`
3. uses the first answer that parses as an `https://` URL, keeping only its origin

That origin is your Worker. Every call after that goes from your browser straight to it. The code is `lookup` in the UI's `public/auth/backend.js`.

With no usable record, the page falls back to app.mailopus.net itself. Your passkey isn't there, so sign-in fails with "Sign-in failed."

The claim page does the same lookup. It also takes the Worker in the link's fragment, which helps while DNS is still spreading:

```
https://app.mailopus.net/auth/claim#server=https://mailopus.<your subdomain>.workers.dev
```

## Passkeys

Mailopus has no passwords for the web UI. You sign in with a passkey.

- The passkey ceremony runs on app.mailopus.net with relying party id `mailopus.net`. That's what `APP_ORIGIN` and `RP_ID` in `wrangler.jsonc` say, and the two go together.
- Your Worker stores the passkey's public key and checks each sign-in against it. mailopus.net stores nothing.
- Passkeys are discoverable, so the sign-in page doesn't send your address to the Worker. It only uses the address to find the Worker.
- Your device has to unlock the passkey with a fingerprint, face or PIN. Mailopus requires user verification on every sign-in, and a passkey that skips it is refused.

Because the passkey is bound to `mailopus.net`, it works only through app.mailopus.net. If you change `APP_ORIGIN` and `RP_ID` to serve the UI from somewhere else, your existing passkeys stop working there, and you need a new one through an invite link, as described below.

## One passkey, many servers

Every Mailopus server uses the same relying party id, `mailopus.net`, so one passkey can sign for any of them. Left alone, that allows a relay. An attacker runs their own server and publishes a `_mailopus` TXT record for their domain. They get you to sign in with an address at that domain. Their server then fetches a challenge from your server and passes it to the sign-in page as its own. Your browser offers your passkey, and the attacker replays the signed answer on your server to get a session.

To stop that, each server writes its own origin into every challenge it issues: `mailopus1 https://mail.example.com <random>`. The sign-in, invite, claim and recovery pages decode the challenge before asking for your passkey. If it names a server other than the one the page found, the page stops and shows "Refused: ... handed over a sign-in meant for ...". The code is `boundChallenge` in `server/lib/challenge.ts` and `checkChallenge` in the UI's `public/auth/backend.js`.

Your server can't do this check alone. The signed answer only says the ceremony ran on app.mailopus.net. Only the page knows which server it was talking to.

The other fix would be a relying party id per server. That breaks the shared sign-in page at app.mailopus.net, because a passkey for `mail.example.com` can't be used from `mailopus.net`. Every existing passkey would also stop working.

A server that predates this issues challenges without the `mailopus1` tag. The pages still accept those, so such a server keeps working, but it isn't protected until you update it. Existing passkeys don't change.

## Sessions

A successful sign-in starts a 30-day session on your Worker.

- At app.mailopus.net, which is a different origin from your Worker, the session is a bearer token. The browser keeps it in the Cache API and in localStorage, so the app's service worker can use it too. Safari drops cookies on cross-site requests, which is why it isn't a cookie.
- WebSockets can't carry headers, so the live connection at `/jmap/ws` offers the token as a WebSocket subprotocol.
- Where the UI and the Worker share an origin, as on app.mailopus.net's own server, the session is a `__Host-` cookie instead.

Settings > Account > **Sign out** ends the session on the Worker and clears the token from the browser.

Settings > Account > **Signed-in devices** lists every session: the browser, when it signed in and when it was last active. **Sign out** on a row ends that one, and **Sign out everywhere else** ends all but the one you're using. Either closes that device's live connection at once. Its next request is refused within a minute.

### Asking for your passkey again

A session token can read and send mail for its 30 days. It can't give itself anything that lasts longer. Adding or removing a passkey, creating an app password, generating recovery codes, signing out everywhere else, adding or removing an address and changing a catch-all each need a passkey check on that session in the last five minutes. Signing in counts. After that the app asks for your passkey once and carries on. A token copied off a device has no passkey, so it stops there.

## What the gate checks

Every request to your Worker passes `server/lib/gate.ts` first.

- `/api/*`, `/jmap/*` and `/.well-known/jmap` need a valid session, or on JMAP paths an [app password](proxy.md#app-passwords).
- Writes and WebSockets must come from `APP_ORIGIN`. Requests from other sites are refused with 403.
- Cross-origin calls get CORS headers only when their `Origin` is `APP_ORIGIN`.
- Sign-in, invite, claim and recovery endpoints are open, but each IP gets 20 requests a minute, set by `AUTH_LIMIT`. Past that the Worker answers 429 and the page says "Too many attempts. Wait a minute." Recovery attempts also count per address typed, 20 a minute, whichever IPs they come from.
- Your Worker serves no UI. A browser that opens one of its pages goes to `APP_ORIGIN`.
- Every response gets `noindex` and no-frame headers.

app.mailopus.net shows anonymous visitors a landing page instead of the app. The app loads only for browsers that carry a session cookie or the `mailopus_pass` cookie the sign-in pages set. That cookie isn't a credential. It keeps crawlers off the app bundle. The real checks are on your Worker.

## What mailopus.net sees

- It serves the HTML and JavaScript of the UI.
- It never sees your mail, your session token or your passkey's private key. Your browser sends those to your Worker only.
- The DNS lookup goes to Cloudflare's public resolver, not to mailopus.net.
- It serves the code your browser runs, and that code holds your session token. A changed UI could act on your server like you can. The UI's source is in this repository.
- If you opt in to the hosted spam rules, your Worker sends each inbound message's header block to spam.mailopus.net. See [Spam](spam.md).
- A search puts its words in the page address (`?q=`). Reloading a search page, or opening one in a new tab, asks mailopus.net for that address, so the words reach its request log.
- Images in mail and attachment downloads are fetched by your Worker. The app's service worker sends those requests there. On the first load after sign-in, before the service worker has taken over, a request for an image or a download can reach mailopus.net instead, carrying the image's address or the file's name and no token. mailopus.net refuses it.

Your Worker's logs are in your own cloud account. Cloudflare hides cookies and tokens in them. The app's live connection has to name itself in a WebSocket header that the logs keep in clear, so it sends a ticket there that works once, for a minute, and only opens that connection. A server from before that (API level 4 or older) is sent the session token in that header instead, so update it.

Your own Worker also talks to two outside services: it fetches remote images in mail on your behalf, and it asks gravatar.com for a picture using a SHA-256 hash of each of your addresses.

## Add a passkey or another device

Passkeys saved to iCloud Keychain or Google Password Manager sync to your other devices on their own. Settings > Account > **Passkeys** lists the ones your server knows, with when each was added and last used, and whether it is synced or lives on one device.

For a separate passkey, such as a security key or a device outside that sync, open Settings > Account > **Passkeys** in a browser where you're signed in, type a name if you want one, and choose **Add a passkey**. The browser offers to make it on that device, on a security key, or on a phone through a QR code. To set up a device that has no passkey yet, sign in there with your phone's passkey through the same QR code, then add one in Settings.

Keep two if you can. With a single passkey that isn't synced, Settings warns you, because losing that device locks you out. **Remove** deletes a passkey from your server, and the last one can't be removed. Removing a passkey doesn't sign out the devices that used it, so sign those out under **Signed-in devices** too.

If you can't sign in anywhere, or you serve the UI from a new `APP_ORIGIN`, make an invite link from your clone instead:

```sh
pnpm mailopus invite sam@example.com
```

It prints a one-time link valid for 24 hours. The command finds your Worker through the `_mailopus` TXT record of the address's domain and adds it to the link, so the invite goes to your server:

```
https://app.mailopus.net/auth/invite#token=...&server=https://mailopus.<your subdomain>.workers.dev
```

Open it on the new device and create the passkey. The link works once. `--hours` changes how long it lasts, and `--url` changes the base URL. If the domain has no TXT record, the command says so. Add `--server https://mailopus.<your subdomain>.workers.dev` and run it again.

To add a new person, run it with their name in `NAME`, as in [Other people on your server](addresses.md#other-people-on-your-server).

## Authenticator code

Settings > Account > Authenticator code adds a second step to signing in: after the passkey, a 6-digit code from an authenticator app. It's off unless you turn it on, and it's per person.

- It matters when your passkey syncs. Anyone who gets into the account that syncs it, such as your Apple ID, gets a working copy of the passkey. With an authenticator on, they also need the code.
- Keep the code in an app that doesn't sync through the same account as your passkeys. Apple's Passwords app keeps both in iCloud Keychain, so it adds nothing there. 1Password, Authy or Google Authenticator do.
- Turning it on or off asks for your passkey first. Turning it on also needs a code from the app, so a mistyped setup can't lock you out.
- Each code works once, and a code from one step either side of now is accepted, for clocks that drift.
- A recovery code skips it. That's the way back in if you lose the app, after which you can turn it off.
- Mail apps that use app passwords aren't asked for a code. They can't show the prompt.

## Recovery codes

Settings > Account > **Recovery codes** makes ten one-time codes for the day no passkey works. **Generate new codes** asks for your passkey, then shows the codes once. Copy them or write them down, and keep them away from the device that holds your passkey. A password manager on that same device is lost along with it.

- A code looks like `K7QM-2XHD-9TLP-B4WN`: 16 letters and digits, 80 random bits. Case, spaces and dashes don't matter when you type it.
- Your server stores only a SHA-256 hash of each code.
- Each code works once. Settings shows how many are left.
- Generating again replaces the whole set. The old codes stop working at once.
- Codes belong to one server. If you have accounts on two servers, each has its own set.

A code never signs you in. With your address it lets you create one new passkey, and the session comes from that passkey.

## Lost every passkey

Start with a recovery code, if you made them.

1. Open the sign-in page and choose **Lost your passkey?**
2. Type your email address and one recovery code.
3. Choose **Create passkey**. The page names the mail server it found for your address before your device asks.

You're signed in with the new passkey, and that code is spent. The page gives the same answer for a wrong code and an unknown address, so it tells a stranger nothing about who has an account.

With no codes left, make an invite link with `pnpm mailopus invite`, as in [Add a passkey or another device](#add-a-passkey-or-another-device). It needs only the login to your own cloud account, not a Mailopus sign-in. That makes your cloud account the last way in, so its own two-factor sign-in is what guards the invite path. Use a passkey or security key there too. Other people on your server can't run the script. They need their own codes, or an invite from you.

Once you're back in, remove the lost passkeys in Settings, sign out the devices you no longer have, and generate new recovery codes.
