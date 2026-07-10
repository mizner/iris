import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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

async function startBroker(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "iris-broker-"));
  const socketPath = path.join(dir, "broker.sock");
  const child = spawn(process.execPath, [BROKER_PATH], {
    env: {
      ...process.env,
      IRIS_BROKER_SOCK: socketPath,
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

  async function makeHost(pid, { pong = true } = {}) {
    const host = makeClient({ type: "hello", role: "native-host", pid });
    host.pong = pong;
    host.socket.on(
      "data",
      createJsonLineParser((message) => {
        if (message?.type === "to_extension" && message.message?.type === "ping" && host.pong) {
          host.write({ type: "from_extension", message: { type: "pong" } });
        }
      })
    );
    await host.nextMessage((message) => message.type === "host_ready");
    return host;
  }

  function makePlugin(sessionId = "session-test") {
    return makeClient({ type: "hello", role: "plugin", sessionId });
  }

  async function request(client, id, op, extra = {}) {
    client.write({ type: "request", id, op, ...extra });
    return await client.nextMessage((message) => message.type === "response" && message.id === id);
  }

  return { child, logs, makeHost, makePlugin, request };
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

test("pending requests reject per host and next request routes to older healthy host", async (t) => {
  const broker = await startBroker(t);
  const hostA = await broker.makeHost(301, { pong: true });
  const hostB = await broker.makeHost(302, { pong: true });
  const plugin = broker.makePlugin();

  plugin.write({ type: "request", id: 1, op: "tool", tool: "get_tabs", args: {} });
  const hostBRequest = await hostB.nextMessage(isToolRequest("get_tabs"));
  assert.equal(hostBRequest.message.tool, "get_tabs");

  hostB.destroy();
  const rejected = await plugin.nextMessage((message) => message.type === "response" && message.id === 1);
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /Native host disconnected/);

  plugin.write({ type: "request", id: 2, op: "tool", tool: "get_tabs", args: {} });
  const hostARequest = await hostA.nextMessage(isToolRequest("get_tabs"));
  hostA.write({
    type: "from_extension",
    message: { type: "tool_response", id: hostARequest.message.id, result: [{ id: 1, title: "ok" }] },
  });

  const resolved = await plugin.nextMessage((message) => message.type === "response" && message.id === 2);
  assert.equal(resolved.ok, true);
  assert.deepEqual(resolved.data, [{ id: 1, title: "ok" }]);
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

test("wantsTab tool without tabId uses active tab before creating one", async (t) => {
  const broker = await startBroker(t);
  const host = await broker.makeHost(701, { pong: true });
  const plugin = broker.makePlugin("session-active-tab");

  host.socket.on(
    "data",
    createJsonLineParser((message) => {
      if (message?.type !== "to_extension" || message.message?.type !== "tool_request") return;
      const { id, tool } = message.message;
      if (tool === "get_active_tab") {
        host.write({
          type: "from_extension",
          message: {
            type: "tool_response",
            id,
            result: { tabId: 42, content: { tabId: 42, url: "https://example.com", title: "Example" } },
          },
        });
      } else if (tool === "click") {
        host.write({
          type: "from_extension",
          message: { type: "tool_response", id, result: { tabId: 42, content: "Clicked #go" } },
        });
      } else if (tool === "open_tab") {
        host.write({
          type: "from_extension",
          message: { type: "tool_response", id, result: { tabId: 99, content: { tabId: 99 } } },
        });
      } else {
        host.write({
          type: "from_extension",
          message: { type: "tool_response", id, error: { content: `unexpected tool ${tool}` } },
        });
      }
    })
  );

  plugin.write({
    type: "request",
    id: 1,
    op: "tool",
    tool: "click",
    args: { selector: "#go" },
    sessionId: "session-active-tab",
  });
  const response = await plugin.nextMessage((m) => m.type === "response" && m.id === 1, 5000);
  assert.equal(response.ok, true);

  const openTabRequests = host.messages.filter(
    (m) => m?.type === "to_extension" && m.message?.type === "tool_request" && m.message.tool === "open_tab"
  );
  assert.equal(openTabRequests.length, 0, "must not open a new tab when active tab is claimable");

  const getActive = host.messages.filter(
    (m) => m?.type === "to_extension" && m.message?.type === "tool_request" && m.message.tool === "get_active_tab"
  );
  assert.ok(getActive.length >= 1);

  const clickReq = host.messages.filter(
    (m) => m?.type === "to_extension" && m.message?.type === "tool_request" && m.message.tool === "click"
  );
  assert.equal(clickReq.length, 1);
  assert.equal(clickReq[0].message.args.tabId, 42);
});

test("wantsTab tool creates tab when active tab is owned by another session", async (t) => {
  const broker = await startBroker(t);
  const host = await broker.makeHost(702, { pong: true });

  const pluginA = broker.makePlugin("session-a");
  await broker.request(pluginA, 1, "claim_tab", { tabId: 42 });

  const pluginB = broker.makePlugin("session-b");
  host.socket.on(
    "data",
    createJsonLineParser((message) => {
      if (message?.type !== "to_extension" || message.message?.type !== "tool_request") return;
      const { id, tool, args } = message.message;
      if (tool === "get_active_tab") {
        host.write({
          type: "from_extension",
          message: { type: "tool_response", id, result: { tabId: 42, content: { tabId: 42 } } },
        });
      } else if (tool === "open_tab") {
        host.write({
          type: "from_extension",
          message: { type: "tool_response", id, result: { tabId: 77, content: { tabId: 77 } } },
        });
      } else if (tool === "click") {
        host.write({
          type: "from_extension",
          message: { type: "tool_response", id, result: { tabId: args.tabId, content: "Clicked" } },
        });
      }
    })
  );

  pluginB.write({
    type: "request",
    id: 2,
    op: "tool",
    tool: "click",
    args: { selector: "#x" },
    sessionId: "session-b",
  });
  const response = await pluginB.nextMessage((m) => m.type === "response" && m.id === 2, 5000);
  assert.equal(response.ok, true);

  const openTabRequests = host.messages.filter(
    (m) => m?.type === "to_extension" && m.message?.type === "tool_request" && m.message.tool === "open_tab"
  );
  assert.ok(openTabRequests.length >= 1, "must open a new tab when active is foreign-owned");
  const clickReq = host.messages.filter(
    (m) => m?.type === "to_extension" && m.message?.type === "tool_request" && m.message.tool === "click"
  );
  assert.ok(clickReq.some((m) => m.message.args.tabId === 77));
});
