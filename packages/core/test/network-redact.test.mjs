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
  const { text, redacted, base64Encoded } = redactNetworkBody('{"access_token":"t","tokenCount":3}');
  assert.equal(redacted, true);
  assert.equal(base64Encoded, false);
  const parsed = JSON.parse(text);
  assert.equal(parsed.access_token, "[redacted]");
  assert.equal(parsed.tokenCount, 3);
});

test("redactNetworkBody: JSON session_id", () => {
  const { text, redacted } = redactNetworkBody('{"session_id":"sid","userSessionId":"u","ok":true}');
  assert.equal(redacted, true);
  const parsed = JSON.parse(text);
  assert.equal(parsed.session_id, "[redacted]");
  assert.equal(parsed.userSessionId, "[redacted]");
  assert.equal(parsed.ok, true);
});

test("redactNetworkBody: form-urlencoded secrets", () => {
  const { text, redacted, base64Encoded } = redactNetworkBody("password=x&access_token=y&ok=1");
  assert.equal(redacted, true);
  assert.equal(base64Encoded, false);
  assert.match(text, /password=%5Bredacted%5D|password=\[redacted\]/);
  assert.match(text, /access_token=%5Bredacted%5D|access_token=\[redacted\]/);
  assert.match(text, /ok=1/);
  assert.doesNotMatch(text, /password=x/);
  assert.doesNotMatch(text, /access_token=y/);
});

test("redactNetworkBody: base64 JSON refresh_token returns decoded UTF-8", () => {
  const raw = JSON.stringify({ refresh_token: "r", n: 1 });
  const b64 = Buffer.from(raw, "utf8").toString("base64");
  const { text, redacted, base64Encoded } = redactNetworkBody(b64, { base64Encoded: true });
  assert.equal(redacted, true);
  assert.equal(base64Encoded, false, "decoded payload must clear base64Encoded");
  const parsed = JSON.parse(text);
  assert.equal(parsed.refresh_token, "[redacted]");
  assert.equal(parsed.n, 1);
  assert.notEqual(text, b64);
});

test("redactNetworkBody: clean base64 JSON returns decoded plaintext and clears flag", () => {
  const raw = JSON.stringify({ a: 1, tokenCount: 2 });
  const b64 = Buffer.from(raw, "utf8").toString("base64");
  const { text, redacted, base64Encoded } = redactNetworkBody(b64, { base64Encoded: true });
  assert.equal(redacted, false);
  assert.equal(base64Encoded, false);
  assert.equal(text, raw);
  const parsed = JSON.parse(text);
  assert.equal(parsed.a, 1);
  assert.equal(parsed.tokenCount, 2);
});

test("redactNetworkBody: non-json base64 stays base64", () => {
  const b64 = Buffer.from([0xff, 0x00, 0xfe]).toString("base64");
  const { text, redacted, base64Encoded } = redactNetworkBody(b64, { base64Encoded: true });
  assert.equal(redacted, false);
  assert.equal(base64Encoded, true);
  assert.equal(text, b64);
});

test("redactNetworkBody: plain text unchanged", () => {
  const { text, redacted, base64Encoded } = redactNetworkBody("hello");
  assert.equal(redacted, false);
  assert.equal(base64Encoded, false);
  assert.equal(text, "hello");
});
