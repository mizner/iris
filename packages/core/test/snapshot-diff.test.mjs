import assert from "node:assert/strict";
import { test } from "node:test";
import { diffSnapshots, indexByUid, nodeFingerprint } from "../extension/lib/snapshot-diff.mjs";

test("fingerprint ignores layout and treats value/disabled as identity", () => {
  const a = { uid: "e0", role: "button", name: "Save", tag: "button", value: "", disabled: false };
  const b = { uid: "e0", role: "button", name: "Save", tag: "button", value: "", disabled: false, x: 99 };
  const c = { uid: "e0", role: "button", name: "Saved", tag: "button", value: "", disabled: false };
  assert.equal(nodeFingerprint(a), nodeFingerprint(b));
  assert.notEqual(nodeFingerprint(a), nodeFingerprint(c));
});

test("diff reports added, removed, and changed uids", () => {
  const prev = indexByUid([
    { uid: "e0", role: "link", name: "Home", tag: "a", href: "/" },
    { uid: "e1", role: "button", name: "Save", tag: "button" },
    { uid: "e2", role: "textbox", name: "Email", tag: "input", value: "" },
  ]);
  const next = [
    { uid: "e0", role: "link", name: "Home", tag: "a", href: "/" },
    { uid: "e1", role: "button", name: "Saving…", tag: "button" },
    { uid: "e3", role: "button", name: "Cancel", tag: "button" },
  ];
  const diff = diffSnapshots(prev, next);
  assert.deepEqual(diff.removed, [{ uid: "e2" }]);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.added[0].uid, "e3");
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0].uid, "e1");
  assert.equal(diff.changed[0].name, "Saving…");
});

test("empty previous snapshot treats every node as added", () => {
  const diff = diffSnapshots(new Map(), [{ uid: "e0", role: "button", name: "Ok", tag: "button" }]);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.removed.length, 0);
  assert.equal(diff.changed.length, 0);
});

test("diff cap slices added/removed/changed", () => {
  const prev = indexByUid([{ uid: "old", role: "button", name: "x", tag: "button" }]);
  const next = [
    { uid: "a", role: "button", name: "1", tag: "button" },
    { uid: "b", role: "button", name: "2", tag: "button" },
  ];
  const diff = diffSnapshots(prev, next, { cap: 1 });
  assert.equal(diff.added.length, 1);
  assert.equal(diff.removed.length, 1);
});
