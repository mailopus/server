// Run: pnpm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { deliveredToFromHeaders, deliveryPath } from "../server/utils/mail.ts";

test("Delivered-To headers become a first-hop-first path", () => {
	const head = [
		"Delivered-To: sam@acme.example",
		"Received: by 2002:a05 with SMTP id x;",
		"\tWed, 05 Nov 2026 23:38:00 -0800",
		"X-Forwarded-To: sam@acme.example",
		"Delivered-To: Admin@Client.Example",
		"Delivered-To: admin@client.example",
		"To: admin@client.example",
		"",
		"Delivered-To: body@not.a.header",
	].join("\r\n");
	assert.deepEqual(deliveredToFromHeaders(head), ["admin@client.example", "sam@acme.example"]);
	assert.deepEqual(deliveryPath(["<x@y.com>"]), ["x@y.com"]);
	assert.deepEqual(deliveryPath(["not an address"]), []);
	assert.deepEqual(deliveredToFromHeaders("Subject: hi\n\nbody"), []);
});
