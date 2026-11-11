# mailopus

The command line for a [Mailopus](https://mailopus.net) server: deploy it, invite people, add addresses, run Gmail imports, manage secrets and plugins, and query or back up the database.

Run it inside a clone of your Mailopus server. It reads that folder's `wrangler.jsonc` and uses the `wrangler` installed there, with your Cloudflare login.

```sh
npx mailopus                 # lists every command
npx mailopus invite sam@example.com
npx mailopus import status
npx mailopus with gotmail once receive --from thedude72 slack
```

`npx mailopus <command> --help` explains one command. `-c <file>` or `MAILOPUS_CONFIG` picks another wrangler config.

Your clone also carries this command at its own version, as `pnpm mailopus`. Prefer that one after an update, because it always matches your server's database schema.

Needs Node.js 22.18 or later. Documentation is at [docs.mailopus.net](https://docs.mailopus.net).
