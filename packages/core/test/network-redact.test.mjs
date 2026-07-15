import assert from "node:assert/strict";
import { test } from "node:test";
import {
  redactHeaders,
  redactNetworkBody,
} from "../extension/lib/network-redact.mjs";

test("redactHeaders: authorization", () => {
  const out = redactHeaders({ Authorization: "Bearer x" });
  assert.equal(out.Authorization, "[redacted]");
});

test("redactHeaders: x-amz-credential", () => {
  const out = redactHeaders({ "x-amz-credential": "AKIA" });
  assert.equal(out["x-amz-credential"], "[redacted]");
});

test("redactHeaders: x-session-id", () => {
  const out = redactHeaders({ "x-session-id": "abc" });
  assert.equal(out["x-session-id"], "[redacted]");
});

test("redactHeaders: safe content-type", () => {
  const out = redactHeaders({ "content-type": "application/json" });
  assert.equal(out["content-type"], "application/json");
});

test("redactNetworkBody: JSON access_token", () => {
  const { text, redacted } = redactNetworkBody('{"access_token":"t","tokenCount":3}');
  assert.equal(redacted, true);
  const parsed = JSON.parse(text);
  assert.equal(parsed.access_token, "[redacted]");
  assert.equal(parsed.tokenCount, 3);
});

test("redactNetworkBody: form-urlencoded secrets", () => {
  const { text, redacted } = redactNetworkBody("password=x&access_token=y&ok=1");
  assert.equal(redacted, true);
  assert.match(text, /password=%5Bredacted%5D|password=\[redacted\]/);
  assert.match(text, /access_token=%5Bredacted%5D|access_token=\[redacted\]/);
  assert.match(text, /ok=1/);
  assert.doesNotMatch(text, /password=x/);
  assert.doesNotMatch(text, /access_token=y/);
});

test("redactNetworkBody: base64 JSON refresh_token", () => {
  const raw = JSON.stringify({ refresh_token: "r", n: 1 });
  const b64 = Buffer.from(raw, "utf8").toString("base64");
  const { text, redacted } = redactNetworkBody(b64, { base64Encoded: true });
  assert.equal(redacted, true);
  const parsed = JSON.parse(text);
  assert.equal(parsed.refresh_token, "[redacted]");
  assert.equal(parsed.n, 1);
  assert.notEqual(text, "r");
});

test("redactNetworkBody: plain text unchanged", () => {
  const { text, redacted } = redactNetworkBody("hello");
  assert.equal(redacted, false);
  assert.equal(text, "hello");
});
