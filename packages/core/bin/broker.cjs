#!/usr/bin/env node
"use strict";

const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BASE_DIR = path.join(os.homedir(), ".iris");
const SOCKET_PATH = (process.env.IRIS_BROKER_SOCK || "").trim() || path.join(BASE_DIR, "broker.sock");

fs.mkdirSync(BASE_DIR, { recursive: true });

const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_PING_INTERVAL_MS = 20000;
const DEFAULT_PONG_TIMEOUT_MS = 45000;

function readMsEnv(name, fallback) {
  const value = Number(process.env[name]);
  if (Number.isFinite(value) && value >= 0) return value;
  return fallback;
}

const LEASE_TTL_MS = (() => {
  const raw = process.env.IRIS_CLAIM_TTL_MS ?? process.env.OPENCODE_BROWSER_CLAIM_TTL_MS;
  const value = Number(raw);
  if (Number.isFinite(value) && value >= 0) return value;
  return DEFAULT_LEASE_TTL_MS;
})();
const LEASE_SWEEP_MS =
  LEASE_TTL_MS > 0 ? Math.min(Math.max(10000, Math.floor(LEASE_TTL_MS / 2)), 60000) : 0;
const PING_INTERVAL_MS = readMsEnv("IRIS_PING_INTERVAL_MS", DEFAULT_PING_INTERVAL_MS);
const PONG_TIMEOUT_MS = readMsEnv("IRIS_PONG_TIMEOUT_MS", DEFAULT_PONG_TIMEOUT_MS);

function nowMs() {
  return Date.now();
}

function nowIso() {
  return new Date().toISOString();
}

function createJsonLineParser(onMessage) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.toString("utf8");
    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) return;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        // ignore
      }
    }
  };
}

function writeJsonLine(socket, msg) {
  socket.write(JSON.stringify(msg) + "\n");
}

function wantsTab(toolName) {
  return !["get_tabs", "get_active_tab", "open_tab", "list_downloads"].includes(toolName);
}

// --- State ---
const hosts = new Map(); // socket -> { pid, connectedAt, helloAt, lastPongAt }
let nextExtId = 0;
const extPending = new Map(); // extId -> { resolve, reject, sessionId, host, timeout }

const clients = new Set();

// Tab ownership: tabId -> { sessionId, claimedAt, lastSeenAt }
const claims = new Map();
// Session state: sessionId -> { defaultTabId, lastSeenAt }
const sessionState = new Map();

function listClaims() {
  const out = [];
  for (const [tabId, info] of claims.entries()) {
    out.push({
      tabId,
      sessionId: info.sessionId,
      claimedAt: info.claimedAt,
      lastSeenAt: new Date(info.lastSeenAt).toISOString(),
    });
  }
  out.sort((a, b) => a.tabId - b.tabId);
  return out;
}

function sessionHasClaims(sessionId) {
  for (const info of claims.values()) {
    if (info.sessionId === sessionId) return true;
  }
  return false;
}

function getSessionState(sessionId) {
  if (!sessionId) return null;
  let state = sessionState.get(sessionId);
  if (!state) {
    state = { defaultTabId: null, lastSeenAt: nowMs() };
    sessionState.set(sessionId, state);
  }
  return state;
}

function touchSession(sessionId) {
  const state = getSessionState(sessionId);
  if (!state) return null;
  state.lastSeenAt = nowMs();
  return state;
}

function setDefaultTab(sessionId, tabId) {
  const state = getSessionState(sessionId);
  if (!state) return;
  state.defaultTabId = tabId;
  state.lastSeenAt = nowMs();
}

function clearDefaultTab(sessionId, tabId) {
  const state = sessionState.get(sessionId);
  if (!state) return;
  if (tabId === undefined || state.defaultTabId === tabId) {
    state.defaultTabId = null;
  }
  state.lastSeenAt = nowMs();
}

function releaseClaim(tabId) {
  const info = claims.get(tabId);
  if (!info) return;
  claims.delete(tabId);
  clearDefaultTab(info.sessionId, tabId);
}

function releaseClaimsForSession(sessionId) {
  for (const [tabId, info] of claims.entries()) {
    if (info.sessionId === sessionId) claims.delete(tabId);
  }
  clearDefaultTab(sessionId);
  sessionState.delete(sessionId);
}

function checkClaim(tabId, sessionId) {
  const existing = claims.get(tabId);
  if (!existing) return { ok: true };
  if (existing.sessionId === sessionId) return { ok: true };
  return { ok: false, error: `Tab ${tabId} is owned by another Iris session (${existing.sessionId})` };
}

function setClaim(tabId, sessionId) {
  const existing = claims.get(tabId);
  claims.set(tabId, {
    sessionId,
    claimedAt: existing ? existing.claimedAt : nowIso(),
    lastSeenAt: nowMs(),
  });
}

function touchClaim(tabId, sessionId) {
  const existing = claims.get(tabId);
  if (existing && existing.sessionId !== sessionId) return;
  if (existing) {
    existing.lastSeenAt = nowMs();
  } else {
    setClaim(tabId, sessionId);
  }
}

function cleanupStaleClaims() {
  if (!LEASE_TTL_MS) return;
  const now = nowMs();
  for (const [tabId, info] of claims.entries()) {
    if (now - info.lastSeenAt > LEASE_TTL_MS) {
      releaseClaim(tabId);
    }
  }
  for (const [sessionId, state] of sessionState.entries()) {
    if (!sessionHasClaims(sessionId) && now - state.lastSeenAt > LEASE_TTL_MS) {
      sessionState.delete(sessionId);
    }
  }
}

function probeExistingSocket(timeoutMs = 750) {
  if (!fs.existsSync(SOCKET_PATH)) {
    return Promise.resolve({ live: false, reason: "missing" });
  }

  return new Promise((resolve) => {
    let done = false;
    const socket = net.createConnection(SOCKET_PATH);
    let timeout;

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      try {
        socket.destroy();
      } catch {}
      resolve(result);
    };

    timeout = setTimeout(() => {
      finish({ live: false, reason: "timeout" });
    }, timeoutMs);

    socket.once("connect", () => {
      finish({ live: true, reason: "accepted connection" });
    });

    socket.once("error", (err) => {
      finish({ live: false, reason: err && err.code ? err.code : err.message || "connect failed" });
    });
  });
}

async function prepareSocketPath() {
  const probe = await probeExistingSocket();
  if (probe.live) {
    console.error(`[iris-broker] existing broker appears live at ${SOCKET_PATH}; not starting duplicate`);
    return false;
  }

  if (fs.existsSync(SOCKET_PATH)) {
    try {
      fs.unlinkSync(SOCKET_PATH);
      console.error(`[iris-broker] removed stale socket at ${SOCKET_PATH} (${probe.reason})`);
    } catch (err) {
      console.error(`[iris-broker] could not remove stale socket at ${SOCKET_PATH}:`, err);
      throw err;
    }
  }

  return true;
}

function healthyHosts() {
  const now = nowMs();
  return [...hosts.entries()].filter(([socket, info]) => !socket.destroyed && now - info.lastPongAt <= PONG_TIMEOUT_MS);
}

function selectHostSocket() {
  const selected = healthyHosts().sort((a, b) => b[1].helloAt - a[1].helloAt)[0];
  return selected ? selected[0] : null;
}

function ensureHost() {
  const hostSocket = selectHostSocket();
  if (hostSocket) return hostSocket;
  throw new Error("Chrome extension is not connected (native host offline)");
}

function callExtension(tool, args, sessionId) {
  const hostSocket = ensureHost();
  const extId = ++nextExtId;

  return new Promise((resolve, reject) => {
    extPending.set(extId, { resolve, reject, sessionId, host: hostSocket });
    writeJsonLine(hostSocket, {
      type: "to_extension",
      message: { type: "tool_request", id: extId, tool, args },
    });

    const timeout = setTimeout(() => {
      if (!extPending.has(extId)) return;
      extPending.delete(extId);
      reject(new Error("Timed out waiting for extension"));
    }, 60000);

    // attach timeout to resolver
    const pending = extPending.get(extId);
    if (pending) pending.timeout = timeout;
  });
}

async function ensureSessionTab(sessionId) {
  if (!sessionId) throw new Error("Missing sessionId for tab creation");
  const res = await callExtension("open_tab", { active: false }, sessionId);
  const tabId = res && typeof res.tabId === "number" ? res.tabId : undefined;
  if (!tabId) throw new Error("Failed to create a new tab for this session");
  touchClaim(tabId, sessionId);
  setDefaultTab(sessionId, tabId);
  return tabId;
}

async function resolveDefaultTabId(sessionId) {
  if (!sessionId) throw new Error("Missing sessionId for tab resolution");
  try {
    const active = await callExtension("get_active_tab", {}, sessionId);
    const activeId =
      active && typeof active.tabId === "number"
        ? active.tabId
        : active && active.content && typeof active.content.tabId === "number"
          ? active.content.tabId
          : null;
    if (typeof activeId === "number") {
      const claim = checkClaim(activeId, sessionId);
      if (claim.ok) {
        touchClaim(activeId, sessionId);
        setDefaultTab(sessionId, activeId);
        return activeId;
      }
      // owned by another session — do not steal; fall through to create
    }
  } catch {
    // extension error — fall through to create
  }
  return await ensureSessionTab(sessionId);
}

async function handleTool(pluginSocket, req) {
  const { tool, args = {}, sessionId } = req;
  if (!tool) throw new Error("Missing tool");

  if (sessionId) touchSession(sessionId);

  let tabId = args.tabId;
  const toolArgs = { ...args };

  const isCloseTool = tool === "close_tab";

  if (wantsTab(tool)) {
    if (typeof tabId !== "number") {
      const state = getSessionState(sessionId);
      const defaultTabId = state && Number.isFinite(state.defaultTabId) ? state.defaultTabId : null;
      if (Number.isFinite(defaultTabId)) {
        tabId = defaultTabId;
      } else if (!isCloseTool) {
        tabId = await resolveDefaultTabId(sessionId);
      } else {
        throw new Error("No tab owned by this session. Open a new tab first.");
      }
    }

    const claimCheck = checkClaim(tabId, sessionId);
    if (!claimCheck.ok) throw new Error(claimCheck.error);
  }

  const res = await callExtension(tool, { ...toolArgs, tabId }, sessionId);

  const usedTabId =
    res && typeof res.tabId === "number" ? res.tabId : typeof tabId === "number" ? tabId : undefined;
  if (typeof usedTabId === "number") {
    if (isCloseTool) {
      if (claims.has(usedTabId)) {
        releaseClaim(usedTabId);
      } else {
        clearDefaultTab(sessionId, usedTabId);
      }
    } else {
      touchClaim(usedTabId, sessionId);
      setDefaultTab(sessionId, usedTabId);
    }
  }

  return res;
}

function handleClientMessage(socket, client, msg) {
  if (msg && msg.type === "hello") {
    client.role = msg.role || "unknown";
    client.sessionId = msg.sessionId;
    if (client.sessionId) touchSession(client.sessionId);
    if (client.role === "native-host") {
      const now = nowMs();
      hosts.set(socket, {
        pid: msg.pid ?? null,
        connectedAt: nowIso(),
        helloAt: now,
        lastPongAt: now,
      });
      // allow host to see current state
      writeJsonLine(socket, { type: "host_ready", claims: listClaims() });
    }
    return;
  }

  if (msg && msg.type === "from_extension") {
    const info = hosts.get(socket);
    if (info) info.lastPongAt = nowMs();
    const message = msg.message;
    if (message && message.type === "pong") return;
    if (message && message.type === "tool_response" && typeof message.id === "number") {
      const pending = extPending.get(message.id);
      if (!pending) return;
      extPending.delete(message.id);
      if (pending.timeout) clearTimeout(pending.timeout);

      if (message.error) {
        pending.reject(new Error(message.error.content || String(message.error)));
      } else {
        // Forward full result payload so callers can read tabId
        pending.resolve(message.result);
      }
    }
    return;
  }

  if (msg && msg.type === "request" && typeof msg.id === "number") {
    const requestId = msg.id;
    const sessionId = msg.sessionId || client.sessionId;
    if (sessionId) touchSession(sessionId);

    const replyOk = (data) => writeJsonLine(socket, { type: "response", id: requestId, ok: true, data });
    const replyErr = (err) =>
      writeJsonLine(socket, { type: "response", id: requestId, ok: false, error: err.message || String(err) });

    (async () => {
      try {
        if (msg.op === "status") {
          const state = sessionId ? sessionState.get(sessionId) : null;
          const sessionInfo = state
            ? {
                sessionId,
                defaultTabId: state.defaultTabId,
                lastSeenAt: new Date(state.lastSeenAt).toISOString(),
              }
            : null;
          replyOk({
            broker: true,
            hostConnected: healthyHosts().length > 0,
            hostCount: hosts.size,
            hosts: [...hosts.values()].map((info) => ({
              pid: info.pid,
              connectedAt: info.connectedAt,
              lastPongAgoMs: nowMs() - info.lastPongAt,
            })),
            claims: listClaims(),
            leaseTtlMs: LEASE_TTL_MS,
            session: sessionInfo,
          });
          return;
        }

        if (msg.op === "list_claims") {
          replyOk({ claims: listClaims() });
          return;
        }

        if (msg.op === "claim_tab") {
          const tabId = msg.tabId;
          const force = !!msg.force;
          if (typeof tabId !== "number") throw new Error("tabId is required");
          const existing = claims.get(tabId);
          if (existing && existing.sessionId !== sessionId && !force) {
            throw new Error(`Tab ${tabId} is owned by another Iris session (${existing.sessionId})`);
          }
          if (existing && existing.sessionId !== sessionId && force) {
            clearDefaultTab(existing.sessionId, tabId);
          }
          setClaim(tabId, sessionId);
          setDefaultTab(sessionId, tabId);
          replyOk({ ok: true, tabId, sessionId });
          return;
        }

        if (msg.op === "release_tab") {
          const tabId = msg.tabId;
          if (typeof tabId !== "number") throw new Error("tabId is required");
          const existing = claims.get(tabId);
          if (!existing) {
            replyOk({ ok: true, tabId, released: false });
            return;
          }
          if (existing.sessionId !== sessionId) {
            throw new Error(`Tab ${tabId} is owned by another Iris session (${existing.sessionId})`);
          }
          releaseClaim(tabId);
          replyOk({ ok: true, tabId, released: true });
          return;
        }

        if (msg.op === "tool") {
          const result = await handleTool(socket, { tool: msg.tool, args: msg.args || {}, sessionId });
          replyOk(result);
          return;
        }

        if (msg.op === "extension_reload") {
          let sent = 0;
          for (const [hostSocket] of healthyHosts()) {
            writeJsonLine(hostSocket, { type: "to_extension", message: { type: "reload" } });
            sent += 1;
          }
          if (!sent) throw new Error("Chrome extension is not connected (native host offline)");
          replyOk({ ok: sent > 0, sent });
          return;
        }

        throw new Error(`Unknown op: ${msg.op}`);
      } catch (e) {
        replyErr(e);
      }
    })();

    return;
  }
}

async function start() {
  const shouldStart = await prepareSocketPath();
  if (!shouldStart) process.exit(0);

  const server = net.createServer((socket) => {
    socket.setNoDelay(true);

    const client = { role: "unknown", sessionId: null };
    clients.add(client);

    socket.on(
      "data",
      createJsonLineParser((msg) => handleClientMessage(socket, client, msg))
    );

    socket.on("close", () => {
      clients.delete(client);
      if (client.role === "native-host") {
        hosts.delete(socket);
        // fail pending extension requests for this host
        for (const [extId, pending] of extPending.entries()) {
          if (pending.host !== socket) continue;
          extPending.delete(extId);
          if (pending.timeout) clearTimeout(pending.timeout);
          pending.reject(new Error("Native host disconnected"));
        }
      }
      if (client.sessionId) releaseClaimsForSession(client.sessionId);
    });

    socket.on("error", () => {
      // close handler will clean up
    });
  });

  server.listen(SOCKET_PATH, () => {
    // Restrict the socket to the owning user.
    try {
      fs.chmodSync(SOCKET_PATH, 0o600);
    } catch {}
    console.error(`[iris-broker] listening on ${SOCKET_PATH}`);
  });

  server.on("error", (err) => {
    if (err && err.code === "EADDRINUSE") {
      console.error(`[iris-broker] socket already in use at ${SOCKET_PATH}; assuming another broker won the race`);
      process.exit(0);
    }
    console.error("[iris-broker] server error", err);
    process.exit(1);
  });
}

if (LEASE_TTL_MS > 0 && LEASE_SWEEP_MS > 0) {
  const timer = setInterval(cleanupStaleClaims, LEASE_SWEEP_MS);
  if (typeof timer.unref === "function") timer.unref();
}

if (PING_INTERVAL_MS > 0) {
  const timer = setInterval(() => {
    const now = nowMs();
    for (const [hostSocket, info] of hosts.entries()) {
      if (hostSocket.destroyed) {
        hosts.delete(hostSocket);
        continue;
      }
      if (now - info.lastPongAt > PONG_TIMEOUT_MS) {
        console.error(`[iris-broker] dropping unresponsive host pid=${info.pid}`);
        hosts.delete(hostSocket);
        hostSocket.destroy();
        continue;
      }
      try {
        writeJsonLine(hostSocket, { type: "to_extension", message: { type: "ping", id: ++nextExtId } });
      } catch {}
    }
  }, PING_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
}

start().catch((err) => {
  console.error("[iris-broker] failed to start", err);
  process.exit(1);
});
