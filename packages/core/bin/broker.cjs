#!/usr/bin/env node
"use strict";

const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BASE_DIR = path.join(os.homedir(), ".iris");
const SOCKET_PATH = (process.env.IRIS_BROKER_SOCK || "").trim() || path.join(BASE_DIR, "broker.sock");
const CONFIG_PATH = (process.env.IRIS_CONFIG_PATH || "").trim() || path.join(BASE_DIR, "config.json");

fs.mkdirSync(BASE_DIR, { recursive: true });

// Optional decision-model support lives next to the broker; older installs may not have it.
let decision = null;
try {
  decision = require("./decision.cjs");
} catch {
  decision = null;
}

const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_PING_INTERVAL_MS = 20000;
const DEFAULT_PONG_TIMEOUT_MS = 45000;
const EXTENSION_TIMEOUT_MS = 60000;
const INVENTORY_TIMEOUT_MS = 5000;

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
  return ![
    "get_tabs",
    "get_active_tab",
    "open_tab",
    "list_downloads",
    "get_profile_status",
    "profile_summary",
    "search_history",
    "bookmarks",
    "recently_closed",
  ].includes(toolName);
}

// Profile-wide lookups that can search every connected profile when the session has not chosen one yet.
const PROFILE_LISTS = { search_history: null, bookmarks: null, recently_closed: "recentlyClosed" };

// --- State ---
// socket -> { pid, connectedAt, helloAt, lastPongAt, profileKey, profileId, allowed, version }
const hosts = new Map();
let nextExtId = 0;
const extPending = new Map(); // extId -> { resolve, reject, sessionId, host, timeout }

const clients = new Set();

// Tab ownership: tabId -> { sessionId, claimedAt, lastSeenAt }
const claims = new Map();
// Session state: sessionId -> { defaultTabId, lastSeenAt, profileKey }
const sessionState = new Map();
// Which host (Chrome profile) a tab lives in: tabId -> host socket
const tabOwners = new Map();

// --- Config and profile naming ---

let configCache = { mtimeMs: null, value: {} };

function readConfig() {
  try {
    const stat = fs.statSync(CONFIG_PATH);
    if (stat.mtimeMs !== configCache.mtimeMs) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      configCache = { mtimeMs: stat.mtimeMs, value: parsed && typeof parsed === "object" ? parsed : {} };
    }
  } catch {
    configCache = { mtimeMs: null, value: {} };
  }
  return configCache.value;
}

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeHost(value) {
  const raw = normalizeKey(value);
  if (!raw) return "";
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
  } catch {
    return "";
  }
}

function hostMatches(host, pattern) {
  return !!host && !!pattern && (host === pattern || host.endsWith(`.${pattern}`));
}

function sameSite(a, b) {
  return hostMatches(a, b) || hostMatches(b, a);
}

function configuredProfiles() {
  const raw = readConfig().profiles;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const out = [];
  for (const [alias, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object") continue;
    const key = normalizeKey(entry.email || entry.profileId);
    if (!key) continue;
    out.push({
      alias: normalizeKey(alias),
      key,
      purpose: typeof entry.purpose === "string" ? entry.purpose.trim() : "",
      sites: Array.isArray(entry.domains) ? entry.domains.map(normalizeHost).filter(Boolean) : [],
      isDefault: entry.default === true,
    });
  }
  return out;
}

function configFor(key) {
  return configuredProfiles().find((p) => p.key === key) || null;
}

function labelFor(key) {
  if (!key) return "unidentified";
  return configFor(key)?.alias || key;
}

function matchProfileKey(want) {
  const w = normalizeKey(want);
  if (!w) return null;
  for (const p of configuredProfiles()) {
    if (p.alias === w || p.key === w) return p.key;
  }
  for (const info of hosts.values()) {
    if (info.profileKey === w) return w;
  }
  return null;
}

function profileError(code, message) {
  return new Error(`${code}: ${message}`);
}

function decisionSettings() {
  if (!decision) return { available: false, reason: "decision module not installed" };
  return decision.resolveSettings(readConfig());
}

function decisionStatus() {
  const settings = decisionSettings();
  return decision ? decision.publicStatus(settings) : { available: false, reason: settings.reason };
}

// --- Hosts ---

function healthyHosts() {
  const now = nowMs();
  return [...hosts.entries()].filter(([socket, info]) => !socket.destroyed && now - info.lastPongAt <= PONG_TIMEOUT_MS);
}

function routingCandidates() {
  return healthyHosts().filter(([, info]) => info.allowed !== false);
}

function connectedLabels() {
  return routingCandidates().map(([, info]) => (info.profileKey ? labelFor(info.profileKey) : `unidentified (pid ${info.pid})`));
}

function knownProfileNames() {
  const names = new Set(configuredProfiles().map((p) => p.alias));
  for (const label of connectedLabels()) names.add(label);
  return [...names];
}

function hostForProfile(key) {
  const matches = healthyHosts()
    .filter(([, info]) => info.profileKey === key)
    .sort((a, b) => b[1].helloAt - a[1].helloAt);
  return matches[0]?.[0] ?? null;
}

function ownerOfTab(tabId) {
  const socket = tabOwners.get(tabId);
  if (!socket) return null;
  if (socket.destroyed || !hosts.has(socket)) {
    tabOwners.delete(tabId);
    return null;
  }
  return socket;
}

// --- Claims ---

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

// Each profile's badge should only count claims on its own tabs.
function claimsForHost(hostSocket) {
  return listClaims().filter((claim) => {
    const owner = ownerOfTab(claim.tabId);
    return !owner || owner === hostSocket;
  });
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
    state = { defaultTabId: null, lastSeenAt: nowMs(), profileKey: null };
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

function broadcastClaims() {
  for (const [hostSocket] of healthyHosts()) {
    try {
      writeJsonLine(hostSocket, { type: "to_extension", message: { type: "claims", claims: claimsForHost(hostSocket) } });
    } catch {}
  }
}

function releaseClaim(tabId, { silent = false } = {}) {
  const info = claims.get(tabId);
  if (!info) return false;
  claims.delete(tabId);
  clearDefaultTab(info.sessionId, tabId);
  if (!silent) broadcastClaims();
  return true;
}

function releaseClaimsForSession(sessionId) {
  let any = false;
  for (const [tabId, info] of claims.entries()) {
    if (info.sessionId === sessionId) {
      claims.delete(tabId);
      any = true;
    }
  }
  clearDefaultTab(sessionId);
  sessionState.delete(sessionId);
  if (any) broadcastClaims();
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
  if (!existing || existing.sessionId !== sessionId) broadcastClaims();
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
  let expired = false;
  for (const [tabId, info] of claims.entries()) {
    if (now - info.lastSeenAt > LEASE_TTL_MS) {
      releaseClaim(tabId, { silent: true });
      expired = true;
    }
  }
  if (expired) broadcastClaims();
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

// --- Extension calls ---

function callExtension(hostSocket, tool, args, sessionId, timeoutMs = EXTENSION_TIMEOUT_MS) {
  if (!hostSocket || hostSocket.destroyed) {
    return Promise.reject(new Error("Chrome extension is not connected (native host offline)"));
  }
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
    }, timeoutMs);

    const pending = extPending.get(extId);
    if (pending) pending.timeout = timeout;
  });
}

function parseTabList(result) {
  if (!result || typeof result.content !== "string") return null;
  try {
    const tabs = JSON.parse(result.content);
    return Array.isArray(tabs) ? tabs : null;
  } catch {
    return null;
  }
}

function recordTabs(hostSocket, tool, result) {
  if (!result || typeof result !== "object") return;
  if (typeof result.tabId === "number") tabOwners.set(result.tabId, hostSocket);
  if (tool === "get_tabs") {
    for (const tab of parseTabList(result) || []) {
      if (typeof tab?.id === "number") tabOwners.set(tab.id, hostSocket);
    }
  }
}

// Label results with the profile they came from so agents can verify where they are.
function withProfile(tool, result, key) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const profile = labelFor(key);
  const out = { ...result, profile };
  if (tool === "get_tabs") {
    const tabs = parseTabList(result);
    if (tabs) out.content = JSON.stringify(tabs.map((tab) => ({ ...tab, profile })), null, 2);
  } else if ((tool === "open_tab" || tool === "get_active_tab") && result.content && typeof result.content === "object") {
    out.content = { ...result.content, profile };
  }
  return out;
}

async function fanOut(tool, args, sessionId, timeoutMs = INVENTORY_TIMEOUT_MS) {
  const candidates = routingCandidates();
  const settled = await Promise.allSettled(
    candidates.map(([socket]) => callExtension(socket, tool, args, sessionId, timeoutMs))
  );
  return candidates.map(([socket, info], index) => ({
    socket,
    info,
    ok: settled[index].status === "fulfilled",
    value: settled[index].status === "fulfilled" ? settled[index].value : null,
    error: settled[index].status === "rejected" ? settled[index].reason?.message || String(settled[index].reason) : null,
  }));
}

function firstFanOutError(results) {
  return new Error(results.find((r) => r.error)?.error || "Chrome extension is not connected (native host offline)");
}

async function allProfilesTabs(sessionId) {
  const results = await fanOut("get_tabs", {}, sessionId);
  if (!results.some((r) => r.ok)) throw firstFanOutError(results);
  const tabs = [];
  for (const r of results) {
    if (!r.ok) continue;
    recordTabs(r.socket, "get_tabs", r.value);
    tabs.push(...(parseTabList(withProfile("get_tabs", r.value, r.info.profileKey)) || []));
  }
  return { content: JSON.stringify(tabs, null, 2) };
}

async function focusedActiveTab(sessionId) {
  const results = await fanOut("get_active_tab", {}, sessionId);
  const ok = results.filter((r) => r.ok);
  if (!ok.length) throw firstFanOutError(results);
  for (const r of ok) recordTabs(r.socket, "get_active_tab", r.value);
  const focused = ok.filter((r) => r.value?.content?.windowFocused);
  if (focused.length === 1) return withProfile("get_active_tab", focused[0].value, focused[0].info.profileKey);
  return {
    content: {
      ambiguous: true,
      note: "No single focused Chrome window. Pass a tabId from this list, or choose a profile first.",
      activeTabs: ok.map((r) => ({
        profile: labelFor(r.info.profileKey),
        tabId: r.value?.tabId,
        url: r.value?.content?.url,
        title: r.value?.content?.title,
      })),
    },
  };
}

async function allProfileStatuses(sessionId) {
  const results = await fanOut("get_profile_status", {}, sessionId);
  return {
    content: {
      profiles: results.map((r) =>
        r.ok
          ? { profile: labelFor(r.info.profileKey), ...(r.value?.content || r.value || {}) }
          : { profile: labelFor(r.info.profileKey), error: r.error }
      ),
    },
  };
}

async function allProfilesList(tool, args, sessionId) {
  const results = await fanOut(tool, args, sessionId, EXTENSION_TIMEOUT_MS);
  if (!results.some((r) => r.ok)) throw firstFanOutError(results);
  const listKey = PROFILE_LISTS[tool];
  const merged = [];
  const errors = [];
  for (const r of results) {
    const profile = labelFor(r.info.profileKey);
    if (!r.ok) {
      errors.push({ profile, error: r.error });
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(r.value?.content || "[]");
    } catch {
      parsed = [];
    }
    const items = listKey ? parsed?.[listKey] || [] : parsed;
    for (const item of Array.isArray(items) ? items : []) merged.push({ ...item, profile });
  }
  return { content: JSON.stringify(errors.length ? { results: merged, errors } : merged, null, 2) };
}

async function refreshTabOwners(sessionId) {
  const results = await fanOut("get_tabs", {}, sessionId);
  for (const r of results) {
    if (r.ok) recordTabs(r.socket, "get_tabs", r.value);
  }
}

// --- Routing ---
// Order: explicit profile, then the tab's own profile, then the session's profile,
// then the only connected profile. Several connected profiles and no choice is an error,
// never a guess.
async function resolveRoute(sessionId, { profile, tabId }) {
  const state = sessionId ? getSessionState(sessionId) : null;

  if (profile) {
    const key = matchProfileKey(profile);
    if (!key) {
      throw profileError(
        "PROFILE_UNKNOWN",
        `No Chrome profile named "${profile}". Known: ${knownProfileNames().join(", ") || "none"}.`
      );
    }
    const socket = hostForProfile(key);
    if (!socket) {
      throw profileError(
        "PROFILE_NOT_CONNECTED",
        `${labelFor(key)} is not connected. Open a window in that Chrome profile (iris open-profile ${labelFor(key)}) and retry.`
      );
    }
    return { socket, key, source: "explicit" };
  }

  if (typeof tabId === "number") {
    let socket = ownerOfTab(tabId);
    if (!socket && routingCandidates().length > 1) {
      await refreshTabOwners(sessionId);
      socket = ownerOfTab(tabId);
    }
    if (socket) return { socket, key: hosts.get(socket)?.profileKey ?? null, source: "tab" };
  }

  if (state?.profileKey) {
    const socket = hostForProfile(state.profileKey);
    if (!socket) {
      throw profileError(
        "PROFILE_NOT_CONNECTED",
        `This session uses ${labelFor(state.profileKey)}, which is not connected. Reopen that profile (iris open-profile ${labelFor(state.profileKey)}) or choose another with browser_use_profile.`
      );
    }
    return { socket, key: state.profileKey, source: "session" };
  }

  const candidates = routingCandidates();
  if (candidates.length === 0) throw new Error("Chrome extension is not connected (native host offline)");
  if (candidates.length === 1) {
    return { socket: candidates[0][0], key: candidates[0][1].profileKey ?? null, source: "only" };
  }
  throw profileError(
    "PROFILE_REQUIRED",
    `${candidates.length} Chrome profiles are connected (${connectedLabels().join(", ")}). ` +
      "Call browser_profiles, then browser_use_profile (or pass profile=...). Iris will not guess."
  );
}

function maybePin(sessionId, route) {
  const state = sessionId ? getSessionState(sessionId) : null;
  if (state && !state.profileKey && route.key) state.profileKey = route.key;
}

// One Chrome tab group per agent session; IRIS_TAB_GROUPS=off leaves tabs ungrouped.
function sessionGroupTitle(sessionId) {
  if (!sessionId || /^(off|false|0)$/i.test(process.env.IRIS_TAB_GROUPS || "")) return undefined;
  const label = String(sessionId).replace(/[^a-z0-9]/gi, "").slice(-4);
  return label ? `Iris ${label}` : "Iris";
}

const MAX_TOOL_TIMEOUT_MS = 31 * 60 * 1000;

function toolTimeoutMs(requested) {
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= EXTENSION_TIMEOUT_MS) return EXTENSION_TIMEOUT_MS;
  return Math.min(n, MAX_TOOL_TIMEOUT_MS);
}

async function ensureSessionTab(sessionId, hostSocket) {
  if (!sessionId) throw new Error("Missing sessionId for tab creation");
  const res = await callExtension(hostSocket, "open_tab", { active: false, group: sessionGroupTitle(sessionId) }, sessionId);
  const tabId = res && typeof res.tabId === "number" ? res.tabId : undefined;
  if (!tabId) throw new Error("Failed to create a new tab for this session");
  tabOwners.set(tabId, hostSocket);
  touchClaim(tabId, sessionId);
  setDefaultTab(sessionId, tabId);
  return tabId;
}

// A session without an explicit tabId works in its own background tab, never the user's active tab.
async function sessionTabFor(sessionId, route, { create = true } = {}) {
  const state = getSessionState(sessionId);
  const defaultTabId = state && Number.isFinite(state.defaultTabId) ? state.defaultTabId : null;
  if (defaultTabId != null) {
    const owner = ownerOfTab(defaultTabId);
    if (!owner || owner === route.socket) return defaultTabId;
  }
  if (!create) throw new Error("No tab owned by this session. Open a new tab first.");
  return await ensureSessionTab(sessionId, route.socket);
}

async function handleTool(req) {
  const { tool, sessionId } = req;
  if (!tool) throw new Error("Missing tool");
  const { profile: requestedProfile, ...args } = req.args || {};
  const timeoutMs = toolTimeoutMs(req.timeoutMs);
  if (tool === "open_tab" && args.group === undefined) args.group = sessionGroupTitle(sessionId);

  if (sessionId) touchSession(sessionId);
  const state = sessionId ? getSessionState(sessionId) : null;

  const unscoped =
    !requestedProfile && !state?.profileKey && typeof args.tabId !== "number" && routingCandidates().length > 1;
  if (unscoped && tool === "get_tabs") return await allProfilesTabs(sessionId);
  if (unscoped && tool === "get_active_tab") return await focusedActiveTab(sessionId);
  if (unscoped && tool === "get_profile_status") return await allProfileStatuses(sessionId);
  if (unscoped && tool in PROFILE_LISTS && !args.restore) return await allProfilesList(tool, args, sessionId);

  const route = await resolveRoute(sessionId, { profile: requestedProfile, tabId: args.tabId });
  const isCloseTool = tool === "close_tab";

  let tabId = args.tabId;
  const implicitTab = wantsTab(tool) && typeof tabId !== "number";
  if (wantsTab(tool)) {
    if (implicitTab) tabId = await sessionTabFor(sessionId, route, { create: !isCloseTool });
    const claimCheck = checkClaim(tabId, sessionId);
    if (!claimCheck.ok) throw new Error(claimCheck.error);
  }

  let res;
  try {
    res = await callExtension(route.socket, tool, { ...args, tabId }, sessionId, timeoutMs);
  } catch (error) {
    if (typeof tabId !== "number" || !/TAB_NOT_FOUND|No tab with id/.test(error?.message || "")) throw error;
    // The tab is gone (user closed it). Forget it; a session's own implicit tab is replaced transparently.
    tabOwners.delete(tabId);
    if (claims.has(tabId)) releaseClaim(tabId);
    else clearDefaultTab(sessionId, tabId);
    if (!implicitTab || isCloseTool) throw error;
    tabId = await ensureSessionTab(sessionId, route.socket);
    res = await callExtension(route.socket, tool, { ...args, tabId }, sessionId, timeoutMs);
  }
  recordTabs(route.socket, tool, res);
  maybePin(sessionId, route);

  const usedTabId =
    res && typeof res.tabId === "number" ? res.tabId : typeof tabId === "number" ? tabId : undefined;
  if (typeof usedTabId === "number") {
    if (isCloseTool) {
      tabOwners.delete(usedTabId);
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

  const out = withProfile(tool, res, route.key);
  // Report popups and tabs this session's pages opened since its last call.
  if (state?.openedTabs?.length && out && typeof out === "object" && !Array.isArray(out)) {
    out.openedTabs = state.openedTabs.splice(0);
  }
  return out;
}

// --- Profile inventory, choice, and selection ---

async function collectInventory(sessionId) {
  const entries = new Map();
  for (const p of configuredProfiles()) {
    entries.set(p.key, {
      profile: p.alias,
      profileId: p.key,
      purpose: p.purpose,
      sites: p.sites,
      default: p.isDefault,
      connected: false,
    });
  }

  const healthy = healthyHosts();
  const summaries = await Promise.allSettled(
    healthy.map(([socket, info]) =>
      info.allowed === false ? Promise.resolve(null) : callExtension(socket, "profile_summary", {}, sessionId, INVENTORY_TIMEOUT_MS)
    )
  );

  const sockets = new Map();
  healthy.forEach(([socket, info], index) => {
    const key = info.profileKey || `pid:${info.pid}`;
    const entry = entries.get(key) || {
      profile: info.profileKey ? labelFor(info.profileKey) : `unidentified (pid ${info.pid})`,
      profileId: info.profileId || null,
      purpose: "",
      sites: [],
      default: false,
    };
    entry.connected = true;
    entry.allowed = info.allowed !== false;
    const summary = summaries[index];
    if (summary.status === "fulfilled" && summary.value?.content) {
      const c = summary.value.content;
      entry.windowCount = c.windowCount;
      entry.tabCount = c.tabCount;
      entry.windowFocused = !!c.windowFocused;
      entry.activeSite = c.activeHost || null;
      entry.openSites = Array.isArray(c.domains) ? c.domains.map((d) => d.host) : [];
    } else if (summary.status === "rejected") {
      entry.error = summary.reason?.message || String(summary.reason);
    }
    entries.set(key, entry);
    if (info.profileKey) sockets.set(info.profileKey, socket);
  });

  return { entries: [...entries.values()], sockets };
}

async function profileInventory(sessionId) {
  const state = sessionId ? sessionState.get(sessionId) : null;
  const { entries } = await collectInventory(sessionId);
  const connected = entries.filter((e) => e.connected && e.allowed !== false);
  return {
    profiles: entries.map((e) => ({ ...e, sessionProfile: !!state?.profileKey && e.profileId === state.profileKey })),
    sessionProfile: state?.profileKey ? labelFor(state.profileKey) : null,
    connectedCount: connected.length,
    decisionModel: decisionStatus(),
    next:
      state?.profileKey
        ? `This session uses ${labelFor(state.profileKey)}.`
        : connected.length === 1
          ? `Only ${connected[0].profile} is connected; it will be used automatically.`
          : "Pick one with browser_use_profile, or call browser_resolve_profile with the target url and a short task.",
  };
}

const COMMON_MAIL_DOMAINS = new Set(["gmail", "googlemail", "outlook", "hotmail", "icloud", "yahoo", "proton", "protonmail", "live", "me"]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionsProfile(text, entry) {
  const tokens = new Set([entry.profile]);
  const id = normalizeKey(entry.profileId);
  if (id.includes("@")) {
    tokens.add(id);
    const [local, domain] = id.split("@");
    if (local.length >= 4) tokens.add(local);
    const stem = domain.split(".")[0];
    if (stem.length >= 4 && !COMMON_MAIL_DOMAINS.has(stem)) tokens.add(stem);
  }
  for (const token of tokens) {
    if (!token) continue;
    if (new RegExp(`(^|[^a-z0-9])${escapeRegExp(token)}([^a-z0-9]|$)`).test(text)) return true;
  }
  return false;
}

async function tabsOnSite(socket, site, sessionId) {
  try {
    const res = await callExtension(socket, "get_tabs", {}, sessionId, INVENTORY_TIMEOUT_MS);
    recordTabs(socket, "get_tabs", res);
    return (parseTabList(res) || [])
      .filter((tab) => sameSite(normalizeHost(tab.url), site))
      .slice(0, 5)
      .map((tab) => ({ tabId: tab.id, title: tab.title, url: tab.url, active: tab.active }));
  } catch {
    return [];
  }
}

async function resolveProfile(sessionId, { url, task, pin }) {
  const { entries, sockets } = await collectInventory(sessionId);
  const connected = entries.filter((e) => e.connected && e.allowed !== false && sockets.has(e.profileId));
  const targetHost = normalizeHost(url);
  const text = normalizeKey(task);
  const openHere = (e) => !!targetHost && (e.openSites || []).some((h) => sameSite(h, targetHost));

  let pick = null;
  let source = "none";
  let reason = "";
  let decisionResult = null;

  if (text) {
    const named = connected.filter((e) => mentionsProfile(text, e));
    if (named.length === 1) {
      pick = named[0];
      source = "named";
      reason = `The task names ${pick.profile}.`;
    }
  }
  if (!pick && targetHost) {
    const open = connected.filter(openHere);
    if (open.length === 1) {
      pick = open[0];
      source = "open_tab";
      reason = `${targetHost} is already open only in ${pick.profile}.`;
    }
  }
  if (!pick && targetHost) {
    const hinted = connected.filter((e) => e.sites.some((s) => hostMatches(targetHost, s)));
    if (hinted.length === 1) {
      pick = hinted[0];
      source = "site_rule";
      reason = `${targetHost} is listed under ${pick.profile} in config.`;
    }
  }
  if (!pick && connected.length === 1) {
    pick = connected[0];
    source = "only_connected";
    reason = `${pick.profile} is the only connected profile.`;
  }

  const settings = decisionSettings();
  if (!pick && connected.length > 1 && settings.available) {
    try {
      decisionResult = await decision.chooseProfile(decision.createClient(settings), {
        task,
        targetHost,
        profiles: connected.map((e) => ({ name: e.profile, purpose: e.purpose, knownSites: e.sites, targetOpen: openHere(e) })),
      });
      if (decisionResult.decision !== decision.UNSURE) {
        pick = connected.find((e) => e.profile === decisionResult.decision) || null;
        if (pick) {
          source = "decision_model";
          reason = `Decision model chose ${pick.profile} (confidence ${decisionResult.confidence}, margin ${decisionResult.margin}).`;
        }
      }
    } catch (err) {
      decisionResult = { error: err?.message || String(err) };
    }
  }

  const fallback = connected.find((e) => e.default) || null;
  if (!pick) {
    reason =
      connected.length === 0
        ? "No allowed Chrome profile is connected."
        : "No rule singled out one profile" +
          (decisionResult && decisionResult.decision === "UNSURE" ? " and the decision model answered UNSURE" : "") +
          ". Choose one from the candidates, or ask the user before signing in or changing anything.";
  }

  const matchingTabs = pick && targetHost ? await tabsOnSite(sockets.get(pick.profileId), targetHost, sessionId) : [];
  const pinned = !!(pick && pin && sessionId);
  if (pinned) getSessionState(sessionId).profileKey = pick.profileId;

  return {
    profile: pick ? pick.profile : null,
    confident: !!pick,
    source,
    reason,
    suggestion: pick ? null : fallback ? fallback.profile : null,
    candidates: connected.map((e) => ({ profile: e.profile, purpose: e.purpose, targetOpen: openHere(e), default: e.default })),
    matchingTabs,
    decisionModel: decisionResult,
    pinned,
  };
}

function useProfile(sessionId, profile) {
  const key = matchProfileKey(profile);
  if (!key) {
    throw profileError("PROFILE_UNKNOWN", `No Chrome profile named "${profile}". Known: ${knownProfileNames().join(", ") || "none"}.`);
  }
  const socket = hostForProfile(key);
  if (!socket) {
    throw profileError(
      "PROFILE_NOT_CONNECTED",
      `${labelFor(key)} is not connected. Open a window in that Chrome profile (iris open-profile ${labelFor(key)}) and retry.`
    );
  }
  const state = getSessionState(sessionId);
  if (!state) throw new Error("Missing sessionId");
  if (state.defaultTabId != null) {
    const owner = ownerOfTab(state.defaultTabId);
    if (owner && owner !== socket) clearDefaultTab(sessionId);
  }
  state.profileKey = key;
  const cfg = configFor(key);
  return { ok: true, profile: labelFor(key), profileId: key, purpose: cfg?.purpose || "" };
}

function parseFacts(value) {
  const facts = {};
  if (Array.isArray(value)) {
    for (const entry of value) {
      const text = String(entry ?? "");
      const idx = text.indexOf("=");
      if (idx > 0) facts[text.slice(0, idx).trim()] = text.slice(idx + 1);
    }
  } else if (value && typeof value === "object") {
    for (const [key, val] of Object.entries(value)) facts[key] = String(val ?? "");
  }
  return facts;
}

async function runGoalOp(sessionId, msg) {
  const settings = decisionSettings();
  if (!settings.available) {
    return {
      status: "unavailable",
      reason: `Decision model unavailable (${settings.reason}). Use the step tools (snapshot, click, type) instead.`,
    };
  }
  if (!msg.goal || !String(msg.goal).trim()) throw new Error("goal is required");
  if (sessionId) touchSession(sessionId);

  const route = await resolveRoute(sessionId, { profile: msg.profile, tabId: msg.tabId });
  const tabId = typeof msg.tabId === "number" ? msg.tabId : await sessionTabFor(sessionId, route);
  const claimCheck = checkClaim(tabId, sessionId);
  if (!claimCheck.ok) throw new Error(claimCheck.error);
  maybePin(sessionId, route);
  touchClaim(tabId, sessionId);
  setDefaultTab(sessionId, tabId);

  const callTool = async (tool, args) => {
    const res = await callExtension(route.socket, tool, { ...args, tabId }, sessionId);
    touchClaim(tabId, sessionId);
    return res;
  };

  if (msg.url) await callTool("navigate", { url: msg.url });

  const maxSteps = Number.isFinite(msg.maxSteps) ? Math.min(20, Math.max(1, Math.floor(msg.maxSteps))) : 8;
  const result = await decision.runGoal({
    decide: decision.createClient(settings),
    callTool,
    goal: String(msg.goal),
    facts: parseFacts(msg.facts),
    maxSteps,
    allowIrreversible: msg.allowIrreversible === true,
    model: settings.model,
  });
  return { ...result, tabId, profile: labelFor(route.key) };
}

// --- Protocol ---

function handleClientMessage(socket, client, msg) {
  if (msg && msg.type === "hello") {
    client.role = msg.role || "unknown";
    client.sessionId = msg.sessionId;
    if (client.sessionId) {
      const state = touchSession(client.sessionId);
      if (state && typeof msg.profile === "string" && msg.profile.trim()) {
        state.profileKey = matchProfileKey(msg.profile) || normalizeKey(msg.profile);
      }
    }
    if (client.role === "native-host") {
      const now = nowMs();
      hosts.set(socket, {
        pid: msg.pid ?? null,
        connectedAt: nowIso(),
        helloAt: now,
        lastPongAt: now,
        profileKey: null,
        profileId: null,
        allowed: null,
        version: null,
      });
      // allow host to see current state
      writeJsonLine(socket, { type: "host_ready", claims: claimsForHost(socket) });
      writeJsonLine(socket, { type: "to_extension", message: { type: "claims", claims: claimsForHost(socket) } });
      writeJsonLine(socket, { type: "to_extension", message: { type: "identify_request" } });
    }
    return;
  }

  if (msg && msg.type === "from_extension") {
    const info = hosts.get(socket);
    if (info) info.lastPongAt = nowMs();
    const message = msg.message;
    if (message && message.type === "pong") return;
    if (message && message.type === "identify") {
      if (info) {
        info.profileKey = normalizeKey(message.profileId) || null;
        info.profileId = message.profileId || null;
        info.allowed = message.allowed !== false;
        info.version = message.version || null;
      }
      return;
    }
    if (message && message.type === "release_tab" && typeof message.tabId === "number") {
      releaseClaim(message.tabId);
      return;
    }
    if (message && message.type === "tab_opened" && typeof message.tabId === "number") {
      const opener = claims.get(message.openerTabId);
      if (!opener || claims.has(message.tabId)) return;
      tabOwners.set(message.tabId, socket);
      setClaim(message.tabId, opener.sessionId);
      const state = getSessionState(opener.sessionId);
      if (state) {
        state.openedTabs = state.openedTabs || [];
        state.openedTabs.push({
          tabId: message.tabId,
          openerTabId: message.openerTabId,
          url: message.url || "",
          popup: message.windowType === "popup",
        });
        if (state.openedTabs.length > 20) state.openedTabs.splice(0, state.openedTabs.length - 20);
      }
      return;
    }
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
                profile: state.profileKey ? labelFor(state.profileKey) : null,
                lastSeenAt: new Date(state.lastSeenAt).toISOString(),
              }
            : null;
          const healthySet = new Set(healthyHosts().map(([s]) => s));
          replyOk({
            broker: true,
            hostConnected: healthySet.size > 0,
            hostCount: hosts.size,
            hosts: [...hosts.entries()].map(([s, info]) => ({
              pid: info.pid,
              profile: info.profileKey ? labelFor(info.profileKey) : null,
              profileId: info.profileId,
              allowed: info.allowed,
              healthy: healthySet.has(s),
              connectedAt: info.connectedAt,
              lastPongAgoMs: nowMs() - info.lastPongAt,
            })),
            claims: listClaims(),
            leaseTtlMs: LEASE_TTL_MS,
            session: sessionInfo,
            decisionModel: decisionStatus(),
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
          let owner = ownerOfTab(tabId);
          if (!owner && routingCandidates().length > 1) {
            await refreshTabOwners(sessionId);
            owner = ownerOfTab(tabId);
          }
          setClaim(tabId, sessionId);
          setDefaultTab(sessionId, tabId);
          const ownerKey = owner ? hosts.get(owner)?.profileKey ?? null : null;
          if (ownerKey) maybePin(sessionId, { key: ownerKey });
          replyOk({ ok: true, tabId, sessionId, profile: ownerKey ? labelFor(ownerKey) : null });
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

        if (msg.op === "profiles") {
          replyOk(await profileInventory(sessionId));
          return;
        }

        if (msg.op === "use_profile") {
          replyOk(useProfile(sessionId, msg.profile));
          return;
        }

        if (msg.op === "resolve_profile") {
          replyOk(await resolveProfile(sessionId, { url: msg.url, task: msg.task, pin: msg.pin === true }));
          return;
        }

        if (msg.op === "run") {
          replyOk(await runGoalOp(sessionId, msg));
          return;
        }

        if (msg.op === "tool") {
          const result = await handleTool({ tool: msg.tool, args: msg.args || {}, sessionId, timeoutMs: msg.timeoutMs });
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
        for (const [tabId, owner] of tabOwners.entries()) {
          if (owner === socket) tabOwners.delete(tabId);
        }
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
        writeJsonLine(hostSocket, {
          type: "to_extension",
          message: { type: "ping", id: ++nextExtId, claims: claimsForHost(hostSocket) },
        });
      } catch {}
    }
  }, PING_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
}

start().catch((err) => {
  console.error("[iris-broker] failed to start", err);
  process.exit(1);
});
