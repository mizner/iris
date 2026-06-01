#!/usr/bin/env node
"use strict";

const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const session =
  (process.env.OPENCODE_BROWSER_AGENT_SESSION || process.env.AGENT_BROWSER_SESSION || "default").trim();
const socketPath =
  process.env.OPENCODE_BROWSER_AGENT_SOCKET || path.join(os.tmpdir(), `agent-browser-${session}.sock`);

function getPortForSession(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0;
  }
  return 49152 + (Math.abs(hash) % 16383);
}

const host = process.env.OPENCODE_BROWSER_AGENT_GATEWAY_HOST || process.env.OPENCODE_BROWSER_AGENT_HOST || "0.0.0.0";
const port =
  Number(process.env.OPENCODE_BROWSER_AGENT_GATEWAY_PORT || process.env.OPENCODE_BROWSER_AGENT_PORT) ||
  getPortForSession(session);

function resolveDaemonPath() {
  const override = process.env.OPENCODE_BROWSER_AGENT_DAEMON;
  if (override) return override;
  try {
    return require.resolve("agent-browser/dist/daemon.js");
  } catch {
    return null;
  }
}

function shouldAutoStart() {
  const autoStart = (process.env.OPENCODE_BROWSER_AGENT_AUTOSTART || "").toLowerCase();
  return !["0", "false", "no"].includes(autoStart);
}

function startDaemon() {
  if (!shouldAutoStart()) return;
  const daemonPath = resolveDaemonPath();
  if (!daemonPath) {
    console.error("[agent-gateway] agent-browser dependency not found.");
    return;
  }
  try {
    const child = spawn(process.execPath, [daemonPath], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        AGENT_BROWSER_SESSION: session,
        AGENT_BROWSER_DAEMON: "1",
      },
    });
    child.unref();
  } catch (err) {
    console.error("[agent-gateway] Failed to start daemon:", err?.message || err);
  }
}

async function sleep(ms) {
  return await new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectAgentSocket() {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", (err) => reject(err));
  });
}

async function createAgentConnection() {
  try {
    return await connectAgentSocket();
  } catch {
    startDaemon();
    for (let attempt = 0; attempt < 20; attempt++) {
      await sleep(100);
      try {
        return await connectAgentSocket();
      } catch {}
    }
    throw new Error(`Could not connect to agent-browser socket at ${socketPath}`);
  }
}

const server = net.createServer(async (client) => {
  let upstream = null;
  try {
    upstream = await createAgentConnection();
  } catch (err) {
    client.end();
    console.error("[agent-gateway] Connection failed:", err?.message || err);
    return;
  }

  client.pipe(upstream);
  upstream.pipe(client);

  const close = () => {
    try {
      client.destroy();
    } catch {}
    try {
      upstream.destroy();
    } catch {}
  };

  client.on("error", close);
  upstream.on("error", close);
  client.on("close", close);
  upstream.on("close", close);
});

server.on("error", (err) => {
  console.error("[agent-gateway] Server error:", err?.message || err);
  process.exit(1);
});

server.listen(port, host, () => {
  console.log(`[agent-gateway] Listening on ${host}:${port}`);
  console.log(`[agent-gateway] Proxying to ${socketPath}`);
});
