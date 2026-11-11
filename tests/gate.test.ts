// Run: pnpm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256 } from "../server/lib/auth.ts";
import { gate } from "../server/lib/gate.ts";

const ORIGIN = "https://app.mailopus.net";
const GOOD = "good-token";
const goodHash = await sha256(GOOD);

function env(limitOk = true) {
	return {
		APP_ORIGIN: ORIGIN,
		ASSETS: { fetch: async () => new Response("login page") },
		AUTH_LIMIT: { limit: async () => ({ success: limitOk }) },
		DB: {
			prepare: () => ({
				bind: (hash: string) => ({
					first: async () => (hash === goodHash ? { user_id: "user", expires_at: Date.now() + 1e6 } : null),
				}),
			}),
		},
	} as unknown as Env;
}

const reached = () => new Response("app", { status: 200 });
const req = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => new Request(ORIGIN + path, init);

test("pre-auth pages load without a session and carry noindex", async () => {
	const res = await gate(req("/auth/login"), env(), reached);
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
});

test("mail and account data are refused without a session", async () => {
	for (const path of ["/api/me", "/jmap/api", "/jmap/download/a/b/c", "/.well-known/jmap"]) {
		assert.equal((await gate(req(path), env(), reached)).status, 401, path);
	}
});

test("the lobby: anonymous visitors at / go to the landing page and get none of the app", async () => {
	const assets = async (r: Request) => new Response(new URL(r.url).pathname);
	const e = { ...env(), ASSETS: { fetch: assets }, SITE_ORIGIN: "https://mailopus.net" } as unknown as Env;
	const home = await gate(req("/"), e, reached);
	assert.equal(home.status, 302);
	assert.equal(home.headers.get("location"), "https://mailopus.net/");
	assert.equal((await gate(req("/_nuxt/entry.js"), e, reached)).status, 404);
	const nav = await gate(req("/mail/inbox", { headers: { "sec-fetch-mode": "navigate" } }), e, reached);
	assert.equal(nav.headers.get("location"), `${ORIGIN}/auth/login?next=%2Fmail%2Finbox`);
	assert.equal((await gate(req("/auth/backend.js"), e, reached)).status, 200);
	// A customer's own Worker has no landing page: / goes to sign-in.
	const theirs = await gate(new Request("https://mail.example.com/", { headers: { "sec-fetch-mode": "navigate" } }), e, reached);
	assert.equal(theirs.headers.get("location"), "https://mail.example.com/auth/login");
});

test("a session cookie or the sign-in pass opens the UI, unchecked: it holds no mail", async () => {
	for (const cookie of ["__Host-mo_session=anything", "mailopus_pass=1"]) {
		for (const path of ["/_nuxt/entry.js", "/mail/inbox", "/"]) {
			assert.equal(await (await gate(req(path, { headers: { cookie } }), env(), reached)).text(), "app", `${cookie} ${path}`);
		}
	}
});

test("browser navigation to data without a session redirects to login and keeps the path", async () => {
	const res = await gate(req("/jmap/download/a/b/c?x=1", { headers: { "sec-fetch-mode": "navigate" } }), env(), reached);
	assert.equal(res.status, 302);
	assert.equal(res.headers.get("location"), `${ORIGIN}/auth/login?next=%2Fjmap%2Fdownload%2Fa%2Fb%2Fc%3Fx%3D1`);
});

test("a valid session reaches the app; a bad one does not", async () => {
	assert.equal((await gate(req("/api/me", { headers: { cookie: `a=b; __Host-mo_session=${GOOD}` } }), env(), reached)).status, 200);
	assert.equal((await gate(req("/api/me", { headers: { cookie: "__Host-mo_session=nope" } }), env(), reached)).status, 401);
});

test("cross-site writes are refused even with a session or on pre-auth endpoints", async () => {
	const post = (path: string, origin: string) =>
		req(path, { method: "POST", headers: { origin, cookie: `__Host-mo_session=${GOOD}` } });
	assert.equal((await gate(post("/api/auth/login/options", "https://evil.example"), env(), reached)).status, 403);
	assert.equal((await gate(post("/jmap/api", "https://evil.example"), env(), reached)).status, 403);
	assert.equal((await gate(post("/jmap/api", ORIGIN), env(), reached)).status, 200);
});

test("pre-auth endpoints are rate limited", async () => {
	const post = req("/api/auth/login/options", { method: "POST", headers: { origin: ORIGIN } });
	assert.equal((await gate(post, env(false), reached)).status, 429);
});

test("HTML gets a CSP that allows exactly its own inline scripts", async () => {
	const { cspFor } = await import("../server/lib/gate.ts");
	const csp = await cspFor('<script>a()</script><script type="application/json">{}</script><script src="/x.js"></script>');
	const hashes = csp.match(/'sha256-[^']+'/g) ?? [];
	assert.equal(hashes.length, 1, "only the executable inline script is hashed");
	assert.match(csp, /frame-ancestors 'none'/);
	assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
});

test("HTML pages pass through the gate with a CSP header", async () => {
	const page = async () => new Response("<script>x()</script>", { headers: { "content-type": "text/html" } });
	const e = { ...env(), ASSETS: { fetch: page } } as unknown as Env;
	const res = await gate(req("/auth/login"), e, reached);
	assert.match(res.headers.get("content-security-policy") ?? "", /script-src 'self' 'sha256-/);
	assert.equal(res.headers.get("cache-control"), "no-store, no-transform", "a cached shell outlives the build it points at");
	assert.equal(res.headers.get("strict-transport-security"), "max-age=31536000");
	assert.equal(res.headers.get("cross-origin-opener-policy"), "same-origin");
	assert.equal(await res.text(), "<script>x()</script>");
});

test("an HTML attachment keeps the sandbox policy its route set, instead of one that allows its scripts", async () => {
	const download = () => new Response("<script>steal()</script>", { headers: { "content-type": "text/html", "content-security-policy": "sandbox; default-src 'none'" } });
	const res = await gate(req("/jmap/download/a/b/page.html", { headers: { authorization: `Bearer ${GOOD}`, origin: ORIGIN } }), env(), download);
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("content-security-policy"), "sandbox; default-src 'none'");
});

test("a 304 for an HTML page carries no CSP, so the cached page keeps its script hashes", async () => {
	const notModified = async () => new Response(null, { status: 304, headers: { "content-type": "text/html" } });
	const e = { ...env(), ASSETS: { fetch: notModified } } as unknown as Env;
	const res = await gate(req("/auth/login"), e, reached);
	assert.equal(res.status, 304);
	assert.equal(res.headers.get("content-security-policy"), null);
});

test("/api/ingest skips session and Origin (its signature is checked in the handler); other methods 405", async () => {
	const post = req("/api/ingest", { method: "POST" });
	assert.equal((await gate(post, env(), reached)).status, 200);
	assert.equal((await gate(req("/api/ingest"), env(), reached)).status, 405);
});

test("WebSocket upgrades need the app's Origin and a session, and the 101 passes through untouched", async () => {
	const ws = (origin: string, cookie?: string) => req("/jmap/ws", { headers: { upgrade: "websocket", origin, ...(cookie ? { cookie } : {}) } });
	assert.equal((await gate(ws("https://evil.example", `__Host-mo_session=${GOOD}`), env(), reached)).status, 403);
	assert.equal((await gate(ws(ORIGIN), env(), reached)).status, 401);
	const sentinel = new Response("socket");
	assert.equal(await gate(ws(ORIGIN, `__Host-mo_session=${GOOD}`), env(), () => sentinel), sentinel, "not re-wrapped");
});

// The UI at mailopus.net calling a customer's own Worker.
const WORKER = "https://mail.customer.example";
const remote = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => new Request(WORKER + path, init);

test("a bearer token from the UI origin reaches a customer's Worker, with CORS", async () => {
	const res = await gate(remote("/jmap/api", { method: "POST", headers: { origin: ORIGIN, authorization: `Bearer ${GOOD}` } }), env(), reached);
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("access-control-allow-origin"), ORIGIN);
	assert.equal(res.headers.get("access-control-allow-credentials"), null);
	const bad = await gate(remote("/jmap/api", { method: "POST", headers: { origin: ORIGIN, authorization: "Bearer nope" } }), env(), reached);
	assert.equal(bad.status, 401);
	assert.equal(bad.headers.get("access-control-allow-origin"), ORIGIN, "the UI can read the 401 and sign in again");
});

test("preflight from the UI origin is answered; other origins get no CORS", async () => {
	const pre = await gate(remote("/jmap/api", { method: "OPTIONS", headers: { origin: ORIGIN } }), env(), reached);
	assert.equal(pre.status, 204);
	assert.match(pre.headers.get("access-control-allow-headers")!, /authorization/);
	const evil = await gate(remote("/jmap/api", { method: "POST", headers: { origin: "https://evil.example", authorization: `Bearer ${GOOD}` } }), env(), reached);
	assert.equal(evil.status, 403);
	assert.equal(evil.headers.get("access-control-allow-origin"), null);
});

test("same-origin responses carry no CORS headers", async () => {
	const res = await gate(req("/jmap/api", { method: "POST", headers: { origin: ORIGIN, cookie: `__Host-mo_session=${GOOD}` } }), env(), reached);
	assert.equal(res.headers.get("access-control-allow-origin"), null);
});

test("a WebSocket can carry the token as a subprotocol", async () => {
	const ws = (protocol: string) => remote("/jmap/ws", { headers: { upgrade: "websocket", origin: ORIGIN, "sec-websocket-protocol": protocol } });
	assert.equal((await gate(ws(`jmap, mailopus.token.${GOOD}`), env(), reached)).status, 200);
	assert.equal((await gate(ws("jmap, mailopus.token.nope"), env(), reached)).status, 401);
});

test("the claim page and claim endpoints need no session, answer the UI origin with CORS, and are rate limited", async () => {
	assert.equal((await gate(remote("/auth/claim"), env(), reached)).status, 200);
	const ui = { origin: ORIGIN, "content-type": "application/json" };
	for (const [path, method] of [["/api/auth/claim", "GET"], ["/api/auth/claim/options", "POST"], ["/api/auth/claim/verify", "POST"]]) {
		const res = await gate(remote(path!, { method, headers: ui }), env(), reached);
		assert.equal(res.status, 200, path);
		assert.equal(res.headers.get("access-control-allow-origin"), ORIGIN, path);
		assert.equal((await gate(remote(path!, { method, headers: ui }), env(false), reached)).status, 429, `${path} limited`);
	}
	const evil = remote("/api/auth/claim/verify", { method: "POST", headers: { origin: "https://evil.example" } });
	assert.equal((await gate(evil, env(), reached)).status, 403, "another site can't claim");
});

test("a missing /_nuxt/ script, asked for by an old cached shell, reloads the page once", async () => {
	const missing = () => new Response("not found", { status: 404 });
	const cookie = "__Host-mo_session=anything";
	const stale = await gate(req("/_nuxt/PrAhD66s.js", { headers: { cookie } }), env(), missing);
	assert.equal(stale.status, 200);
	assert.match(stale.headers.get("content-type")!, /javascript/);
	assert.equal(stale.headers.get("cache-control"), "no-store");
	assert.match(await stale.text(), /location\.reload\(\)/);
	// Anything else missing stays a 404, and nobody without a pass gets the script.
	assert.equal((await gate(req("/_nuxt/entry.css", { headers: { cookie } }), env(), missing)).status, 404);
	assert.equal((await gate(req("/_nuxt/PrAhD66s.js"), env(), missing)).status, 404);
});

test("a Worker built without the UI sends browsers to APP_ORIGIN and still serves data", async () => {
	const { ASSETS: _, ...e } = env() as unknown as Record<string, unknown>;
	const worker = (path: string, headers: Record<string, string> = {}) => new Request(`https://mail.example.com${path}`, { headers });
	for (const path of ["/", "/auth/login", "/mail/inbox", "/manifest.webmanifest"]) {
		const res = await gate(worker(path, { "sec-fetch-mode": "navigate", cookie: "mailopus_pass=1" }), e as unknown as Env, reached);
		assert.equal(res.status, 302, path);
		assert.equal(res.headers.get("location"), `${ORIGIN}/`, path);
	}
	assert.equal((await gate(worker("/_nuxt/app.js"), e as unknown as Env, reached)).status, 404);
	const data = await gate(worker("/jmap/api", { authorization: `Bearer ${GOOD}` }), e as unknown as Env, reached);
	assert.equal(await data.text(), "app");
});
