// JMAP Core (RFC 8620): request validation, result references, method dispatch.
// Plain module so tests can run it under Node.

export const CORE = "urn:ietf:params:jmap:core";
export const MAIL = "urn:ietf:params:jmap:mail";
/**
 * Ours: the IMAP UIDs Mailopus already keeps, for the imap/ proxy (Mailbox and Email properties, Email/imapUids).
 * A capability name, not a host: imap/jmap.go asks for this exact string, so it is the same on every instance.
 */
export const IMAP = "https://mailopus.net/jmap/imap";
/** JMAP over WebSocket (RFC 8887), served at /jmap/ws. */
export const WEBSOCKET = "urn:ietf:params:jmap:websocket";
/** EmailSubmission and Identity (RFC 8621 §1.3.2). A standard client lists it in `using` before it sends. */
export const SUBMISSION = "urn:ietf:params:jmap:submission";
export const SUPPORTED = new Set([CORE, MAIL, SUBMISSION, IMAP, WEBSOCKET]);

export const LIMITS = {
	maxSizeUpload: 25_000_000,
	maxConcurrentUpload: 4,
	maxSizeRequest: 10_000_000,
	maxConcurrentRequests: 4,
	maxCallsInRequest: 32,
	maxObjectsInGet: 500,
	maxObjectsInSet: 500,
	collationAlgorithms: ["i;unicode-casemap"],
};

export type Invocation = [string, Record<string, unknown>, string];

/** Thrown by a method; becomes ["error", {type, description}, callId]. */
export class MethodError extends Error {
	type: string;
	constructor(type: string, description?: string) {
		super(description ?? type);
		this.type = type;
	}
}

/** Request-level failure (RFC 8620 §3.6.1); the route turns it into a problem+json response. */
export class RequestError extends Error {
	type: string;
	status: number;
	constructor(type: string, status = 400, description?: string) {
		super(description ?? type);
		this.type = type;
		this.status = status;
	}
}

/** A method may return extra responses under ALSO (e.g. EmailSubmission/set's implicit Email/set). */
export const ALSO = "__also";
export type Method<C> = (args: Record<string, unknown>, ctx: C) => Promise<Record<string, unknown>> | Record<string, unknown>;

/** JSON Pointer evaluation with JMAP's "*" extension (RFC 8620 §3.7). */
export function evalPointer(value: unknown, pointer: string): unknown {
	if (pointer === "") return value;
	if (!pointer.startsWith("/")) throw new MethodError("invalidResultReference", `bad path ${pointer}`);
	const parts = pointer.slice(1).split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
	const walk = (v: unknown, i: number): unknown => {
		if (i === parts.length) return v;
		const key = parts[i]!;
		if (key === "*") {
			if (!Array.isArray(v)) throw new MethodError("invalidResultReference", `"*" on non-array at ${pointer}`);
			// Arrays produced by the rest of the path are flattened into one list.
			return v.flatMap((item) => {
				const r = walk(item, i + 1);
				return Array.isArray(r) ? r : [r];
			});
		}
		if (v === null || typeof v !== "object" || !(key in v)) {
			throw new MethodError("invalidResultReference", `${pointer} not found`);
		}
		return walk((v as Record<string, unknown>)[key], i + 1);
	};
	return walk(value, 0);
}

type ResultRef = { resultOf: string; name: string; path: string };

/** Replaces "#arg": ResultReference entries with values from earlier responses. */
export function resolveRefs(args: Record<string, unknown>, responses: Invocation[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		if (!key.startsWith("#")) {
			out[key] = value;
			continue;
		}
		const plain = key.slice(1);
		if (plain in args) throw new MethodError("invalidArguments", `both ${plain} and ${key} given`);
		const ref = value as ResultRef;
		if (typeof ref?.resultOf !== "string" || typeof ref.name !== "string" || typeof ref.path !== "string") {
			throw new MethodError("invalidResultReference");
		}
		const source = responses.find(([name, , id]) => id === ref.resultOf && name === ref.name);
		if (!source) throw new MethodError("invalidResultReference", `no ${ref.name} response for ${ref.resultOf}`);
		out[plain] = evalPointer(source[1], ref.path);
	}
	return out;
}

export async function dispatch<C>(body: unknown, methods: Record<string, Method<C>>, ctx: C) {
	const req = body as { using?: unknown; methodCalls?: unknown; createdIds?: unknown };
	if (!req || !Array.isArray(req.using) || !Array.isArray(req.methodCalls)) throw new RequestError("urn:ietf:params:jmap:error:notRequest");
	for (const cap of req.using) {
		if (!SUPPORTED.has(cap as string)) throw new RequestError("urn:ietf:params:jmap:error:unknownCapability", 400, String(cap));
	}
	if (req.methodCalls.length > LIMITS.maxCallsInRequest) throw new RequestError("urn:ietf:params:jmap:error:limit", 400, "maxCallsInRequest");

	const responses: Invocation[] = [];
	for (const call of req.methodCalls as Invocation[]) {
		if (!Array.isArray(call) || call.length !== 3 || typeof call[0] !== "string" || typeof call[2] !== "string") {
			throw new RequestError("urn:ietf:params:jmap:error:notRequest");
		}
		const [name, rawArgs, callId] = call;
		const method = methods[name];
		try {
			if (!method) throw new MethodError("unknownMethod");
			const args = resolveRefs(rawArgs ?? {}, responses);
			const { [ALSO]: also, ...result } = await method(args, ctx);
			responses.push([name, result, callId]);
			for (const [n, r] of (also as [string, Record<string, unknown>][] | undefined) ?? []) responses.push([n, r, callId]);
		} catch (e) {
			if (!(e instanceof MethodError)) throw e;
			responses.push(["error", { type: e.type, ...(e.message !== e.type && { description: e.message }) }, callId]);
		}
	}
	return { methodResponses: responses, sessionState: "0" };
}
