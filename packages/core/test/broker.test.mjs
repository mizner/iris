import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const BROKER_PATH = path.resolve("packages/core/bin/broker.cjs");

function writeJsonLine(socket, message) {
  socket.write(`${JSON.stringify(message)}\n`);
}

function createJsonLineParser(onMessage) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.toString("utf8");
    while (true) {
      const index = buffer.indexOf("\n");
      if (index === -1) return;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      onMessage(JSON.parse(line));
    }
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSocket(socketPath) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath);
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", reject);
      });
      return;
    } catch {
      await wait(25);
    }
  }
  throw new Error(`Timed out waiting for broker socket: ${socketPath}`);
}

const TEST_CONFIG = {
  profileEmails: [],
  profiles: {
    home: { email: "a@x.test", purpose: "Personal", domains: ["home.example"], default: true },
    work: { email: "b@x.test", purpose: "Work admin", domains: ["work.example"] },
  },
};

async function startBroker(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "iris-broker-"));
  const socketPath = path.join(dir, "broker.sock");
  const configPath = path.join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify(TEST_CONFIG));
  const child = spawn(process.execPath, [BROKER_PATH], {
    env: {
      ...process.env,
      IRIS_BROKER_SOCK: socketPath,
      IRIS_CONFIG_PATH: configPath,
      IRIS_DECISION: "off",
      IRIS_PING_INTERVAL_MS: "150",
      IRIS_PONG_TIMEOUT_MS: "400",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const logs = [];
  child.stdout.on("data", (chunk) => logs.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString("utf8")));

  t.after(() => {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  await waitForSocket(socketPath);

  function makeClient(hello) {
    const socket = net.createConnection(socketPath);
    socket.setNoDelay(true);
    const messages = [];
    const waiters = [];
    const closed = new Promise((resolve) => socket.once("close", resolve));

    const push = (message) => {
      messages.push(message);
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        const waiter = waiters[index];
        if (waiter.filter(message)) {
          waiters.splice(index, 1);
          clearTimeout(waiter.timeout);
          waiter.resolve(message);
        }
      }
    };

    socket.on("data", createJsonLineParser(push));
    socket.once("connect", () => writeJsonLine(socket, hello));

    return {
      socket,
      closed,
      messages,
      write(message) {
        writeJsonLine(socket, message);
      },
      nextMessage(filter, timeoutMs = 1500) {
        const existing = messages.find(filter);
        if (existing) return Promise.resolve(existing);
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
            if (index !== -1) waiters.splice(index, 1);
            reject(new Error("Timed out waiting for broker message"));
          }, timeoutMs);
          waiters.push({ filter, resolve, timeout });
        });
      },
      destroy() {
        socket.destroy();
      },
    };
  }

  async function makeHost(pid, { pong = true, profileId, allowed = true, handler } = {}) {
    const host = makeClient({ type: "hello", role: "native-host", pid });
    host.pong = pong;
    host.socket.on(
      "data",
      createJsonLineParser((message) => {
        if (message?.type === "to_extension" && message.message?.type === "ping" && host.pong) {
          host.write({ type: "from_extension", message: { type: "pong" } });
        }
        if (handler && message?.type === "to_extension" && message.message?.type === "tool_request") {
          const { id, tool, args } = message.message;
          Promise.resolve()
            .then(() => handler(tool, args))
            .then(
              (result) => host.write({ type: "from_extension", message: { type: "tool_response", id, result } }),
              (err) => host.write({ type: "from_extension", message: { type: "tool_response", id, error: { content: err.message } } })
            );
        }
      })
    );
    await host.nextMessage((message) => message.type === "host_ready");
    if (profileId) {
      host.write({ type: "from_extension", message: { type: "identify", profileId, allowed } });
    }
    return host;
  }

  // Identify messages arrive on host sockets; wait until the broker reports them before routing.
  async function waitForProfiles(client, expected) {
    const deadline = Date.now() + 3000;
    let requestId = 9000;
    while (Date.now() < deadline) {
      const status = await request(client, requestId++, "status");
      const seen = status.data.hosts.filter((h) => h.profileId).length;
      if (seen >= expected) return status;
    }
    throw new Error(`Timed out waiting for ${expected} identified hosts`);
  }

  function makePlugin(sessionId = "session-test") {
    return makeClient({ type: "hello", role: "plugin", sessionId });
  }

  async function request(client, id, op, extra = {}) {
    client.write({ type: "request", id, op, ...extra });
    return await client.nextMessage((message) => message.type === "response" && message.id === id);
  }

  return { child, logs, makeClient, makeHost, makePlugin, request, waitForProfiles };
}

function toolRequests(host, tool) {
  return host.messages.filter(
    (m) => m?.type === "to_extension" && m.message?.type === "tool_request" && m.message.tool === tool
  );
}

function tabsHandler(tabs, summary = {}) {
  return (tool, args) => {
    if (tool === "get_tabs") return { content: JSON.stringify(tabs) };
    if (tool === "profile_summary") return { content: { tabCount: tabs.length, windowCount: 1, domains: [], ...summary } };
    if (tool === "open_tab") return { tabId: 500 + tabs.length, content: { tabId: 500 + tabs.length } };
    return { tabId: args.tabId, content: `${tool} ok` };
  };
}

function isToolRequest(tool) {
  return (message) => message?.type === "to_extension" && message.message?.type === "tool_request" && message.message.tool === tool;
}

test("orphan host remains connected when newer host closes", async (t) => {
  const broker = await startBroker(t);
  await broker.makeHost(101, { pong: true });
  const hostB = await broker.makeHost(102, { pong: true });
  hostB.destroy();
  await hostB.closed;

  const plugin = broker.makePlugin();
  const status = await broker.request(plugin, 1, "status");

  assert.equal(status.ok, true);
  assert.equal(status.data.hostConnected, true);
  assert.equal(status.data.hostCount, 1);
});

test("unresponsive host is reaped", async (t) => {
  const broker = await startBroker(t);
  const host = await broker.makeHost(201, { pong: false });

  await host.closed;
  const plugin = broker.makePlugin();
  const status = await broker.request(plugin, 1, "status");

  assert.equal(status.ok, true);
  assert.equal(status.data.hostConnected, false);
});

test("pending requests reject per host and a pinned session never falls over to another profile", async (t) => {
  const broker = await startBroker(t);
  const hostA = await broker.makeHost(301, { profileId: "a@x.test" });
  const hostB = await broker.makeHost(302, { profileId: "b@x.test" });
  const plugin = broker.makePlugin();
  await broker.waitForProfiles(plugin, 2);

  const pinned = await broker.request(plugin, 1, "use_profile", { profile: "work" });
  assert.equal(pinned.ok, true);
  assert.equal(pinned.data.profile, "work");

  plugin.write({ type: "request", id: 2, op: "tool", tool: "get_tabs", args: {} });
  await hostB.nextMessage(isToolRequest("get_tabs"));
  hostB.destroy();
  const rejected = await plugin.nextMessage((message) => message.type === "response" && message.id === 2);
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /Native host disconnected/);

  const next = await broker.request(plugin, 3, "tool", { tool: "get_tabs", args: {} });
  assert.equal(next.ok, false);
  assert.match(next.error, /^PROFILE_NOT_CONNECTED: .*work/);
  assert.equal(toolRequests(hostA, "get_tabs").length, 0, "must not silently switch to another profile");
});

test("routing prefers older healthy host when newest host stops ponging", async (t) => {
  const broker = await startBroker(t);
  const hostA = await broker.makeHost(401, { pong: true });
  const hostB = await broker.makeHost(402, { pong: true });
  hostB.pong = false;

  await hostB.closed;
  const plugin = broker.makePlugin();
  plugin.write({ type: "request", id: 1, op: "tool", tool: "get_tabs", args: {} });

  const hostARequest = await hostA.nextMessage(isToolRequest("get_tabs"));
  assert.equal(hostARequest.message.tool, "get_tabs");
});

test("extension reload fans out to every healthy host", async (t) => {
  const broker = await startBroker(t);
  const hostA = await broker.makeHost(501, { pong: true });
  const hostB = await broker.makeHost(502, { pong: true });
  const plugin = broker.makePlugin();

  plugin.write({ type: "request", id: 1, op: "extension_reload" });

  const reloadA = await hostA.nextMessage((message) => message?.type === "to_extension" && message.message?.type === "reload");
  const reloadB = await hostB.nextMessage((message) => message?.type === "to_extension" && message.message?.type === "reload");
  const response = await plugin.nextMessage((message) => message.type === "response" && message.id === 1);

  assert.equal(reloadA.message.type, "reload");
  assert.equal(reloadB.message.type, "reload");
  assert.equal(response.ok, true);
  assert.deepEqual(response.data, { ok: true, sent: 2 });
});

test("stale host is unhealthy in status before the socket is reaped", async (t) => {
  const broker = await startBroker(t);
  const host = await broker.makeHost(601, { pong: false });
  const plugin = broker.makePlugin();

  // PONG_TIMEOUT_MS=400 in startBroker env. Poll the window after lastPong
  // goes stale but before the next interval tick destroys the socket.
  // Unique request ids required: nextMessage returns the first cached match.
  let sawUnhealthyWhileRegistered = false;
  let requestId = 1;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const status = await broker.request(plugin, requestId, "status");
    requestId += 1;
    assert.equal(status.ok, true);
    if (status.data.hostConnected === false && status.data.hostCount === 1) {
      assert.ok(status.data.hosts[0].lastPongAgoMs > 400);
      sawUnhealthyWhileRegistered = true;
      break;
    }
    if (status.data.hostCount === 0) {
      break; // destroyed first; fail below — window missed
    }
    await wait(25);
  }

  assert.equal(
    sawUnhealthyWhileRegistered,
    true,
    "expected hostConnected=false with hostCount=1 while socket still registered (healthyHosts pong filter)",
  );
});

test("tool without tabId works in a background session tab, not the user's active tab", async (t) => {
  const broker = await startBroker(t);
  const host = await broker.makeHost(701, {
    handler: (tool, args) => {
      if (tool === "open_tab") return { tabId: 99, content: { tabId: 99 } };
      if (tool === "click") return { tabId: args.tabId, content: "Clicked #go" };
      throw new Error(`unexpected tool ${tool}`);
    },
  });
  const plugin = broker.makePlugin("session-background-tab");

  const first = await broker.request(plugin, 1, "tool", { tool: "click", args: { selector: "#go" }, sessionId: "session-background-tab" });
  assert.equal(first.ok, true);
  const second = await broker.request(plugin, 2, "tool", { tool: "click", args: { selector: "#go" }, sessionId: "session-background-tab" });
  assert.equal(second.ok, true);

  assert.equal(toolRequests(host, "get_active_tab").length, 0, "must not read or take over the active tab");
  const opens = toolRequests(host, "open_tab");
  assert.equal(opens.length, 1, "second call reuses the session tab");
  assert.equal(opens[0].message.args.active, false);
  assert.deepEqual(toolRequests(host, "click").map((m) => m.message.args.tabId), [99, 99]);
});

test("a closed session tab is replaced; a closed explicit tab fails with TAB_NOT_FOUND and is forgotten", async (t) => {
  const broker = await startBroker(t);
  let nextTab = 40;
  const closed = new Set();
  const host = await broker.makeHost(702, {
    handler: (tool, args) => {
      if (tool === "open_tab") return { tabId: ++nextTab, content: { tabId: nextTab } };
      if (closed.has(args.tabId)) throw new Error(`TAB_NOT_FOUND: Tab ${args.tabId} no longer exists`);
      return { tabId: args.tabId, content: `${tool} ok` };
    },
  });
  const plugin = broker.makePlugin("session-stale-tab");
  const call = (id, args) => broker.request(plugin, id, "tool", { tool: "click", args, sessionId: "session-stale-tab" });

  assert.equal((await call(1, { selector: "#a" })).ok, true);
  closed.add(41);
  const recovered = await call(2, { selector: "#a" });
  assert.equal(recovered.ok, true, "implicit session tab is replaced transparently");
  assert.deepEqual(toolRequests(host, "click").map((m) => m.message.args.tabId), [41, 41, 42]);

  closed.add(42);
  const explicit = await call(3, { selector: "#a", tabId: 42 });
  assert.equal(explicit.ok, false);
  assert.match(explicit.error, /TAB_NOT_FOUND/);
  const claims = await broker.request(plugin, 4, "list_claims");
  assert.equal(claims.data.claims.some((c) => c.tabId === 42), false, "closed tab claim is released");
});

test("tab groups are named from the site, then the agent's name, with the harness; claims show the owner", async (t) => {
  const broker = await startBroker(t);
  const host = await broker.makeHost(703, {
    handler: (tool, args) => {
      if (tool === "open_tab") return { tabId: 70, content: { tabId: 70 } };
      if (tool === "name_group") return { content: { title: args.title, groups: [9] } };
      return { tabId: args.tabId, content: `${tool} ok` };
    },
  });
  const plugin = broker.makeClient({ type: "hello", role: "plugin", sessionId: "session-named", harness: "omo", project: "iris" });
  const tool = (id, name, args) => broker.request(plugin, id, "tool", { tool: name, args, sessionId: "session-named" });

  assert.equal((await tool(1, "open_tab", { url: "https://app.codeable.io/tasks/1" })).ok, true);
  assert.equal(toolRequests(host, "open_tab")[0].message.args.group, "codeable · omo");

  const named = await broker.request(plugin, 2, "name_group", { name: "Neverland venue quote", color: "blue" });
  assert.equal(named.ok, true);
  assert.equal(named.data.title, "Neverland venue quote · omo");
  const rename = toolRequests(host, "name_group")[0].message.args;
  assert.deepEqual([rename.tabIds, rename.title, rename.color], [[70], "Neverland venue quote · omo", "blue"]);

  const claims = (await broker.request(plugin, 3, "list_claims")).data.claims;
  assert.deepEqual(
    claims.map((c) => [c.tabId, c.harness, c.project, c.group]),
    [[70, "omo", "iris", "Neverland venue quote · omo"]]
  );
  assert.equal((await broker.request(plugin, 4, "name_group", { name: "x", color: "magenta" })).ok, false, "unknown color is rejected");
});

test("claim_tab broadcasts claims to the extension host", async (t) => {
  const broker = await startBroker(t);
  const host = await broker.makeHost(801, { pong: true });
  const plugin = broker.makePlugin("session-claims");

  const claimed = await broker.request(plugin, 1, "claim_tab", { tabId: 55 });
  assert.equal(claimed.ok, true);

  const update = await host.nextMessage(
    (m) => m?.type === "to_extension" && m.message?.type === "claims" && m.message.claims.some((c) => c.tabId === 55),
    2000
  );
  const owned = update.message.claims.find((c) => c.tabId === 55);
  assert.ok(owned);
  assert.equal(owned.sessionId, claimed.data.sessionId);
});

test("extension release_tab force-releases a claimed tab", async (t) => {
  const broker = await startBroker(t);
  const host = await broker.makeHost(802, { pong: true });
  const plugin = broker.makePlugin("session-steal");

  await broker.request(plugin, 1, "claim_tab", { tabId: 88 });
  const before = host.messages.length;
  host.write({ type: "from_extension", message: { type: "release_tab", tabId: 88 } });

  const deadline = Date.now() + 2000;
  let released = false;
  while (Date.now() < deadline) {
    const later = host.messages.slice(before);
    released = later.some(
      (m) => m?.type === "to_extension" && m.message?.type === "claims" && !m.message.claims.some((c) => c.tabId === 88)
    );
    if (released) break;
    await wait(25);
  }
  assert.equal(released, true);

  const status = await broker.request(plugin, 2, "status");
  assert.equal(status.data.claims.length, 0);
});

test("ping payload includes current claims", async (t) => {
  const broker = await startBroker(t);
  const host = await broker.makeHost(803, { pong: true });
  const plugin = broker.makePlugin("session-ping-claims");
  await broker.request(plugin, 1, "claim_tab", { tabId: 91 });

  const ping = await host.nextMessage(
    (m) => m?.type === "to_extension" && m.message?.type === "ping" && Array.isArray(m.message.claims),
    2000
  );
  assert.ok(ping.message.claims.some((c) => c.tabId === 91));
});

test("several connected profiles and no choice is an error, not a guess", async (t) => {
  const broker = await startBroker(t);
  const hostA = await broker.makeHost(901, { profileId: "a@x.test", handler: tabsHandler([]) });
  const hostB = await broker.makeHost(902, { profileId: "b@x.test", handler: tabsHandler([]) });
  const plugin = broker.makePlugin("session-ambiguous");
  await broker.waitForProfiles(plugin, 2);

  const response = await broker.request(plugin, 1, "tool", { tool: "click", args: { selector: "#go" } });
  assert.equal(response.ok, false);
  assert.match(response.error, /^PROFILE_REQUIRED: 2 Chrome profiles are connected \((home, work|work, home)\)/);
  assert.equal(toolRequests(hostA, "click").length + toolRequests(hostB, "click").length, 0);
  assert.equal(toolRequests(hostA, "open_tab").length + toolRequests(hostB, "open_tab").length, 0);
});

test("get_tabs without a profile lists every profile's tabs, labeled by profile", async (t) => {
  const broker = await startBroker(t);
  await broker.makeHost(911, { profileId: "a@x.test", handler: tabsHandler([{ id: 101, url: "https://home.example/" }]) });
  await broker.makeHost(912, { profileId: "b@x.test", handler: tabsHandler([{ id: 202, url: "https://work.example/" }]) });
  const plugin = broker.makePlugin("session-fanout");
  await broker.waitForProfiles(plugin, 2);

  const response = await broker.request(plugin, 1, "tool", { tool: "get_tabs", args: {} });
  assert.equal(response.ok, true);
  const tabs = JSON.parse(response.data.content).sort((a, b) => a.id - b.id);
  assert.deepEqual(tabs.map((tab) => [tab.id, tab.profile]), [[101, "home"], [202, "work"]]);
});

test("history search without a profile searches every profile and labels results", async (t) => {
  const broker = await startBroker(t);
  const history = (url) => (tool) =>
    tool === "search_history" ? { content: JSON.stringify([{ url, title: "t" }]) } : tabsHandler([])(tool, {});
  await broker.makeHost(913, { profileId: "a@x.test", handler: history("https://home.example/") });
  await broker.makeHost(914, { profileId: "b@x.test", handler: history("https://work.example/") });
  const plugin = broker.makePlugin("session-history");
  await broker.waitForProfiles(plugin, 2);

  const response = await broker.request(plugin, 1, "tool", { tool: "search_history", args: { query: "example" } });
  assert.equal(response.ok, true);
  const rows = JSON.parse(response.data.content).sort((a, b) => a.url.localeCompare(b.url));
  assert.deepEqual(rows.map((row) => [row.url, row.profile]), [["https://home.example/", "home"], ["https://work.example/", "work"]]);
});

test("a tab opened by a claimed tab is claimed for that session and reported once", async (t) => {
  const broker = await startBroker(t);
  const host = await broker.makeHost(915, {
    handler: (tool, args) => {
      if (tool === "open_tab") return { tabId: 60, content: { tabId: 60 } };
      return { tabId: args.tabId, content: `${tool} ok` };
    },
  });
  const plugin = broker.makePlugin("session-popup");
  const call = (id) => broker.request(plugin, id, "tool", { tool: "click", args: { selector: "#login" }, sessionId: "session-popup" });

  assert.equal((await call(1)).ok, true);
  host.write({ type: "from_extension", message: { type: "tab_opened", tabId: 61, openerTabId: 60, url: "https://auth.example/", windowType: "popup" } });
  host.write({ type: "from_extension", message: { type: "tab_opened", tabId: 99, openerTabId: 12345, url: "https://other/" } });

  const deadline = Date.now() + 2000;
  let claims = [];
  while (Date.now() < deadline) {
    claims = (await broker.request(plugin, 100 + claims.length, "list_claims")).data.claims;
    if (claims.some((c) => c.tabId === 61)) break;
  }
  assert.ok(claims.some((c) => c.tabId === 61), "popup is claimed by the opener's session");
  assert.equal(claims.some((c) => c.tabId === 99), false, "tabs opened by unclaimed tabs are ignored");

  const next = await call(2);
  assert.deepEqual(next.data.openedTabs, [{ tabId: 61, openerTabId: 60, url: "https://auth.example/", popup: true }]);
  const after = await call(3);
  assert.equal(after.data.openedTabs, undefined, "reported only once");
});

test("explicit profile routes to that profile and pins the session", async (t) => {
  const broker = await startBroker(t);
  const hostA = await broker.makeHost(921, { profileId: "a@x.test", handler: tabsHandler([]) });
  const hostB = await broker.makeHost(922, { profileId: "b@x.test", handler: tabsHandler([]) });
  const plugin = broker.makePlugin("session-explicit");
  await broker.waitForProfiles(plugin, 2);

  const opened = await broker.request(plugin, 1, "tool", { tool: "open_tab", args: { url: "https://work.example/", profile: "work" } });
  assert.equal(opened.ok, true);
  assert.equal(opened.data.profile, "work");
  assert.equal(opened.data.content.profile, "work");

  const followUp = await broker.request(plugin, 2, "tool", { tool: "get_tabs", args: {} });
  assert.equal(followUp.ok, true);
  assert.equal(toolRequests(hostB, "get_tabs").length, 1);
  assert.equal(toolRequests(hostA, "get_tabs").length, 0, "pinned session reads only its own profile");

  const status = await broker.request(plugin, 3, "status");
  assert.equal(status.data.session.profile, "work");
});

test("a tabId routes to the profile that owns the tab", async (t) => {
  const broker = await startBroker(t);
  const hostA = await broker.makeHost(931, { profileId: "a@x.test", handler: tabsHandler([{ id: 101, url: "https://home.example/" }]) });
  const hostB = await broker.makeHost(932, { profileId: "b@x.test", handler: tabsHandler([{ id: 202, url: "https://work.example/" }]) });
  const plugin = broker.makePlugin("session-tab-owner");
  await broker.waitForProfiles(plugin, 2);

  const response = await broker.request(plugin, 1, "tool", { tool: "query", args: { tabId: 202, mode: "page_text" } });
  assert.equal(response.ok, true);
  assert.equal(response.data.profile, "work");
  assert.equal(toolRequests(hostB, "query").length, 1);
  assert.equal(toolRequests(hostA, "query").length, 0);
});

test("a profile outside the allowlist is never a routing candidate", async (t) => {
  const broker = await startBroker(t);
  const hostA = await broker.makeHost(941, { profileId: "a@x.test", handler: tabsHandler([]) });
  const blocked = await broker.makeHost(942, { profileId: "c@x.test", allowed: false, handler: tabsHandler([]) });
  const plugin = broker.makePlugin("session-allowlist");
  await broker.waitForProfiles(plugin, 2);

  const response = await broker.request(plugin, 1, "tool", { tool: "get_tabs", args: {} });
  assert.equal(response.ok, true);
  assert.equal(response.data.profile, "home");
  assert.equal(toolRequests(hostA, "get_tabs").length, 1);
  assert.equal(toolRequests(blocked, "get_tabs").length, 0);
});

test("profiles lists configured and connected profiles with their open sites", async (t) => {
  const broker = await startBroker(t);
  await broker.makeHost(951, { profileId: "a@x.test", handler: tabsHandler([], { domains: [{ host: "home.example", count: 2 }] }) });
  const plugin = broker.makePlugin("session-inventory");
  await broker.waitForProfiles(plugin, 1);

  const response = await broker.request(plugin, 1, "profiles");
  assert.equal(response.ok, true);
  const byName = Object.fromEntries(response.data.profiles.map((p) => [p.profile, p]));
  assert.equal(byName.home.connected, true);
  assert.deepEqual(byName.home.openSites, ["home.example"]);
  assert.equal(byName.home.default, true);
  assert.equal(byName.work.connected, false);
  assert.equal(response.data.connectedCount, 1);
  assert.equal(response.data.decisionModel.available, false);
});

test("resolve_profile prefers the profile where the site is already open, then pins it", async (t) => {
  const broker = await startBroker(t);
  await broker.makeHost(961, {
    profileId: "a@x.test",
    handler: tabsHandler([{ id: 101, url: "https://home.example/" }], { domains: [{ host: "home.example", count: 1 }] }),
  });
  await broker.makeHost(962, {
    profileId: "b@x.test",
    handler: tabsHandler([{ id: 202, url: "https://portal.azure.example/billing", title: "Billing" }], {
      domains: [{ host: "portal.azure.example", count: 1 }],
    }),
  });
  const plugin = broker.makePlugin("session-resolve");
  await broker.waitForProfiles(plugin, 2);

  const response = await broker.request(plugin, 1, "resolve_profile", { url: "https://portal.azure.example/", task: "read billing", pin: true });
  assert.equal(response.ok, true);
  assert.equal(response.data.profile, "work");
  assert.equal(response.data.source, "open_tab");
  assert.equal(response.data.confident, true);
  assert.deepEqual(response.data.matchingTabs.map((tab) => tab.tabId), [202]);
  assert.equal(response.data.pinned, true);

  const unknown = await broker.request(plugin, 2, "resolve_profile", { url: "https://elsewhere.example/" });
  assert.equal(unknown.data.confident, false);
  assert.equal(unknown.data.profile, null);
  assert.equal(unknown.data.suggestion, "home");
});

test("hello with a profile pins the session before the first call", async (t) => {
  const broker = await startBroker(t);
  const hostA = await broker.makeHost(971, { profileId: "a@x.test", handler: tabsHandler([]) });
  const hostB = await broker.makeHost(972, { profileId: "b@x.test", handler: tabsHandler([]) });
  const watcher = broker.makePlugin("session-watch");
  await broker.waitForProfiles(watcher, 2);

  const plugin = broker.makePlugin("session-env-pin");
  plugin.write({ type: "hello", role: "plugin", sessionId: "session-env-pin", profile: "home" });
  const response = await broker.request(plugin, 1, "tool", { tool: "get_tabs", args: {} });
  assert.equal(response.ok, true);
  assert.equal(response.data.profile, "home");
  assert.equal(toolRequests(hostA, "get_tabs").length, 1);
  assert.equal(toolRequests(hostB, "get_tabs").length, 0);
});
