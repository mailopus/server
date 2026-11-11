// The Worker: authenticates the caller, then hands the headers to classify(). Rules live in rules.ts.
import { MAX_RULE_NAME, parseRequest } from "./protocol.ts";
import { classify } from "./rules.ts";

export type Env = { CLASSIFIER_KEY?: string };

const sha256 = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

/** Compares hashes, so the comparison takes the same time however much of the key is right. */
async function authorized(header: string | null, key: string | undefined): Promise<boolean> {
	const given = header?.match(/^Bearer (\S+)$/)?.[1];
	if (!key || !given) return false;
	const [a, b] = await Promise.all([sha256(given), sha256(key)]);
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
	return diff === 0;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (new URL(request.url).pathname !== "/v1/check") return new Response("not found\n", { status: 404 });
		if (request.method !== "POST") return new Response(null, { status: 405 });
		if (!(await authorized(request.headers.get("authorization"), env.CLASSIFIER_KEY))) return new Response(null, { status: 401 });
		const req = parseRequest(await request.json().catch(() => null));
		if (!req) return new Response(null, { status: 400 });
		const rule = classify(req.headers, req.ctx);
		if (rule !== null && (rule.length === 0 || rule.length > MAX_RULE_NAME)) throw new Error(`rule name not usable: ${rule}`);
		return Response.json({ rule });
	},
} satisfies ExportedHandler<Env>;
