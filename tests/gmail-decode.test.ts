// Run: pnpm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeBase64Url } from "../server/lib/gmail.ts";

test("base64url decodes to the same bytes with or without Uint8Array.fromBase64", () => {
	const bytes = new Uint8Array(256).map((_, i) => i);
	const b64url = Buffer.from(bytes).toString("base64url");
	assert.deepEqual([...decodeBase64Url(b64url)], [...bytes]);
	const U = Uint8Array as unknown as { fromBase64?: unknown };
	const native = U.fromBase64;
	U.fromBase64 = undefined;
	try {
		assert.deepEqual([...decodeBase64Url(b64url)], [...bytes]);
	} finally {
		U.fromBase64 = native;
	}
});
