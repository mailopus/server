import { pushNewNetwork, pushWrongPassword } from "./push.ts";
import { basicAuth, ipPrefix, isAppPasswordPath, lookupAppPassword, lookupSession, readCookie, SESSION_COOKIE, sessionToken, signinFailed, socketTicket } from "./auth.ts";

// Mail and account data: /api/*, /jmap/* and JMAP discovery. Everything else is the UI (the SPA shell, the
// app bundle, sign-in pages). The Worker runs before static assets (wrangler.jsonc: assets.run_worker_first),
// so this sees every request.
export const isDataPath = (path: string) => path.startsWith("/api/") || path.startsWith("/jmap/") || path === "/.well-known/jmap";

// Served straight from static files, skipping Nitro.
export const PRE_AUTH_PAGES = new Set(["/auth/login", "/auth/invite", "/auth/claim", "/auth/recover", "/auth/backend.js", "/robots.txt", "/favicon.ico", "/logo.svg"]);

// The lobby. Anonymous visitors get none of the app: no shell, no bundle. On APP_ORIGIN, / sends them to
// SITE_ORIGIN, the landing page (site/), when that's set. This is obscurity, not auth. The UI holds no mail, and a BYOC customer's session lives on their own
// Worker, which this one can't check without holding a token that reads their mail. So the gate only asks for
// a session cookie or the pass cookie the sign-in pages set (public/auth/backend.js), and checks neither.
// It keeps scanners and crawlers off the bundle. The data paths below keep their real checks.
export const PASS_COOKIE = "mailopus_pass";
const hasPass = (request: Request) => {
	const cookie = request.headers.get("cookie");
	return !!(readCookie(cookie, SESSION_COOKIE) || readCookie(cookie, PASS_COOKIE));
};
// The PWA's own files. Browsers fetch the manifest and the OS fetches icons without cookies, and the
// service worker must stay updatable after a session expires. None of them hold user data.
export const PWA_FILES = new Set([
	"/manifest.webmanifest", "/sw.js",
	"/pwa-64x64.png", "/pwa-192x192.png", "/pwa-512x512.png", "/maskable-icon-512x512.png", "/apple-touch-icon-180x180.png",
]);
export const PRE_AUTH_API = new Set([
	"/api/auth/login/options",
	"/api/auth/login/verify",
	// The authenticator code after the passkey (api/auth/login/totp.post.ts).
	"/api/auth/login/totp",
	"/api/auth/register/options",
	"/api/auth/register/verify",
	// A recovery code and its address open passkey registration (server/api/auth/recover).
	"/api/auth/recover/options",
	"/api/auth/recover/verify",
	// First-run claim (server/lib/claim.ts). Closed once the instance has a user.
	"/api/auth/claim",
	"/api/auth/claim/options",
	"/api/auth/claim/verify",
]);

// Not from a browser, so no session and no Origin. Each checks its own credential in its handler:
// the relay's signature (server/lib/ingest-sig.ts), and the command line's token for plugin calls
// (cliPluginCall in server/lib/plugin-hooks.ts).
export const SIGNED_API = new Set(["/api/ingest", "/api/plugins/call"]);

const SECURITY_HEADERS: Record<string, string> = {
	"X-Robots-Tag": "noindex, nofollow",
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
	"Referrer-Policy": "no-referrer",
	// A year, this host only. Browsers ignore it over plain http, so local runs are unaffected.
	"Strict-Transport-Security": "max-age=31536000",
	// A page opened from a link in a message gets no handle on this window, so it can't navigate it away.
	"Cross-Origin-Opener-Policy": "same-origin",
};

// The SPA shell carries Nuxt's inline config script. Instead of 'unsafe-inline', hash exactly the
// inline scripts this response contains. Message bodies render in srcdoc iframes, which inherit this
// policy, so it also backs up the iframe's own CSP and sandbox.
const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)(?![^>]*type="application\/json")[^>]*>([\s\S]*?)<\/script>/g;

export async function cspFor(html: string): Promise<string> {
	const hashes: string[] = [];
	for (const [, body] of html.matchAll(INLINE_SCRIPT)) {
		const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
		hashes.push(`'sha256-${btoa(String.fromCharCode(...new Uint8Array(d)))}'`);
	}
	return [
		"default-src 'self'",
		`script-src 'self' ${hashes.join(" ")}`.trim(),
		// Mail HTML relies on inline styles; scripts are what matter here.
		"style-src 'self' 'unsafe-inline'",
		// https: is a customer's own Worker: Chrome checks the URL of an image the service worker forwarded
		// there (app/sw.ts). localhost: the same, in local testing. Mail frames add their own stricter policy.
		"img-src 'self' data: https: http://localhost:*",
		"font-src 'self' data:",
		// https: and wss: reach a customer's own Worker, wherever it is (public/auth/backend.js).
		"connect-src 'self' https: wss: http://localhost:* ws://localhost:*",
		"frame-src 'self'",
		"frame-ancestors 'none'",
		"base-uri 'self'",
		"form-action 'self'",
		"object-src 'none'",
	].join("; ");
}

async function withHeaders(res: Response): Promise<Response> {
	// A 304 has no body to hash, and browsers copy a 304's headers onto the cached page, so a CSP
	// here would replace the good one with one that blocks the page's own script. Send none.
	// A response that set its own policy keeps it: an HTML attachment arrives with "sandbox; default-src 'none'"
	// (routes/jmap/download), and hashing its inline scripts here would allow exactly the sender's script.
	const isHtml = res.status !== 304 && !res.headers.has("content-security-policy") && res.headers.get("content-type")?.startsWith("text/html");
	const html = isHtml ? await res.text() : null;
	const out = new Response(html ?? res.body, res);
	for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
	if (html !== null) {
		out.headers.set("Content-Security-Policy", await cspFor(html));
		// Each deploy deletes the previous build's /_nuxt/ files. An iOS home-screen app relaunched after its
		// process was killed restores the page from the HTTP cache as a history navigation, and an old shell
		// there points at scripts that now 404: a white screen. no-store makes it fetch the current shell.
		// no-transform: Cloudflare otherwise injects its Web Analytics beacon into browser requests, which the CSP
		// above blocks (one console error per load), and any edge edit to the HTML would break the script hashes.
		out.headers.set("Cache-Control", "no-store, no-transform");
	}
	return out;
}

const deny = (status: number) => withHeaders(new Response(null, { status }));

// The UI at APP_ORIGIN (mailopus.net) calling a customer's own Worker on another origin. It sends a bearer
// token, never cookies, so no Allow-Credentials.
function cors(res: Response, origin: string): Response {
	const out = new Response(res.body, res);
	out.headers.set("Access-Control-Allow-Origin", origin);
	out.headers.append("Vary", "Origin");
	// Attachment names, for downloads the service worker forwards (app/sw.ts).
	out.headers.set("Access-Control-Expose-Headers", "content-disposition");
	return out;
}


export async function gate(
	request: Request,
	env: Env,
	next: () => Promise<Response> | Response,
): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;

	if (SIGNED_API.has(path)) return request.method === "POST" ? withHeaders(await next()) : deny(405);

	const isSocket = request.headers.get("upgrade")?.toLowerCase() === "websocket";
	const origin = request.headers.get("origin");
	const crossOrigin = !isSocket && origin === env.APP_ORIGIN && url.origin !== env.APP_ORIGIN;
	if (crossOrigin) {
		if (request.method === "OPTIONS") {
			return cors(new Response(null, {
				status: 204,
				headers: {
					"Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, PATCH, DELETE",
					"Access-Control-Allow-Headers": "authorization, content-type",
					"Access-Control-Max-Age": "86400",
				},
			}), origin);
		}
		return cors(await check(request, env, next, url, isSocket), origin);
	}
	return check(request, env, next, url, isSocket);
}

async function check(
	request: Request,
	env: Env,
	next: () => Promise<Response> | Response,
	url: URL,
	isSocket: boolean,
): Promise<Response> {
	const path = url.pathname;

	// An app password (IMAP and SMTP clients, through the imap/ proxy). The Origin checks below exist
	// because browsers attach cookies to cross-site requests; they only attach Basic credentials the
	// user typed into a browser prompt for this origin, and we never send WWW-Authenticate, so no
	// prompt ever appears. Failures count per username: every proxy request comes from one IP.
	const cred = isAppPasswordPath(path) ? basicAuth(request.headers.get("authorization")) : null;
	if (cred) {
		// The imap/ proxy calls from its own address and names the mail app's in x-mailopus-client-ip. It is
		// read only on this branch and stored only when the app password matches: whoever sends it already
		// holds that credential, and all it changes is the network Settings shows for that same password.
		const ip = request.headers.get("x-mailopus-client-ip") ?? request.headers.get("cf-connecting-ip");
		const auth = await lookupAppPassword(env.DB, cred, ip);
		// Told once per new network, at most daily. Awaited so the Worker isn't cut off mid-send; never fails the request.
		if (auth?.newNetwork) await pushNewNetwork(env, auth.userId, auth.newNetwork.name, auth.newNetwork.network).catch((e) => console.warn("push:", (e as Error).message));
		if (auth) return isSocket ? next() : withHeaders(await next());
		// A stale password on another device gets your whole network locked out at the proxy, so say so.
		await pushWrongPassword(env, cred.user).catch((e) => console.warn("push:", (e as Error).message));
		// For Settings. The network comes from the proxy's header, which nothing checks on a failure: shown as reported.
		await signinFailed(env.DB, cred.user, ipPrefix(ip)).catch((e) => console.warn("signin log:", (e as Error).message));
		return deny((await env.AUTH_LIMIT.limit({ key: `app:${cred.user}` })).success ? 401 : 429);
	}

	// Browsers send cookies on cross-site WebSocket handshakes, so Origin is the only thing stopping
	// another site from opening a socket as you (cross-site WebSocket hijacking).
	if (isSocket && request.headers.get("origin") !== env.APP_ORIGIN) return deny(403);

	// Cross-site writes are refused outright, signed in or not (on top of SameSite=Lax).
	if (request.method !== "GET" && request.method !== "HEAD" && request.headers.get("origin") !== env.APP_ORIGIN) {
		return deny(403);
	}

	// A Worker built without the UI (`pnpm build`, a customer's) has no ASSETS binding. Its UI is APP_ORIGIN:
	// a page served here couldn't sign in anyway, since the passkey's RP_ID names APP_ORIGIN's domain.
	const assets = (env as Env & { ASSETS?: Fetcher }).ASSETS;
	if (!assets && !isDataPath(path)) {
		if (request.method === "GET" && request.headers.get("sec-fetch-mode") === "navigate") return withHeaders(Response.redirect(`${env.APP_ORIGIN}/`, 302));
		return deny(404);
	}

	// Straight to the static files: Nitro would answer /auth/login with the SPA shell.
	if (PRE_AUTH_PAGES.has(path) || PWA_FILES.has(path)) return withHeaders(await assets!.fetch(request));

	if (PRE_AUTH_API.has(path)) {
		const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
		if (!(await env.AUTH_LIMIT.limit({ key: ip })).success) return deny(429);
		return withHeaders(await next());
	}

	if (!isDataPath(path)) {
		if (hasPass(request)) {
			const res = await next();
			return withHeaders(res.status === 404 && STALE_CHUNK.test(path) ? staleShell() : res);
		}
		const site = (env as Env & { SITE_ORIGIN?: string }).SITE_ORIGIN;
		if (path === "/" && site && url.origin === env.APP_ORIGIN) return withHeaders(Response.redirect(`${site}/`, 302));
		if (request.method === "GET" && request.headers.get("sec-fetch-mode") === "navigate") return toLogin(url);
		return deny(404);
	}

	// A socket opened with a one-time ticket: liveSocket spends it and answers 401 itself if it's no good.
	// The Origin check above already ran.
	if (isSocket && path === "/jmap/ws" && socketTicket(request.headers)) return next();

	const userId = await lookupSession(env.DB, sessionToken(request.headers));
	// A 101 response carries the socket; copying it into a new Response would drop it.
	if (userId) return isSocket ? next() : withHeaders(await next());

	// Browsers navigating get the login page; everything else gets a bare 401.
	if (request.method === "GET" && request.headers.get("sec-fetch-mode") === "navigate") return toLogin(url);
	return deny(401);
}

// An iOS home-screen app relaunched after its process was killed restores its page as a history navigation,
// and that can come from an HTML shell cached before shells were no-store. That old shell asks for /_nuxt/
// chunks a later deploy deleted, gets 404s and stays white. Answer its missing scripts with one reload, which
// fetches the current shell. sessionStorage keeps it to one reload a minute, so a real 404 can't loop.
const STALE_CHUNK = /^\/_nuxt\/[^/]+\.js$/;
export const STALE_RELOAD =
	'try{var k="mo_stale",t=+sessionStorage.getItem(k)||0;if(Date.now()-t>6e4){sessionStorage.setItem(k,Date.now());location.reload()}}catch(e){}';
const staleShell = () =>
	new Response(STALE_RELOAD, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });

function toLogin(url: URL) {
	const login = new URL("/auth/login", url);
	if (url.pathname !== "/") login.searchParams.set("next", url.pathname + url.search);
	return withHeaders(Response.redirect(login.toString(), 302));
}
