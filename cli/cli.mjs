// The mailopus command: the admin jobs that need your cloud login. Run it from your clone, where
// `pnpm mailopus <command>` finds wrangler and the config. docs/configuration.md lists the commands.
//
// Which server: the one wrangler.jsonc describes, through its DB binding and Worker name. Another
// config: -c <file> anywhere on the line, or MAILOPUS_CONFIG.
//
// Writes go through `wrangler d1 execute --json` and count meta.changes, because a write can exit 0
// without changing a row.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

// The commands that build rows share code with the Worker, in TypeScript. They import it when they run,
// so `deploy` still works on a Node.js too old to strip types (the Deploy to Cloudflare build).
const provisionLib = () => import("../server/lib/provision.ts");
const inviteLib = () => import("../server/lib/invite.ts");

let config;
// --server or MAILOPUS_SERVER: your Worker's URL, when the _mailopus TXT record can't supply it.
let server;
const wrangler = (args, opts) => execFileSync("npx", ["wrangler", ...args, ...(config ? ["-c", config] : [])], opts);
const run = (...args) => wrangler(args, { stdio: "inherit" });
const d1 = (sql) => JSON.parse(wrangler(["d1", "execute", "DB", "--remote", "--json", "--command", sql], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 << 20 }));
const rows = (sql) => d1(sql)[0].results;
const changes = (r) => r.reduce((n, x) => n + (x.meta?.changes ?? 0), 0);
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const isAddr = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s ?? "");
const isRoute = (s) => isAddr(s) || /^\*@[^\s@]+\.[^\s@]+$/.test(s ?? "");

// The Worker a domain names in its _mailopus TXT record (docs/sign-in.md).
const txtServer = async (domain) => (await resolveTxt(`_mailopus.${domain}`).catch(() => [])).map((r) => r.join("")).find((v) => /^https:\/\/[^/]+\/?$/.test(v));

class Fail extends Error {}
class Usage extends Error {}
const fail = (message) => {
	throw new Fail(message);
};
const usage = () => {
	throw new Usage();
};

// Build, migrate D1, deploy. `pnpm run deploy` and the Deploy to Cloudflare button run this. A first
// deploy has no database to migrate until `wrangler deploy` creates it, so migrations run before
// deploying when the database exists (an update never runs new code on an old schema) and again after
// (a first deploy gets its tables).
//
// A Worker without a CLAIM_CODE secret gets one: a random code that claiming requires (server/lib/claim.ts),
// printed with a claim link. The code rides in the link's fragment, which no server sees. This keys on the
// secret, not on the database, because the Deploy to Cloudflare button creates the database before the
// first build runs.
function deploy() {
	const read = (f) => JSON.parse(readFileSync(f, "utf8").replace(/^\s*\/\/.*$/gm, ""));
	const conf = read(config ?? "wrangler.jsonc");
	// A maintainer's own instance may keep its config in wrangler.app.jsonc. If that names the same Worker
	// and account as this deploy, refuse, so the customer build never replaces it.
	const app = !config && existsSync("wrangler.app.jsonc") ? read("wrangler.app.jsonc") : null;
	if (app && conf.name === app.name && process.env.CLOUDFLARE_ACCOUNT_ID === app.account_id) fail("This would replace app.mailopus.net. Deploy it with: pnpm run deploy:app");
	const exists = () => {
		try {
			wrangler(["d1", "info", "DB"], { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	};

	execFileSync("npx", ["nitro", "build"], { stdio: "inherit" });
	if (exists()) migrate();
	run("deploy");
	migrate();

	let have = null;
	try {
		have = JSON.parse(wrangler(["secret", "list", "--format", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).map((s) => s.name);
	} catch {}
	if (have === null) console.warn("\nCouldn't list the Worker's secrets. If you haven't claimed this server, set a claim code: pnpm mailopus secret put CLAIM_CODE");
	else if (!have.includes("CLAIM_CODE")) {
		const code = randomBytes(16).toString("hex");
		wrangler(["secret", "put", "CLAIM_CODE"], { input: code, stdio: ["pipe", "ignore", "inherit"] });
		const origin = conf.vars?.APP_ORIGIN ?? "https://app.mailopus.net";
		console.log(`\nYour claim code: ${code}\nAfter adding the _mailopus TXT record, claim your server at:\n${origin}/auth/claim#code=${code}\n`);
	}
}

const migrate = () => run("d1", "migrations", "apply", "DB", "--remote");

// A one-time passkey invite. The invitee's address gets its exact route in the same step, so they
// receive mail even with the domain's catch-all off (server/lib/invite.ts).
async function invite([who], { name, url, hours }) {
	if (!who) usage();
	const { inviteStatements } = await inviteLib();
	const { toSql } = await provisionLib();
	const email = who.includes("@") ? who.toLowerCase() : undefined;
	const userId = email ? rows(`SELECT a.user_id FROM identities i JOIN accounts a ON a.id = i.account_id WHERE i.email = ${q(email)}`)[0]?.user_id : rows(`SELECT id AS user_id FROM users WHERE id = ${q(who)}`)[0]?.user_id;
	name = name?.trim();
	if (!userId && !(email && name)) fail(`no user for ${who}${email ? `; to invite someone new, add --name "Their Name"` : ""}`);
	const token = randomBytes(32).toString("base64url");
	const tokenHash = createHash("sha256").update(token).digest("hex");
	const expiresAt = Date.now() + Number(hours) * 3_600_000;
	const inv = userId ? inviteStatements({ userId, email, tokenHash, expiresAt }) : inviteStatements({ name, email, tokenHash, expiresAt });
	d1(toSql(inv.statements));
	if (!userId) console.error(`created user ${inv.userId}`);
	// The invite page posts the token to the server in the link, so name this one: the Worker the invitee's
	// domain names in its _mailopus TXT record (docs/sign-in.md). Without it the token would go to the UI's own server.
	const ui = new URL(url).origin;
	const domain = (email ?? rows(`SELECT email FROM identities i JOIN accounts a ON a.id = i.account_id WHERE a.user_id = ${q(userId)} LIMIT 1`)[0]?.email ?? "").split("@")[1];
	const found = server ?? (await txtServer(domain));
	const origin = found && new URL(found).origin;
	if (!origin) console.error(`No _mailopus TXT record for ${domain}. The link assumes the server is ${ui}; add --server <your Worker's URL> if it isn't.`);
	console.log(`${ui}/auth/invite#token=${token}${origin && origin !== ui ? `&server=${encodeURIComponent(origin)}` : ""}`);
}

// A user with one mail account, its mailboxes and a sending identity.
async function userCreate([name, email, ...routes]) {
	if (!name || !isAddr(email)) usage();
	const { provision, toSql } = await provisionLib();
	const p = provision({ name, email, routes: routes.length ? routes : undefined });
	wrangler(["d1", "execute", "DB", "--remote", "--command", toSql(p.statements)], { stdio: ["ignore", "ignore", "inherit"] });
	console.log(`user ${p.userId}\naccount ${p.accountId}`);
	console.log(`invite: pnpm mailopus invite ${email}`);
}

// A send-as address on an existing account, with optional inbound routes.
async function identityAdd([existing, name, email, ...routes]) {
	if (!isAddr(existing) || !name || !isAddr(email) || !routes.every(isRoute)) usage();
	const { newId } = await provisionLib();
	const account = accountOf(existing);
	const statements = [
		`INSERT INTO identities (id, account_id, name, email) VALUES (${q(newId())}, ${q(account)}, ${q(name)}, ${q(email.toLowerCase())})`,
		...routes.map((r) => `INSERT INTO addresses (address, account_id) VALUES (${q(r.toLowerCase())}, ${q(account)})`),
	];
	const n = changes(d1(statements.join(";\n")));
	if (n !== statements.length) fail(`expected ${statements.length} changes, got ${n}`);
	console.log(`added ${email} to account ${account}${routes.length ? `; routing ${routes.join(", ")}` : ""}`);
}

const accountOf = (address) => rows(`SELECT account_id FROM identities WHERE email = ${q(address.toLowerCase())}`)[0]?.account_id ?? fail(`no account sends as ${address}`);

function identityList() {
	for (const i of rows("SELECT email, name, account_id FROM identities ORDER BY account_id, rowid")) console.log(`${i.email.padEnd(34)} ${(i.name ?? "").padEnd(20)} account ${i.account_id.slice(0, 8)}`);
}

// Routes: which account an address's inbound mail lands in. A route without an identity is receive-only.
function addressAdd([address, existing]) {
	if (!isRoute(address) || !isAddr(existing)) usage();
	const account = accountOf(existing);
	const r = d1(`INSERT OR IGNORE INTO addresses (address, account_id) VALUES (${q(address.toLowerCase())}, ${q(account)})`);
	if (changes(r) !== 1) fail(`${address} already has a route. See: mailopus address list`);
	console.log(`mail to ${address} now lands in the account of ${existing}`);
}

function addressList() {
	const owner = {};
	for (const i of rows("SELECT email, account_id FROM identities ORDER BY rowid")) owner[i.account_id] ??= i.email;
	const routes = rows("SELECT address, account_id FROM addresses ORDER BY account_id, address");
	for (const a of routes) console.log(`${a.address.padEnd(34)} -> ${owner[a.account_id] ?? `account ${a.account_id.slice(0, 8)}`}`);
	if (!routes.length) console.log("no routes. Nothing can receive mail yet.");
}

function addressRemove([address]) {
	if (!isRoute(address)) usage();
	const r = d1(`DELETE FROM addresses WHERE address = ${q(address.toLowerCase())}`);
	console.log(changes(r) === 1 ? `mail to ${address} is no longer delivered to it. A catch-all for the domain may still take it.` : `no route for ${address}`);
}

// Why mail went to Junk. Walks the account's Junk mailbox by its newest-first index, never the whole emails table.
function junk([address], { limit }) {
	if (!isAddr(address) || !(Number(limit) >= 1 && Number(limit) <= 200)) usage();
	const account = accountOf(address);
	const list = rows(`SELECT em.received_at, e.subject, json_extract(e.from_json, '$[0].email') AS sender, e.spam_rule FROM email_mailboxes em JOIN emails e ON e.id = em.email_id WHERE em.mailbox_id = (SELECT id FROM mailboxes WHERE account_id = ${q(account)} AND role = 'junk') ORDER BY em.received_at DESC LIMIT ${Number(limit)}`);
	for (const m of list) console.log(`${new Date(m.received_at).toISOString().slice(0, 16).replace("T", " ")}  ${(m.spam_rule ?? "failed DMARC, or moved by hand").padEnd(32)} ${(m.sender ?? "").padEnd(30)} ${m.subject ?? ""}`);
	if (!list.length) console.log("Junk is empty");
}

// Whether the server is claimed, and whether each domain's _mailopus TXT record points sign-in at it.
async function status() {
	const [claimed] = rows("SELECT value FROM instance_settings WHERE key = 'claimed'");
	// Claiming closes once the server has a user (server/lib/claim.ts), whether or not it recorded when.
	const people = rows("SELECT count(*) AS n FROM users")[0].n;
	console.log(claimed ? `claimed: yes, on ${new Date(Number(claimed.value)).toISOString().slice(0, 10)}` : people ? "claimed: yes" : "claimed: no. Use the claim link from your first deploy.");
	console.log(`people: ${people}`);
	for (const { domain } of rows("SELECT DISTINCT substr(email, instr(email, '@') + 1) AS domain FROM identities")) {
		const all = (await resolveTxt(`_mailopus.${domain}`).catch(() => [])).map((r) => r.join(""));
		const good = all.find((v) => /^https:\/\/[^/]+\/?$/.test(v));
		console.log(`${domain.padEnd(26)} ${good ? `_mailopus -> ${good}` : all.length ? `_mailopus TXT is "${all[0]}", which isn't an https:// URL without a path` : "no _mailopus TXT record, so sign-in for this domain uses app.mailopus.net's own server"}`);
	}
}

// Gmail import jobs. The Worker's cron (every 5 min) starts pending jobs, and the queue does the rest.
// Settings > Import does the same through server/lib/import-jobs.ts. Keep the SQL there in step with this.
async function importStart([workspace, source, target]) {
	if (!/^[a-z0-9]+$/i.test(workspace ?? "") || !source?.includes("@") || !target?.includes("@")) usage();
	const { newId } = await provisionLib();
	const account = accountOf(target);
	const id = newId();
	const now = Date.now();
	const r = d1(`INSERT INTO import_jobs (id, account_id, workspace, source_email, created_at, updated_at) VALUES (${q(id)}, ${q(account)}, ${q(workspace.toLowerCase())}, ${q(source.toLowerCase())}, ${now}, ${now})`);
	if (changes(r) !== 1) fail("job not created");
	console.log(`job ${id}: ${source} -> account ${account}. Starts within 5 minutes.`);
}

function importStatus() {
	const jobs = rows("SELECT id, source_email, status, pages, imported, merged, skipped, failed, messages_total, last_error, updated_at FROM import_jobs ORDER BY created_at");
	for (const j of jobs) {
		const ago = Math.round((Date.now() - j.updated_at) / 60_000);
		// Every listed message ends up imported, merged into a twin, skipped as already stored, or failed.
		const done = j.imported + j.merged + j.skipped + j.failed;
		const of = j.messages_total ? ` ${done.toLocaleString()}/${j.messages_total.toLocaleString()} (${Math.min(100, Math.floor((done / j.messages_total) * 100))}%)` : "";
		console.log(`${j.id.slice(0, 8)} ${j.source_email.padEnd(24)} ${j.status.padEnd(8)}${of} pages=${j.pages} imported=${j.imported} merged=${j.merged} skipped=${j.skipped} failed=${j.failed} (${ago}m ago)${j.last_error ? `\n         last error: ${j.last_error}` : ""}`);
	}
	if (!jobs.length) console.log("no import jobs");
}

function importSet([id], _values, key) {
	if (!id) usage();
	const to = key === "import pause" ? "paused" : "pending";
	const r = d1(`UPDATE import_jobs SET status = ${q(to)}, updated_at = ${Date.now()} WHERE id LIKE ${q(`${id}%`)} AND status != 'done'`);
	console.log(changes(r) === 1 ? `job ${id} ${to}` : `no single matching job for ${id}`);
}

function importRescan([id]) {
	if (!id) usage();
	const r = d1(`UPDATE import_jobs SET status = 'pending', page_token = NULL, failed = 0, last_error = NULL, updated_at = ${Date.now()} WHERE id LIKE ${q(`${id}%`)} AND status IN ('done', 'paused', 'failed')`);
	console.log(changes(r) === 1 ? `job ${id} will rescan within 5 minutes` : `no single finished/paused job for ${id}`);
}

function secret([name], _values, key) {
	const verb = key.split(" ")[1];
	if (verb === "list") return run("secret", "list");
	if (!/^[A-Z0-9_]+$/.test(name ?? "")) usage();
	run("secret", verb, name);
}

function sql([query], { json }) {
	if (!query) usage();
	const out = d1(query);
	if (json) return console.log(JSON.stringify(out, null, 1));
	for (const r of out) {
		if (r.results?.length) console.table(r.results);
		else console.log(r.meta?.changes ? `${r.meta.changes} rows changed` : "no rows returned or changed");
	}
}

const backup = ([file = `mailopus-${new Date().toISOString().slice(0, 10)}.sql`]) => run("d1", "export", "DB", "--remote", `--output=${file}`);
const restore = (_args, { timestamp }) => (timestamp ? run("d1", "time-travel", "restore", "DB", `--timestamp=${timestamp}`) : run("d1", "time-travel", "info", "DB"));

// Plugins: Workers that hear about mail as it arrives and leaves (docs/plugins.md). The list is one
// row in D1, instance_settings 'plugins', which the server reads in server/lib/plugin-hooks.ts.
// It holds each plugin's key, because `with` and `plugin test` have to send it.
const EVENTS = ["receive", "send"];
const WANTS = ["envelope", "headers", "body"];

/**
 * One entry for the list, or a Fail that says what is wrong with the arguments. With no url the
 * plugin is a Worker in this account, reached over a service binding. With one it's reached over
 * https with a key.
 */
export function pluginEntry(name, url, { events = "receive,send", wants = "envelope", act = false, key, binding } = {}) {
	if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name ?? "")) fail("A plugin name is lowercase letters, digits and dashes, at most 32.");
	if (url !== undefined && !/^https:\/\/[^\s/]+/.test(url)) fail("The plugin URL must start with https://");
	if (url !== undefined && binding) fail("Give a URL or --binding, not both.");
	binding ??= `PLUGIN_${name.toUpperCase().replaceAll("-", "_")}`;
	if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(binding)) fail("A binding name is capital letters, digits and underscores.");
	const list = events.split(",").filter(Boolean);
	if (!list.length || !list.every((e) => EVENTS.includes(e))) fail(`--events takes ${EVENTS.join(", ")}, comma-separated`);
	if (!WANTS.includes(wants)) fail(`--wants takes one of ${WANTS.join(", ")}`);
	return { name, ...(url === undefined ? { binding } : { url: url.replace(/\/+$/, ""), key: key ?? randomBytes(24).toString("base64url") }), events: list, wants, act };
}

/** A wrangler config's text with a service binding to the plugin's Worker added, comments kept. */
export function bindService(text, binding, service) {
	if (!/^[a-z0-9][a-z0-9_-]*$/i.test(service)) fail("--service is the plugin Worker's name, as in its wrangler.jsonc.");
	if (new RegExp(`"binding"\\s*:\\s*"${binding}"`).test(text)) return text;
	const entry = `{ "binding": "${binding}", "service": "${service}", "entrypoint": "Plugin" }`;
	const list = text.match(/^[ \t]*"services"\s*:\s*\[/m);
	if (!list) return text.replace("{", `{\n\t// Plugins (docs/plugins.md). \`mailopus plugin add\` writes these.\n\t"services": [\n\t\t${entry}\n\t],`);
	const at = list.index + list[0].length;
	const rest = text.slice(at);
	// An entry already on the opening line moves down to its own.
	return `${text.slice(0, at)}\n\t\t${entry}${/^\s*\]/.test(rest) ? "\n\t" : /^[ \t]*\n/.test(rest) ? "," : ",\n\t\t"}${rest.replace(/^[ \t]+(?=\S)/, "")}`;
}

function pluginList() {
	const value = rows("SELECT value FROM instance_settings WHERE key = 'plugins'")[0]?.value;
	try {
		return value ? JSON.parse(value) : [];
	} catch {
		fail("The stored plugin list isn't valid JSON. Look at it with: mailopus sql \"SELECT value FROM instance_settings WHERE key = 'plugins'\"");
	}
}
const pluginSave = (list) => changes(d1(`INSERT INTO instance_settings (key, value) VALUES ('plugins', ${q(JSON.stringify(list))}) ON CONFLICT (key) DO UPDATE SET value = excluded.value`)) === 1 || fail("plugin list not saved");
const pluginNamed = (name) => pluginList().find((p) => p.name === name) ?? fail(`no plugin named ${name}. See: mailopus plugin list`);

function pluginAdd([name, url], values) {
	if (!name) usage();
	const entry = pluginEntry(name, url, values);
	if (entry.binding) {
		const file = config ?? "wrangler.jsonc";
		const before = readFileSync(file, "utf8");
		const after = bindService(before, entry.binding, values.service ?? `mailopus-${name}`);
		if (after !== before) writeFileSync(file, after);
	}
	pluginSave([...pluginList().filter((p) => p.name !== name), entry]);
	console.log(`${name}: gets ${entry.events.join(" and ")}, sees ${entry.wants}, ${entry.act ? "can file or stop mail" : "watches only"}`);
	if (entry.binding) console.log(`\n${config ?? "wrangler.jsonc"} now binds ${entry.binding} to the Worker ${values.service ?? `mailopus-${name}`}. The plugin must be deployed first.\nTurn it on by deploying your server: pnpm run deploy\nIf your server deploys from GitHub, commit and push that file instead.`);
	else if (!values.key) console.log(`\nSet this key on the plugin, as the secret its README names:\n${entry.key}`);
	console.log(`\nThen check it with: mailopus plugin test ${name}`);
}

function pluginShow() {
	const list = pluginList();
	for (const p of list) console.log(`${p.name.padEnd(12)} ${p.binding ? `binding ${p.binding}` : p.url}  events=${p.events?.join(",")} wants=${p.wants ?? "envelope"} ${p.act ? "acts" : "watches"}`);
	if (!list.length) console.log("no plugins");
}

function pluginRemove([name]) {
	if (!name) usage();
	const p = pluginNamed(name);
	pluginSave(pluginList().filter((x) => x.name !== name));
	console.log(`removed ${name}. It no longer gets mail events. Its Worker is still deployed.${p.binding ? `\nIts ${p.binding} binding is still in your wrangler config. Take it out before you delete the plugin's Worker, or your next deploy fails.` : ""}`);
}

// A bound plugin has no address of its own, so calls to it go through your server, which has the
// binding (cliPluginCall in server/lib/plugin-hooks.ts). The proof that this is the owner is a token
// whose hash only someone with the cloud login could have written to D1. One lasts a few minutes.
let origin;
let cliToken;
async function throughServer(p, path, body) {
	if (!origin) {
		// --server, then the _mailopus TXT record of any domain an account sends from, then a custom
		// domain in the wrangler config.
		let found = server;
		for (const { domain } of found ? [] : rows("SELECT DISTINCT substr(email, instr(email, '@') + 1) AS domain FROM identities")) if ((found = await txtServer(domain))) break;
		if (!found) {
			const route = JSON.parse(readFileSync(config ?? "wrangler.jsonc", "utf8").replace(/^\s*\/\/.*$/gm, "")).routes?.find((r) => r.custom_domain)?.pattern;
			if (route) found = `https://${route}`;
		}
		origin = found ? new URL(found).origin : fail("Can't find your server's address. Put --server https://<your Worker> before the command, or set MAILOPUS_SERVER.");
	}
	if (!cliToken || cliToken.expires < Date.now() + 30_000) {
		const token = randomBytes(32).toString("base64url");
		const expires = Date.now() + 270_000;
		const r = d1(`INSERT INTO instance_settings (key, value) VALUES (${q(`cli-token:${createHash("sha256").update(token).digest("hex")}`)}, ${q(String(expires))})`);
		if (changes(r) !== 1) fail("couldn't write the command-line token");
		cliToken = { token, expires };
	}
	return [`${origin}/api/plugins/call`, {}, { token: cliToken.token, name: p.name, path, body }];
}

async function pluginPost(p, path, body) {
	const [url, auth, payload] = p.binding ? await throughServer(p, path, body) : [`${p.url}/v1/${path}`, { authorization: `Bearer ${p.key}` }, body];
	const res = await fetch(url, {
		method: "POST",
		headers: { ...auth, "content-type": "application/json" },
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(20_000),
	}).catch((e) => fail(`${p.name} didn't answer at ${new URL(url).origin}: ${e.message}`));
	const text = await res.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {}
	return { ok: res.ok, status: res.status, text, json };
}

// A made-up message, sent to the plugin the way the server would send it: through your server for a
// bound plugin, straight from here for one at a URL.
async function pluginTest([name, event = "receive"], { from, to, subject, body }) {
	if (!name || !EVENTS.includes(event)) usage();
	const p = pluginNamed(name);
	const wants = p.wants ?? "envelope";
	const r = await pluginPost(p, "event", {
		event,
		account: "test",
		test: true,
		message: { from: { name: "", email: from }, to: [to], cc: [], subject, messageId: `<test-${Date.now()}@mailopus.invalid>`, date: Date.now(), ...(event === "receive" && { rcpt: to, junk: false }) },
		...(wants !== "envelope" && { headers: `From: ${from}\nTo: ${to}\nSubject: ${subject}` }),
		...(wants === "body" && { body }),
	});
	console.log(`${name} answered ${r.status}${r.text.trim() ? `: ${r.text.trim()}` : ""}`);
	if (r.status === 401 && !p.binding) fail("The plugin refused the key. Set the key from `mailopus plugin add` on the plugin, or add it again with --key.");
	if (r.status === 502 && p.binding) fail("Your server couldn't reach the plugin. Deploy the plugin, then your server, so the binding exists.");
	if (!r.ok) fail("The server treats any answer but 2xx as no answer.");
	if (p.events && !p.events.includes(event)) console.log(`Note: ${name} isn't registered for ${event} events, so the server won't send it these.`);
}

/** Plays a sound file here, or the terminal bell when it can't. */
function play(sound) {
	const player = { darwin: "afplay", linux: "aplay" }[process.platform];
	const file = typeof sound === "string" && existsSync(sound) ? sound : process.platform === "darwin" ? "/System/Library/Sounds/Glass.aiff" : null;
	try {
		if (!player || !file) throw new Error("no player");
		execFileSync(player, [file], { stdio: "ignore" });
	} catch {
		process.stdout.write("\x07");
	}
}

// Hands the rest of the line to the plugin, which defines its own commands. Its answer is JSON:
// text to print, sound to play here (true or a file path), again to ask once more in that many seconds.
async function withPlugin([name, ...args]) {
	if (!name) usage();
	const p = pluginNamed(name);
	let waiting = false;
	for (;;) {
		const r = await pluginPost(p, "command", { args });
		const a = r.json ?? {};
		if (typeof a.text === "string" && a.text) console.log(a.text);
		if (!r.ok) fail(typeof a.text === "string" && a.text ? "" : `${name} answered ${r.status}${r.text.trim() ? `: ${r.text.trim()}` : ""}`);
		if (a.sound) play(a.sound);
		if (!(a.again > 0)) return;
		if (!waiting) console.error("Waiting. Ctrl-C stops.");
		waiting = true;
		await sleep(Math.max(1, Number(a.again)) * 1000);
	}
}

// usage: what follows `mailopus`. summary: one line for the list. help: the rest of --help.
export const COMMANDS = {
	deploy: { usage: "deploy", summary: "Build, apply migrations and deploy your server", help: "A first deploy also sets a claim code and prints the claim link.", run: deploy },
	migrate: { usage: "migrate", summary: "Apply database migrations without deploying", run: migrate },
	invite: {
		usage: 'invite <email|user_id> [--name "<Name>"] [--url <ui-url>] [--hours <n>] [--server <worker-url>]',
		summary: "Print a one-time passkey invite link",
		help: "The email is any address the person sends from. For someone new, add --name, which creates their user and account.\n--url is the web app the link opens (default https://app.mailopus.net). --hours is how long it lasts (default 24).\n--server names your Worker when the domain has no _mailopus TXT record yet.",
		options: { name: { type: "string" }, url: { type: "string", default: "https://app.mailopus.net" }, hours: { type: "string", default: "24" } },
		run: invite,
	},
	"user create": {
		usage: 'user create "<Name>" <email> [route ...]',
		summary: "Create a user with one mail account, without an invite",
		help: 'A route is an address or "*@domain" that delivers to the account (default: the email itself).',
		run: userCreate,
	},
	"identity add": {
		usage: 'identity add <existing-address> "<Name>" <new-address> [route ...]',
		summary: "Add a send-as address to an account, with optional inbound routes",
		help: 'existing-address is any address the account already sends as. A route is an address or "*@domain" whose inbound mail lands in this account.\nSending as a new domain also needs Email Sending set up for that domain in Cloudflare.',
		run: identityAdd,
	},
	"identity list": { usage: "identity list", summary: "List every send-as address and its account", run: identityList },
	"address add": {
		usage: "address add <address|*@domain> <existing-address>",
		summary: "Deliver an address's mail to an account, without making it a send-as address",
		help: 'existing-address is any address the account already sends as. "*@domain" takes every address at the domain that has no route of its own.',
		run: addressAdd,
	},
	"address list": { usage: "address list", summary: "List every address that receives mail and whose account it lands in", run: addressList },
	"address remove": { usage: "address remove <address|*@domain>", summary: "Stop delivering an address's mail", run: addressRemove },
	junk: {
		usage: "junk <address> [--limit <n>]",
		summary: "Show the newest Junk mail in an account and why each message is there",
		help: "address is any address the account sends as. The reason is a spam rule's name, blocked-sender, or plugin:<name>. --limit is 20 by default, 200 at most.",
		options: { limit: { type: "string", default: "20" } },
		run: junk,
	},
	status: { usage: "status", summary: "Show whether the server is claimed and what each domain's _mailopus record says", run: status },
	"relay deploy": {
		usage: "relay deploy",
		summary: "Deploy the relay Worker for a domain in another Cloudflare account",
		help: "Deploys relay/wrangler.jsonc. Set CLOUDFLARE_ACCOUNT_ID to the account that holds the domain's zone.",
		run: () => execFileSync("npx", ["wrangler", "deploy", "-c", "relay/wrangler.jsonc"], { stdio: "inherit" }),
	},
	"import start": {
		usage: "import start <workspace> <gmail-address> <mailopus-address>",
		summary: "Queue a Gmail import. It starts within 5 minutes",
		help: "workspace picks the service-account secret, GOOGLE_SA_<WORKSPACE>, for example work.\nmailopus-address is any send-as address of the account to import into.",
		run: importStart,
	},
	"import status": { usage: "import status", summary: "Show every import job and its progress", run: importStatus },
	"import pause": { usage: "import pause <job_id>", summary: "Pause an import job", help: "The first characters of the job id are enough.", run: importSet },
	"import resume": { usage: "import resume <job_id>", summary: "Resume a paused import job", help: "The first characters of the job id are enough.", run: importSet },
	"import rescan": {
		usage: "import rescan <job_id>",
		summary: "Walk the mailbox again and fetch only missing messages",
		help: "Stored mail is skipped. Failed counts reset.",
		run: importRescan,
	},
	"secret put": { usage: "secret put <NAME>", summary: "Set a secret on your Worker", help: "Asks for the value, so it stays out of your shell history. Or pipe it in: mailopus secret put NAME < file", run: secret },
	"secret delete": { usage: "secret delete <NAME>", summary: "Remove a secret", run: secret },
	"secret list": { usage: "secret list", summary: "List the names of the secrets that are set", run: secret },
	logs: { usage: "logs", summary: "Stream your Worker's logs", run: () => run("tail") },
	sql: {
		usage: 'sql "<SQL>" [--json]',
		summary: "Run SQL against your live database",
		help: "Prints result rows as a table, or how many rows a write changed. --json prints the raw result.",
		options: { json: { type: "boolean" } },
		run: sql,
	},
	backup: { usage: "backup [file]", summary: "Export the database to a .sql file", help: "The default file is mailopus-<today>.sql in the current directory.", run: backup },
	restore: {
		usage: "restore [--timestamp <unix time or RFC 3339>]",
		summary: "Show the restore window, or rewind the database to a moment in it",
		help: "Without --timestamp it only shows what can be restored. A restore replaces the live database.",
		options: { timestamp: { type: "string" } },
		run: restore,
	},
	"plugin add": {
		usage: "plugin add <name> [--service <worker>] [--binding <NAME>] [--events receive,send] [--wants envelope|headers|body] [--act]\n       mailopus plugin add <name> <https-url> [--key <key>] [the same options]",
		summary: "Connect a plugin Worker to your server",
		help: "Without a URL the plugin is a Worker in your own account. This adds a service binding to it in your wrangler config, which your next deploy turns on.\n--service is the plugin Worker's name (default mailopus-<name>). --binding names the binding (default PLUGIN_<NAME>).\nWith a URL the server reaches the plugin over https with a key. It prints a new key to set on the plugin, unless --key gives one it already has.\n--events picks what it hears about (default both). --wants is how much of each message it sees (default envelope: addresses and subject).\n--act makes the server wait for its answer, which can file received mail or stop a send. Without it the plugin only watches.\nAdding a name again replaces it.",
		options: { events: { type: "string" }, wants: { type: "string" }, act: { type: "boolean" }, key: { type: "string" }, service: { type: "string" }, binding: { type: "string" } },
		run: pluginAdd,
	},
	"plugin list": { usage: "plugin list", summary: "List connected plugins", run: pluginShow },
	"plugin remove": { usage: "plugin remove <name>", summary: "Disconnect a plugin", run: pluginRemove },
	"plugin test": {
		usage: "plugin test <name> [receive|send] [--from <address>] [--to <address>] [--subject <text>] [--body <text>]",
		summary: "Send a plugin a made-up message and print its answer",
		help: "The event is marked \"test\": true. No mail is stored or sent. A bound plugin is reached through your server.",
		options: { from: { type: "string", default: "sender@example.com" }, to: { type: "string", default: "you@example.com" }, subject: { type: "string", default: "Test from mailopus" }, body: { type: "string", default: "This is a test." } },
		run: pluginTest,
	},
	with: {
		usage: "with <plugin> <the plugin's own command ...>",
		summary: "Run one of a plugin's commands",
		help: "Everything after the plugin's name goes to the plugin as written. Try: mailopus with <plugin> help\nPut -c and --server before `with`.",
		run: withPlugin,
	},
	login: { usage: "login", summary: "Sign in to Cloudflare", run: () => run("login") },
	whoami: { usage: "whoami", summary: "Show the Cloudflare account you're signed in to", run: () => run("whoami") },
};

const GLOBAL = { config: { type: "string", short: "c" }, server: { type: "string" }, help: { type: "boolean", short: "h" } };
const overview = () =>
	`usage: mailopus <command> [-c <wrangler config>] [--help]\n\n${Object.entries(COMMANDS)
		.map(([key, c]) => `  ${key.padEnd(15)} ${c.summary}`)
		.join("\n")}\n\nRun it from your clone. It works on the server wrangler.jsonc describes.\nAnother config: -c <file> or MAILOPUS_CONFIG. Details: mailopus <command> --help`;

/** Finds the command in argv and parses its options. No key: argv named no known command. */
export function resolve(argv) {
	// A loose pass to find the command words wherever -c sits, then a strict one with that command's options.
	// `with` passes the rest of the line to the plugin untouched, options and all.
	const at = argv.indexOf("with");
	if (at !== -1) {
		const before = parseArgs({ args: argv.slice(0, at), options: GLOBAL, strict: false, allowPositionals: true });
		const rest = argv.slice(at + 1);
		if (!before.positionals.length) return { key: "with", values: { ...before.values, help: before.values.help || ["-h", "--help"].includes(rest[0]) }, positionals: rest };
	}
	const words = parseArgs({ args: argv, options: GLOBAL, strict: false, allowPositionals: true }).positionals;
	const key = [words.slice(0, 2).join(" "), words[0]].find((k) => Object.hasOwn(COMMANDS, k));
	if (!key) return { words };
	try {
		const { values, positionals } = parseArgs({ args: argv, options: { ...GLOBAL, ...COMMANDS[key].options }, allowPositionals: true });
		return { key, values, positionals: positionals.slice(key.split(" ").length) };
	} catch (e) {
		throw Object.assign(e, { key });
	}
}

/** Runs one command line and returns the exit code. */
export async function main(argv) {
	let key;
	try {
		const r = resolve(argv);
		if (!r.key) {
			if (!r.words.length) return console.log(overview()), 0;
			console.error(`unknown command: ${r.words.slice(0, 2).join(" ")}\n\n${overview()}`);
			return 1;
		}
		key = r.key;
		const cmd = COMMANDS[key];
		if (r.values.help) return console.log(`usage: mailopus ${cmd.usage}\n\n${cmd.summary}.${cmd.help ? `\n${cmd.help}` : ""}`), 0;
		config = r.values.config ?? process.env.MAILOPUS_CONFIG;
		server = r.values.server ?? process.env.MAILOPUS_SERVER;
		await cmd.run(r.positionals, r.values, key);
		return 0;
	} catch (e) {
		key ??= e.key;
		if (e instanceof Usage) console.error(`usage: mailopus ${COMMANDS[key].usage}`);
		else if (e instanceof Fail) e.message && console.error(e.message);
		// A bad option. parseArgs says which.
		else if (e.code?.startsWith("ERR_PARSE_ARGS")) console.error(`${e.message}\n${key ? `usage: mailopus ${COMMANDS[key].usage}` : overview()}`);
		// Wrangler failed and already said why, on stderr or, with --json, on the stdout this captured.
		else if (typeof e.status === "number") return e.stdout?.length && console.error(String(e.stdout).trim()), e.status || 1;
		else throw e;
		return 1;
	}
}
