// Run: pnpm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { API, MIN_SERVER_API, SERVER, fit, serverApi } from "../shared/api.ts";

test("serverApi reads the level, and a server from before the handshake is 0", () => {
	assert.equal(serverApi({ capabilities: { [SERVER]: { api: 3 } } }), 3);
	assert.equal(serverApi({ capabilities: { "urn:ietf:params:jmap:core": {} } }), 0);
	assert.equal(serverApi({ capabilities: { [SERVER]: { api: "2" } } }), 0, "not an integer");
	assert.equal(serverApi({}), 0);
});

test("fit compares the server's level with the UI's", () => {
	assert.equal(fit(5, 5, 3), "ok");
	assert.equal(fit(4, 5, 3), "behind");
	assert.equal(fit(3, 5, 3), "behind", "the minimum itself is supported");
	assert.equal(fit(2, 5, 3), "unsupported");
	assert.equal(fit(6, 5, 3), "ahead");
});

test("this build drives every server it says it supports", () => {
	assert.ok(MIN_SERVER_API <= API);
	assert.equal(fit(API), "ok");
	assert.notEqual(fit(MIN_SERVER_API), "unsupported");
});
