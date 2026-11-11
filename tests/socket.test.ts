// Run: pnpm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { newAppPassword, sha256 } from "../server/lib/auth.ts";
import { gate } from "../server/lib/gate.ts";
import { liveSocket } from "../server/lib/live.ts";
import { socketMessage } from "../server/lib/socket.ts";
import { ME, testD1 } from "./d1.ts";

const ORIGIN = "https://app.mailopus.net";

async function setup() {
	const db = testD1();
	const pass = newAppPassword();
	db.raw.prepare("INSERT INTO app_passwords (id, user_id, name, token_hash, created_at) VALUES ('p1', 'user', 'Mail', ?, 1)").run(await sha256(pass));
	const hub: { name?: string; auth?: unknown } = {};
	const env = {
		APP_ORIGIN: ORIGIN,
		DB: db,
		AUTH_LIMIT: { limit: async () => ({ success: true }) },
		ACCOUNT: {
			idFromName: (n: string) => n,
			get: (name: string) => ({
				fetch: async (r: Request) => {
					hub.name = name;
					hub.auth = JSON.parse(r.headers.get("x-mailopus-socket")!);
					return new Response("socket");
				},
			}),
		},
	} as unknown as Env;
	const open = (query = "") => {
		const headers = { upgrade: "websocket", authorization: `Basic ${btoa(`${ME}:${pass}`)}` };
		const req = new Request(`${ORIGIN}/jmap/ws${query}`, { headers });
		return gate(req, env, () => liveSocket(req, env));
	};
	return { db, open, hub };
}

test("a standard client opens /jmap/ws with Basic auth and no ?account, and gets the user's hub for all accounts", async () => {
	const { open, hub } = await setup();
	assert.equal(await (await open()).text(), "socket");
	assert.equal(hub.name, "user:user");
	// cred names the app password, so revoking it can close this socket (closeSockets in server/lib/live.ts).
	assert.deepEqual(hub.auth, { userId: "user", scope: null, account: null, cred: "app:p1" });
});

test("the web app's ?account= still narrows the socket, and only to an account the user owns", async () => {
	const { open, hub } = await setup();
	await open("?account=acct");
	assert.deepEqual(hub.auth, { userId: "user", scope: null, account: "acct", cred: "app:p1" });
	assert.equal((await open("?account=someone-else")).status, 403);
});

test("socket messages: push toggles, JMAP requests answered, errors carry the request id", async () => {
	const { db } = await setup();
	const ctx = async () => ({ db, mail: {} as R2Bucket, accounts: new Set(["acct"]), writer: () => { throw new Error("read-only"); }, createdIds: {} });
	const msg = (m: unknown) => socketMessage(typeof m === "string" ? m : JSON.stringify(m), ctx);

	assert.deepEqual(await msg({ "@type": "WebSocketPushEnable", dataTypes: null }), { push: true });
	assert.deepEqual(await msg({ "@type": "WebSocketPushDisable" }), { push: false });

	const ok = (await msg({ "@type": "Request", id: "r1", using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"], methodCalls: [["Mailbox/get", { accountId: "acct", ids: null }, "0"]] })).reply as {
		"@type": string; requestId: string; methodResponses: [string, { list: unknown[] }, string][];
	};
	assert.equal(ok["@type"], "Response");
	assert.equal(ok.requestId, "r1");
	assert.equal(ok.methodResponses[0]![0], "Mailbox/get");
	assert.ok(ok.methodResponses[0]![1].list.length > 0);

	assert.deepEqual((await msg({ "@type": "Request", id: "r2", using: ["urn:nope"], methodCalls: [] })).reply, {
		"@type": "RequestError", requestId: "r2", type: "urn:ietf:params:jmap:error:unknownCapability", status: 400, detail: "urn:nope",
	});
	assert.equal(((await msg("not json")).reply as { type: string }).type, "urn:ietf:params:jmap:error:notJSON");
	assert.equal(((await msg({ "@type": "Hello", id: "r3" })).reply as { type: string }).type, "urn:ietf:params:jmap:error:notRequest");
});

test("a one-time ticket opens the socket once, for its user, and dies with the session", async () => {
	const { issueSocketTicket, takeSocketTicket, sha256: hash, WS_TICKET_PREFIX } = await import("../server/lib/auth.ts");
	const { db, open: _open, hub } = await setup();
	const tokenHash = await hash("session-token");
	db.raw.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, 'user', 1, ?)").run(tokenHash, Date.now() + 1e6);
	const env = { APP_ORIGIN: ORIGIN, DB: db, AUTH_LIMIT: { limit: async () => ({ success: true }) }, ACCOUNT: { idFromName: (n: string) => n, get: (name: string) => ({ fetch: async (r: Request) => ((hub.name = name), (hub.auth = JSON.parse(r.headers.get("x-mailopus-socket")!)), new Response("socket")) }) } } as unknown as Env;
	const open = (ticket: string, origin = ORIGIN) => {
		const req = new Request(`${ORIGIN}/jmap/ws?account=acct`, { headers: { upgrade: "websocket", origin, "sec-websocket-protocol": `jmap, ${WS_TICKET_PREFIX}${ticket}` } });
		return gate(req, env, () => liveSocket(req, env));
	};
	const ticket = await issueSocketTicket(db, "user", tokenHash);
	assert.equal((await open(ticket, "https://evil.example")).status, 403, "another site can't spend it");
	assert.equal(await (await open(ticket)).text(), "socket");
	// The socket is tied to the session that asked, so signing that session out closes it.
	assert.deepEqual(hub.auth, { userId: "user", scope: null, account: "acct", cred: `session:${tokenHash}` });
	assert.equal((await open(ticket)).status, 401, "once only");
	assert.equal((await open("made-up")).status, 401);
	// Expired, and one whose session has since ended.
	const stale = await issueSocketTicket(db, "user", tokenHash, Date.now() - 120_000);
	assert.equal(await takeSocketTicket(db, stale), null);
	const orphan = await issueSocketTicket(db, "user", tokenHash);
	db.raw.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
	assert.equal((await open(orphan)).status, 401);
	// A passkey challenge's id is not a ticket.
	db.raw.prepare("INSERT INTO challenges (id, challenge, user_id, expires_at) VALUES ('chal', 'mailopus1 x y', 'user', ?)").run(Date.now() + 1e6);
	assert.equal((await open("chal")).status, 401);
	assert.equal((db.raw.prepare("SELECT count(*) AS n FROM challenges WHERE id = 'chal'").get() as { n: number }).n, 1, "and trying it as one leaves it alone");
});
