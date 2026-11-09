import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const handoffSource = source.slice(source.indexOf("function irisUserPrompt("), source.indexOf("// --- The profile's own memory"));

function harness({ url = "http://127.0.0.1/", execute, currentUrl, stored = {}, getTab } = {}) {
  const notifications = [];
  const cleared = [];
  const scripts = [];
  const tab = { id: 10, windowId: 1, url };
  const context = vm.createContext({
    URL, console, crypto: { randomUUID },
    setTimeout: (fn) => setImmediate(fn),
    getTabById: getTab || (async () => tab),
    clampNumber: (value, min, max, fallback) => value ?? fallback,
    chrome: {
      storage: { session: {
        get: async () => stored,
        set: async (values) => Object.assign(stored, values),
      } },
      tabs: { get: async () => ({ ...tab, url: currentUrl?.() ?? url }), update: async () => {} },
      windows: { update: async () => {} },
      notifications: { create: async (id, args) => notifications.push(args), clear: async (id) => cleared.push(id) },
      scripting: { executeScript: async (args) => {
        assert.ok(args.args.every((value) => value !== undefined), "executeScript arguments must not contain undefined");
        scripts.push(args);
        return execute ? execute(args) : [{ result: { matched: true } }];
      } },
    },
  });
  vm.runInContext(handoffSource, context);
  return { context, scripts, notifications, cleared, stored, run: async (args) => JSON.parse((await context.toolRequestUser({ message: "[work · b@x.test] Please sign in.", focus: false, ...args })).content) };
}

test("selector waits reject restricted schemes before prompting", async () => {
  for (const url of ["data:text/html,hi", "chrome://settings/", "chrome-extension://other/page", "about:blank"]) {
    const h = harness({ url });
    const result = await h.run({ selector: "#clicked", timeoutMs: 90000 });
    assert.equal(result.status, "unreadable_page");
    assert.ok(result.reason);
    assert.equal(result.location, new URL(url).protocol + (new URL(url).host ? `//${new URL(url).host}` : ""));
    assert.equal(h.scripts.length, 0);
    assert.equal(h.notifications.length, 0);
  }
});

test("file and host permission failures return unreadable_page", async () => {
  for (const url of ["file:///tmp/test.html", "https://unpermitted.example/"]) {
    const h = harness({ url, execute: async () => { throw new Error(`Cannot access contents of url ${url}. Extension manifest must request permission to access this host.`); } });
    assert.equal((await h.run({ text: "ready" })).status, "unreadable_page");
  }
});

test("readable condition succeeds and profile text reaches banner and notification", async () => {
  const h = harness();
  assert.equal((await h.run({ selector: "#clicked" })).status, "condition_met");
  assert.equal(h.notifications[0].message, "[work · b@x.test] Please sign in.");
  assert.equal(h.scripts.find((s) => s.args[3] === "start").args[0], h.notifications[0].message);
});

test("URL-only conditions work on unreadable pages without injection", async () => {
  const h = harness({ url: "data:text/html,ready" });
  assert.equal((await h.run({ urlPattern: "ready" })).status, "condition_met");
  assert.ok(h.scripts.every((s) => s.args[3] === "remove"));
});

test("navigation to an unreadable page terminates selector waits", async () => {
  let polled = false;
  const h = harness({
    currentUrl: () => polled ? "data:text/html,unreadable" : "http://127.0.0.1/",
    execute: async ({ args }) => { if (args[3] === "start") polled = true; return [{ result: {} }]; },
  });
  const result = await h.run({ selector: "#clicked" });
  assert.equal(result.status, "unreadable_page");
  assert.equal(result.location, "data:");
});

test("permission revocation during prompt injection terminates the wait", async () => {
  const h = harness({ execute: async ({ args }) => {
    if (args[3] === "start") throw new Error("Cannot access contents of the page");
    return [{ result: {} }];
  } });
  assert.equal((await h.run({ text: "ready" })).status, "unreadable_page");
});

test("banner DOM renders the prefixed message", () => {
  const h = harness();
  let banner;
  const element = () => ({ style: {}, append(...children) { this.children = children; }, addEventListener() {} });
  h.context.window = {};
  h.context.document = {
    getElementById: () => null,
    createElement: element,
    body: { innerText: "", appendChild: (bar) => { banner = bar; } },
  };
  h.context.irisUserPrompt("[work · b@x.test] Please sign in.", "", "", "start");
  assert.equal(banner.children[0].textContent, "Iris: [work · b@x.test] Please sign in. The agent is waiting; click Done when finished.");
});

test("transient navigation injection errors keep waiting", async () => {
  let attempts = 0;
  const h = harness({ execute: async ({ args }) => {
    if (args[3] !== "remove" && attempts++ < 2) throw new Error("The frame was removed.");
    return [{ result: { matched: true } }];
  } });
  assert.equal((await h.run({ selector: "#clicked" })).status, "condition_met");
});

test("a matching URL wins over unreadable alternative page conditions", async () => {
  const h = harness({ url: "data:text/html,ready" });
  assert.equal((await h.run({ urlPattern: "ready", selector: "#clicked" })).status, "condition_met");
  assert.ok(h.scripts.every((s) => s.args[3] === "remove"));
});

test("text checks exclude the banner profile and instructions", () => {
  const h = harness();
  let banner;
  const element = () => ({ style: {}, append(...children) { this.children = children; }, addEventListener() {} });
  h.context.window = {};
  h.context.document = {
    getElementById: () => banner,
    createElement: element,
    body: {
      get innerText() { return banner && banner.style.display !== "none" ? banner.children[0].textContent : "Not signed in"; },
      appendChild: (bar) => { banner = bar; },
    },
  };
  assert.equal(h.context.irisUserPrompt("[work · b@x.test] Please sign in.", "", "b@x.test", "start").matched, false);
  assert.equal(banner.style.display, undefined);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("cancellation waits for pending injection and final cleanup, and is idempotent", async () => {
  const started = deferred();
  const injection = deferred();
  const removed = deferred();
  const cleanup = deferred();
  const h = harness({ execute: async ({ args }) => {
    if (args[3] === "start") { started.resolve(); await injection.promise; }
    if (args[3] === "remove") { removed.resolve(); await cleanup.promise; }
    return [{ result: {} }];
  } });
  const waiting = h.run({ requestId: "pending", tabId: 10 });
  await started.promise;
  assert.equal(h.stored["iris.activeHandoffs"][0].requestId, "pending");
  let settled = false;
  const cancellation = h.context.toolRequestCancel({ requestId: "pending", tabId: 10 }).then((result) => { settled = true; return result; });
  await Promise.resolve();
  assert.equal(settled, false);
  injection.resolve();
  await removed.promise;
  assert.equal(settled, false);
  cleanup.resolve();
  assert.equal((await waiting).status, "cancelled");
  assert.equal(JSON.parse((await cancellation).content).status, "cancelled");
  assert.deepEqual(h.cleared, ["iris-handoff-pending"]);
  assert.equal(h.stored["iris.activeHandoffs"].length, 0);
  assert.equal(JSON.parse((await h.context.toolRequestCancel({ requestId: "pending", tabId: 10 })).content).status, "cancelled");
});

test("cancellation before tab lookup finishes never displays a prompt", async () => {
  const tab = deferred();
  const h = harness({ getTab: () => tab.promise });
  const waiting = h.run({ requestId: "early", tabId: 10 });
  const cancellation = h.context.toolRequestCancel({ requestId: "early", tabId: 10 });
  tab.resolve({ id: 10, windowId: 1, url: "https://example.test/" });
  assert.equal((await waiting).status, "cancelled");
  await cancellation;
  assert.equal(h.notifications.length, 0);
  assert.equal(h.scripts.length, 0);
});

test("worker startup removes persisted orphan banners and notifications before new requests", async () => {
  const stored = { "iris.activeHandoffs": [{ requestId: "orphan", tabId: 77 }] };
  const h = harness({ stored });
  await vm.runInContext("handoffStartupCleanup", h.context);
  assert.equal(h.scripts[0].target.tabId, 77);
  assert.equal(h.scripts[0].args[3], "remove");
  assert.equal(h.scripts[0].args[4], "orphan");
  assert.deepEqual(h.cleared, ["iris-handoff-orphan"]);
  assert.equal(stored["iris.activeHandoffs"].length, 0);
  assert.equal((await h.run({ requestId: "fresh" })).status, "condition_met");
});

test("disconnect cancels active waits and clears persisted state", async () => {
  const started = deferred();
  const h = harness({ execute: async ({ args }) => {
    if (args[3] === "start") started.resolve();
    return [{ result: {} }];
  } });
  const waiting = h.run({ requestId: "disconnect", tabId: 10 });
  await started.promise;
  await h.context.cancelAllUserRequests("disconnected");
  const result = await waiting;
  assert.equal(result.status, "cancelled");
  assert.equal(result.reason, "disconnected");
  assert.equal(result.url, "http://127.0.0.1/");
  assert.equal(h.stored["iris.activeHandoffs"].length, 0);
  assert.deepEqual(h.cleared, ["iris-handoff-disconnect"]);
});

test("removed or expired page requests cannot reinsert banners", () => {
  const h = harness();
  let banner;
  let watchdog;
  const element = () => ({ style: {}, append() {}, addEventListener() {}, remove() { banner = undefined; } });
  h.context.window = { clearTimeout() {}, setTimeout(fn) { watchdog = fn; } };
  h.context.document = {
    getElementById: () => banner,
    createElement: element,
    body: { appendChild(bar) { banner = bar; } },
  };
  const prompt = (mode, id, lease = Date.now() + 15000) => h.context.irisUserPrompt("Sign in", "", "", mode, id, lease);
  prompt("start", "cancelled");
  assert.ok(banner);
  prompt("remove", "cancelled");
  prompt("start", "cancelled");
  assert.equal(banner, undefined);
  prompt("start", "expired", Date.now() - 1);
  assert.equal(banner, undefined);
  prompt("start", "crashed");
  assert.ok(banner);
  watchdog();
  assert.equal(banner, undefined);
  prompt("poll", "crashed");
  assert.equal(banner, undefined);
});

test("cancel before request dispatch tombstones the internal request ID", async () => {
  const h = harness();
  await h.context.toolRequestCancel({ requestId: "not-started", tabId: 10 });
  const before = h.scripts.length;
  assert.equal((await h.run({ requestId: "not-started", tabId: 10 })).status, "cancelled");
  assert.equal(h.notifications.length, 0);
  assert.equal(h.scripts.length, before);
});

test("concurrent blocking and async requests cannot steal the same tab", async () => {
  const started = deferred();
  const h = harness({ execute: async ({ args }) => {
    if (args[3] === "start") started.resolve();
    return [{ result: {} }];
  } });
  const first = h.run({ requestId: "first", tabId: 10 });
  await started.promise;
  await assert.rejects(h.run({ tabId: 10 }), /already active on this tab/);
  assert.equal(h.notifications.length, 1);
  assert.equal(h.scripts.some((script) => script.args[3] === "remove"), false);
  await h.context.toolRequestCancel({ requestId: "first", tabId: 10 });
  assert.equal((await first).status, "cancelled");
});

test("cancellation rejects a mismatched tab without affecting the active wait", async () => {
  const started = deferred();
  const h = harness({ execute: async ({ args }) => {
    if (args[3] === "start") started.resolve();
    return [{ result: {} }];
  } });
  const waiting = h.run({ requestId: "owned", tabId: 10 });
  await started.promise;
  await assert.rejects(h.context.toolRequestCancel({ requestId: "owned", tabId: 11 }), /does not match tabId/);
  await h.context.toolRequestCancel({ requestId: "owned", tabId: 10 });
  assert.equal((await waiting).status, "cancelled");
});

test("probe and cleanup injections use serializable default arguments", async () => {
  const h = harness();
  assert.equal((await h.run({ requestId: "serialized", selector: "#ready" })).status, "condition_met");
  const probe = h.scripts.find((script) => script.args[3] === "probe");
  const cleanup = h.scripts.find((script) => script.args[3] === "remove");
  assert.ok(probe);
  assert.ok(cleanup);
  assert.equal(probe.args[4], "");
  assert.equal(probe.args[5], 0);
  assert.equal(cleanup.args[4], "serialized");
  assert.equal(cleanup.args[5], 0);
});
