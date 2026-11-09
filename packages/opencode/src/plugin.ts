import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { BASE_DIR, SOCKET_PATH as DEFAULT_SOCKET_PATH } from "@mizner/iris/paths";
import net from "net";
import { createAgentBackend, resolveNodeBinary, type AgentBackend } from "./agent-backend.js";
import { existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "fs";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_JSON_PATH = join(__dirname, "..", "package.json");

let cachedVersion: string | null = null;

function getPackageVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
    if (typeof pkg?.version === "string") {
      cachedVersion = pkg.version;
      return cachedVersion;
    }
  } catch {
    // ignore
  }
  cachedVersion = "unknown";
  return cachedVersion;
}

const { schema } = tool;

mkdirSync(BASE_DIR, { recursive: true });

const SOCKET_PATH = process.env.IRIS_BROKER_SOCK?.trim() || DEFAULT_SOCKET_PATH;
const RUNTIME_DIR = process.env.IRIS_BROKER_SOCK?.trim() ? dirname(SOCKET_PATH) : BASE_DIR;

const DEFAULT_MAX_UPLOAD_BYTES = 512 * 1024;
const MAX_UPLOAD_BYTES = (() => {
  const raw = process.env.IRIS_MAX_UPLOAD_BYTES ?? process.env.OPENCODE_BROWSER_MAX_UPLOAD_BYTES;
  const value = raw ? Number(raw) : NaN;
  if (Number.isFinite(value) && value > 0) return value;
  return DEFAULT_MAX_UPLOAD_BYTES;
})();

function resolveUploadPath(filePath: string): string {
  const trimmed = typeof filePath === "string" ? filePath.trim() : "";
  if (!trimmed) throw new Error("filePath is required");
  return isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed);
}

// Screenshot results are a data URL, or JSON with an `image` data URL plus labels. Saving writes the image to disk.
function saveScreenshot(text: string, savePath: string): string {
  let dataUrl = text;
  let extra: Record<string, unknown> = {};
  if (text.startsWith("{")) {
    const parsed = JSON.parse(text);
    if (!parsed?.image) return text;
    const { image, ...rest } = parsed;
    dataUrl = image;
    extra = rest;
  }
  const match = dataUrl.match(/^data:image\/[a-z+]+;base64,([\s\S]+)$/);
  if (!match) return text;
  const target = isAbsolute(savePath) ? savePath : resolve(process.cwd(), savePath);
  mkdirSync(dirname(target), { recursive: true });
  const bytes = Buffer.from(match[1], "base64");
  writeFileSync(target, bytes);
  return JSON.stringify({ saved: target, bytes: bytes.length, ...extra }, null, 2);
}

function buildFileUploadPayload(
  filePath: string,
  fileName?: string,
  mimeType?: string
): { name: string; mimeType?: string; base64: string } {
  const absPath = resolveUploadPath(filePath);
  const stats = statSync(absPath);
  if (!stats.isFile()) throw new Error(`Not a file: ${absPath}`);
  if (stats.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `File too large (${stats.size} bytes). Max is ${MAX_UPLOAD_BYTES} bytes (IRIS_MAX_UPLOAD_BYTES / OPENCODE_BROWSER_MAX_UPLOAD_BYTES). ` +
        `For larger uploads, use IRIS_BACKEND=agent.`
    );
  }
  const base64 = readFileSync(absPath).toString("base64");
  const name = typeof fileName === "string" && fileName.trim() ? fileName.trim() : basename(absPath);
  const mt = typeof mimeType === "string" && mimeType.trim() ? mimeType.trim() : undefined;
  return { name, mimeType: mt, base64 };
}

type BrokerResponse =
  | { type: "response"; id: number; ok: true; data: any }
  | { type: "response"; id: number; ok: false; error: string };

function createJsonLineParser(onMessage: (msg: any) => void): (chunk: Buffer) => void {
  let buffer = "";
  return (chunk: Buffer) => {
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

function writeJsonLine(socket: net.Socket, msg: any): void {
  socket.write(JSON.stringify(msg) + "\n");
}

function maybeStartBroker(): void {
  const brokerPath = join(RUNTIME_DIR, "broker.cjs");
  if (!existsSync(brokerPath)) return;

  try {
    const out = openSync(join(RUNTIME_DIR, "broker.log"), "a");
    const child = spawn(resolveNodeBinary(), [brokerPath], { detached: true, stdio: ["ignore", "ignore", out] });
    child.on("error", () => {});
    child.unref();
  } catch {
    // ignore
  }
}

async function connectToBroker(): Promise<net.Socket> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET_PATH);
    socket.once("connect", () => resolve(socket));
    socket.once("error", (err) => reject(err));
  });
}

async function sleep(ms: number): Promise<void> {
  return await new Promise((r) => setTimeout(r, ms));
}

const BACKEND_MODE = (
  process.env.IRIS_BACKEND ??
  process.env.OPENCODE_BROWSER_BACKEND ??
  process.env.OPENCODE_BROWSER_MODE ??
  "extension"
)
  .toLowerCase()
  .trim();
const USE_AGENT_BACKEND = ["agent", "agent-browser", "agentbrowser"].includes(BACKEND_MODE);
const USE_ROUTER_FALLBACKS = !["off", "false"].includes(
  (process.env.IRIS_FALLBACK ?? "").toLowerCase().trim()
);

let socket: net.Socket | null = null;
let sessionId = Math.random().toString(36).slice(2);
let reqId = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

const agentBackend: AgentBackend | null = USE_AGENT_BACKEND ? createAgentBackend(sessionId) : null;

async function ensureBrokerSocket(): Promise<net.Socket> {
  if (socket && !socket.destroyed) return socket;

  // Try to connect; if missing, try to start broker and retry.
  try {
    socket = await connectToBroker();
  } catch {
    maybeStartBroker();
    for (let i = 0; i < 20; i++) {
      await sleep(100);
      try {
        socket = await connectToBroker();
        break;
      } catch {}
    }
  }

  if (!socket || socket.destroyed) {
    throw new Error(
      "Could not connect to local broker. Run `iris install` and ensure the extension is loaded."
    );
  }

  socket.setNoDelay(true);
  socket.on(
    "data",
    createJsonLineParser((msg) => {
      if (msg?.type !== "response" || typeof msg.id !== "number") return;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      const res = msg as BrokerResponse;
      if (!res.ok) p.reject(new Error(res.error));
      else p.resolve(res.data);
    })
  );

  socket.on("close", () => {
    socket = null;
  });

  socket.on("error", () => {
    socket = null;
  });

  // IRIS_PROFILE pins this adapter's session to one Chrome profile from the first call.
  const pinnedProfile = process.env.IRIS_PROFILE?.trim() || undefined;
  // Harness and project let other sessions (and the user's tab groups) tell whose tabs these are.
  // OMP and the MCP server set IRIS_HARNESS; this plugin's own host is OpenCode.
  const harness = process.env.IRIS_HARNESS?.trim() || "opencode";
  const project = process.env.IRIS_PROJECT?.trim() || basename(process.cwd());
  writeJsonLine(socket, { type: "hello", role: "plugin", sessionId, pid: process.pid, profile: pinnedProfile, harness, project });

  return socket;
}

async function brokerRequest(op: string, payload: Record<string, any>, timeoutMs = 60000): Promise<any> {
  const s = await ensureBrokerSocket();
  const id = ++reqId;

  return await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    writeJsonLine(s, { type: "request", id, op, ...payload });
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error("Timed out waiting for broker response"));
    }, timeoutMs);
  });
}

// Fallback planes (Apple Events, agent-browser) cannot tell Chrome profiles apart, so they are only
// used when the extension plane itself is unreachable, never after a routing or page error.
function isPlaneUnavailable(message: string): boolean {
  return /not connected|native host offline|Could not connect to local broker|Native host disconnected|Timed out waiting for (extension|broker)/i.test(
    message
  );
}

async function brokerOnlyRequest(op: string, payload: Record<string, any>): Promise<any> {
  if (USE_AGENT_BACKEND) {
    throw new Error("Tab claims are not supported with agent-browser backend");
  }
  return await brokerRequest(op, payload);
}

// Tabs opened by this session's pages (popups, target=_blank) are reported once, on the next text result.
const pendingOpenedTabs: any[] = [];

function toolResultText(data: any, fallback: string): string {
  if (Array.isArray(data?.openedTabs)) pendingOpenedTabs.push(...data.openedTabs);
  let text: string;
  if (typeof data?.content === "string") text = data.content;
  else if (typeof data === "string") text = data;
  else if (data?.content != null) text = JSON.stringify(data.content);
  else text = fallback;
  if (!pendingOpenedTabs.length || text.startsWith("data:") || text.startsWith('{"image"')) return text;
  const opened = pendingOpenedTabs.splice(0);
  return `${text}\n\n[Iris] This session's pages opened new tabs (already claimed; pass tabId to use them): ${JSON.stringify(opened)}`;
}

function handoffResultText(data: unknown): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid handoff response");
  const result = Object.fromEntries(Object.entries(data).filter(([key]) => key !== "content"));
  return JSON.stringify(result);
}

const ROUTER_LOG_PATH = join(RUNTIME_DIR, "router.log");
let cachedAppleScriptApp: string | null = null;

function logRouter(message: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  try {
    require("fs").appendFileSync(ROUTER_LOG_PATH, line);
  } catch {}
}

function appleScriptStringLiteral(value: string): string {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function appleScriptApps(): string[] {
  const preferred = process.env.IRIS_BROWSER_APP?.trim();
  const defaults = ["Google Chrome", "Brave Browser", "Chromium"];
  return preferred ? [preferred, ...defaults.filter((app) => app !== preferred)] : defaults;
}

async function tryAppleScript(toolName: string, args: Record<string, any>): Promise<any> {
  // Apple Events only supports navigation/tab operations
  const supportedTools = ["open_tab", "navigate", "get_active_tab", "get_tabs"];
  if (!supportedTools.includes(toolName)) {
    throw new Error(`Apple Events does not support: ${toolName}`);
  }
  
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  async function runAppleScript(buildArgs: (appName: string) => string[]): Promise<{ stdout: string; appName: string }> {
    const apps = cachedAppleScriptApp
      ? [cachedAppleScriptApp, ...appleScriptApps().filter((app) => app !== cachedAppleScriptApp)]
      : appleScriptApps();
    let firstError: unknown = null;
    for (const appName of apps) {
      try {
        const { stdout } = await execFileAsync("osascript", buildArgs(appName));
        cachedAppleScriptApp = appName;
        return { stdout, appName };
      } catch (error) {
        if (!firstError) firstError = error;
        if (cachedAppleScriptApp === appName) cachedAppleScriptApp = null;
      }
    }
    if (firstError instanceof Error) throw firstError;
    throw new Error(String(firstError || "Apple Events failed"));
  }
  
  if (toolName === "open_tab") {
    const url = appleScriptStringLiteral(args.url || "about:blank");
    await runAppleScript((appName) => [
      "-e",
      `tell application ${appleScriptStringLiteral(appName)} to tell window 1 to make new tab with properties {URL:${url}}`,
    ]);
    return { content: "Tab opened via Apple Events" };
  }

  if (toolName === "navigate") {
    const url = appleScriptStringLiteral(args.url || "about:blank");
    await runAppleScript((appName) => [
      "-e",
      `tell application ${appleScriptStringLiteral(appName)} to set URL of active tab of front window to ${url}`,
    ]);
    return { content: "Tab navigated via Apple Events" };
  }
  
  if (toolName === "get_active_tab") {
    const { stdout } = await runAppleScript((appName) => [
      "-e",
      `tell application ${appleScriptStringLiteral(appName)} to return URL of active tab of front window`,
    ]);
    return { content: stdout.trim() };
  }

  if (toolName === "get_tabs") {
    const { stdout } = await runAppleScript((appName) => [
      "-e",
      `tell application ${appleScriptStringLiteral(appName)}`,
      "-e",
      "set rows to {}",
      "-e",
      "set windowPosition to 0",
      "-e",
      "repeat with w in windows",
      "-e",
      "set windowPosition to windowPosition + 1",
      "-e",
      "set activeIndex to active tab index of w",
      "-e",
      "set tabPosition to 0",
      "-e",
      "repeat with t in tabs of w",
      "-e",
      "set tabPosition to tabPosition + 1",
      "-e",
      'set end of rows to ((id of t as text) & tab & (windowPosition as text) & tab & (tabPosition as text) & tab & ((tabPosition = activeIndex) as text) & tab & (title of t as text) & tab & (URL of t as text))',
      "-e",
      "end repeat",
      "-e",
      "end repeat",
      "-e",
      "set AppleScript's text item delimiters to linefeed",
      "-e",
      "return rows as text",
      "-e",
      "end tell",
    ]);
    const rows = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const tabs = rows.map((line) => {
      const [id, windowId, index, active, title, ...urlParts] = line.split("\t");
      const url = urlParts.join("\t");
      return {
        id: Number(id),
        windowId: Number(windowId),
        index: Number(index) - 1,
        active: active === "true",
        title,
        url,
      };
    });
    return { content: JSON.stringify(tabs, null, 2) };
  }
  
  throw new Error(`Apple Events failed for: ${toolName}`);
}

function labelRouterPlane(result: unknown, plane: "applescript" | "agent-browser"): unknown {
  const prefix = `[${plane}] `;
  if (typeof result === "string") return `${prefix}${result}`;
  if (result !== null && typeof result === "object") {
    if ("content" in result && typeof result.content === "string") {
      return { ...result, content: `${prefix}${result.content}` };
    }
    return { ...result, plane };
  }
  return { content: result, plane };
}

// Long waits (wait_for up to 2 min, request_user up to 30 min) need more than the default 60s round trip.
function callTimeoutMs(args: Record<string, any>): number {
  const requested = Number(args?.timeoutMs);
  if (!Number.isFinite(requested) || requested <= 45000) return 60000;
  return Math.min(requested, 30 * 60 * 1000) + 15000;
}

async function routerRequest(toolName: string, args: Record<string, any>): Promise<any> {
  // Handoff lifecycle is broker-owned; other control planes cannot preserve request identity.
  if (["request_user", "request_status", "request_cancel"].includes(toolName)) {
    const timeoutMs = callTimeoutMs(args);
    return await brokerRequest("tool", { tool: toolName, args, timeoutMs }, timeoutMs);
  }
  const errors: string[] = [];
  
  // Try 1: Extension (broker)
  if (!USE_AGENT_BACKEND || !USE_ROUTER_FALLBACKS) {
    try {
      const timeoutMs = callTimeoutMs(args);
      const result = await brokerRequest("tool", { tool: toolName, args, timeoutMs }, timeoutMs);
      logRouter(`SUCCESS[extension]: ${toolName}`);
      return result;
    } catch (err: any) {
      const msg = err?.message || String(err);
      errors.push(`extension: ${msg}`);
      logRouter(`FAIL[extension]: ${toolName} - ${msg}`);
      if (!USE_AGENT_BACKEND && !isPlaneUnavailable(msg)) throw err;
    }
  }
  
  // Try 2: Apple Events (for navigation/tab ops only)
  const appleScriptTools = ["open_tab", "navigate", "get_active_tab", "get_tabs"];
  if (USE_ROUTER_FALLBACKS && appleScriptTools.includes(toolName)) {
    try {
      const result = await tryAppleScript(toolName, args);
      logRouter(`SUCCESS[applescript]: ${toolName}`);
      return labelRouterPlane(result, "applescript");
    } catch (err: any) {
      const msg = err?.message || String(err);
      errors.push(`applescript: ${msg}`);
      logRouter(`FAIL[applescript]: ${toolName} - ${msg}`);
    }
  }
  
  // Try 3: Agent Browser
  if (USE_ROUTER_FALLBACKS && agentBackend) {
    try {
      const result = await agentBackend.requestTool(toolName, args);
      logRouter(`SUCCESS[agent]: ${toolName}`);
      return labelRouterPlane(result, "agent-browser");
    } catch (err: any) {
      const msg = err?.message || String(err);
      errors.push(`agent: ${msg}`);
      logRouter(`FAIL[agent]: ${toolName} - ${msg}`);
    }
  }
  
  // All failed
  throw new Error(`Router failed all attempts:\n${errors.join("\n")}`);
}

async function toolRequest(toolName: string, args: Record<string, any>): Promise<any> {
  return await routerRequest(toolName, args);
}

async function statusRequest(): Promise<any> {
  if (USE_AGENT_BACKEND) {
    if (!agentBackend) {
      return {
        backend: "agent-browser",
        connected: false,
        error: "Agent backend unavailable: configuration failed to initialize",
      };
    }
    return await agentBackend.status();
  }
  return await brokerRequest("status", {});
}

const plugin: Plugin = async (ctx) => {

  return {
    tool: {
      browser_debug: tool({
        description: "Debug plugin loading and connection status.",
        args: {},
        async execute(args, ctx) {
          if (ctx?.client?.app?.log) {
            await ctx.client.app.log({
              service: "iris",
              level: "info",
              message: "browser_debug called",
              extra: { sessionId, pid: process.pid },
            });
          }
          return JSON.stringify({
            loaded: true,
            sessionId,
            pid: process.pid,
            backend: USE_AGENT_BACKEND ? "agent-browser" : "extension",
            agentSession: agentBackend?.session ?? null,
            agentConnection: agentBackend?.connection ?? null,
            agentBrowserVersion: agentBackend?.getVersion?.() ?? null,
            pluginVersion: getPackageVersion(),
            timestamp: new Date().toISOString(),
          });
        },
      }),

      browser_version: tool({
        description: "Return the installed @mizner/iris-opencode plugin version.",
        args: {},
        async execute(args, ctx) {
          return JSON.stringify({
            name: "@mizner/iris-opencode",
            version: getPackageVersion(),
            sessionId,
            pid: process.pid,
            backend: USE_AGENT_BACKEND ? "agent-browser" : "extension",
            agentBrowserVersion: agentBackend?.getVersion?.() ?? null,
          });
        },
      }),

      browser_status: tool({
        description: "Check backend connection status, connected Chrome profiles, this session's profile, and tab claims.",
        args: {},
        async execute(args, ctx) {
          const data = await statusRequest();
          return JSON.stringify(data);
        },
      }),

      browser_health: tool({
        description: "Check health of all browser control planes (extension, applescript, agent).",
        args: {},
        async execute(args, ctx) {
          const health = {
            planes: {} as Record<string, { available: boolean; last_error?: string; last_latency_ms?: number }>,
            timestamp: new Date().toISOString(),
          };
          
          // Check extension
          try {
            const start = Date.now();
            await brokerRequest("status", {});
            health.planes.extension = { available: true, last_latency_ms: Date.now() - start };
          } catch (err: any) {
            health.planes.extension = { available: false, last_error: err?.message || String(err) };
          }
          
          // Check Apple Events
          try {
            const { exec } = require("child_process");
            const { promisify } = require("util");
            const execAsync = promisify(exec);
            const start = Date.now();
            await execAsync(`osascript -e 'tell application "Google Chrome" to return name of front window'`);
            health.planes.applescript = { available: true, last_latency_ms: Date.now() - start };
          } catch (err: any) {
            health.planes.applescript = { available: false, last_error: err?.message || String(err) };
          }
          
          // Check agent browser
          if (agentBackend) {
            try {
              const start = Date.now();
              await agentBackend.status();
              health.planes.agent_browser = { available: true, last_latency_ms: Date.now() - start };
            } catch (err: any) {
              health.planes.agent_browser = { available: false, last_error: err?.message || String(err) };
            }
          } else {
            health.planes.agent_browser = { available: false, last_error: "Agent backend not configured" };
          }
          
          return JSON.stringify(health);
        },
      }),

      browser_profiles: tool({
        description:
          "List Chrome profiles: name, account, purpose, connected, open sites, and which one this session uses. Call first when several profiles may be open.",
        args: {},
        async execute(args, ctx) {
          const data = await brokerOnlyRequest("profiles", {});
          return JSON.stringify(data);
        },
      }),

      browser_use_profile: tool({
        description: "Choose the Chrome profile (name or email) this session works in. Later calls stay in it.",
        args: {
          profile: schema.string(),
        },
        async execute({ profile }, ctx) {
          const data = await brokerOnlyRequest("use_profile", { profile });
          return JSON.stringify(data);
        },
      }),

      browser_resolve_profile: tool({
        description:
          "Suggest which Chrome profile fits a target url and a short task, with the reason and any tabs already open there. " +
          "Uses rules first and a decision model only for ties; confident=false means choose yourself or ask. pin=true also selects it.",
        args: {
          url: schema.string().optional(),
          task: schema.string().optional(),
          pin: schema.boolean().optional(),
        },
        async execute({ url, task, pin }, ctx) {
          const data = await brokerOnlyRequest("resolve_profile", { url, task, pin });
          return JSON.stringify(data);
        },
      }),

      browser_run: tool({
        description:
          "Pursue one short goal in a background tab with a fast decision model choosing each click or typing step. " +
          "Text is typed only from facts (\"name=value\"). Stops with done, unsure, blocked, needs_agent, stuck, or max_steps; " +
          "verify the page after done. Returns status unavailable when no decision model key is configured.",
        args: {
          goal: schema.string(),
          url: schema.string().optional(),
          facts: schema.array(schema.string()).optional(),
          tabId: schema.number().optional(),
          profile: schema.string().optional(),
          maxSteps: schema.number().optional(),
          allowIrreversible: schema.boolean().optional(),
        },
        async execute({ goal, url, facts, tabId, profile, maxSteps, allowIrreversible }, ctx) {
          const data = await brokerRequest(
            "run",
            { goal, url, facts, tabId, profile, maxSteps, allowIrreversible },
            180000
          );
          return JSON.stringify(data);
        },
      }),

      browser_get_tabs: tool({
        description:
          "List open tabs. Before a profile is chosen this lists every connected profile's tabs, each labeled with its profile.",
        args: {
          profile: schema.string().optional(),
        },
        async execute({ profile }, ctx) {
          const data = await toolRequest("get_tabs", { profile });
          return toolResultText(data, "ok");
        },
      }),

      browser_get_active_tab: tool({
        description: "Return the tab the user is looking at (the focused window's active tab), with its profile.",
        args: {
          profile: schema.string().optional(),
        },
        async execute({ profile }, ctx) {
          const data = await toolRequest("get_active_tab", { profile });
          return toolResultText(data, "ok");
        },
      }),

      browser_list_claims: tool({
        description: "List tab ownership claims",
        args: {},
        async execute(args, ctx) {
          const data = await brokerOnlyRequest("list_claims", {});
          return JSON.stringify(data);
        },
      }),

      browser_claim_tab: tool({
        description: "Claim a browser tab for this session",
        args: {
          tabId: schema.number(),
          force: schema.boolean().optional(),
        },
        async execute({ tabId, force }, ctx) {
          const data = await brokerOnlyRequest("claim_tab", { tabId, force, handoffOwner: ctx?.sessionID });
          return JSON.stringify(data);
        },
      }),

      browser_release_tab: tool({
        description: "Release a claimed browser tab",
        args: {
          tabId: schema.number(),
        },
        async execute({ tabId }, ctx) {
          const data = await brokerOnlyRequest("release_tab", { tabId, handoffOwner: ctx?.sessionID });
          return JSON.stringify(data);
        },
      }),

      browser_open_tab: tool({
        description: "Open a new tab in the background (active=true brings it to the front; avoid unless needed).",
        args: {
          url: schema.string().optional(),
          active: schema.boolean().optional(),
          profile: schema.string().optional(),
        },
        async execute({ url, active, profile }, ctx) {
          const data = await toolRequest("open_tab", { url, active, profile });
          return toolResultText(data, "Opened new tab");
        },
      }),

      browser_close_tab: tool({
        description: "Close a browser tab owned by this session",
        args: {
          tabId: schema.number().optional(),
        },
        async execute({ tabId }, ctx) {
          const data = await toolRequest("close_tab", { tabId });
          return toolResultText(data, "Closed tab");
        },
      }),

      browser_navigate: tool({
        description: "Navigate a tab to a URL. Without tabId this uses the session's own background tab.",
        args: {
          url: schema.string(),
          tabId: schema.number().optional(),
          profile: schema.string().optional(),
        },
        async execute({ url, tabId, profile }, ctx) {
          const data = await toolRequest("navigate", { url, tabId, profile });
          return toolResultText(data, `Navigated to ${url}`);
        },
      }),

      browser_history: tool({
        description: "Go back, forward, or reload the current tab.",
        args: {
          action: schema.string(),
          tabId: schema.number().optional(),
        },
        async execute({ action, tabId }, ctx) {
          const data = await toolRequest("history", { action, tabId });
          return toolResultText(data, `History ${action}`);
        },
      }),

      browser_handle_dialog: tool({
        description: "Accept or dismiss a JavaScript alert/confirm/prompt/beforeunload dialog.",
        args: {
          accept: schema.boolean(),
          promptText: schema.string().optional(),
          tabId: schema.number().optional(),
        },
        async execute({ accept, promptText, tabId }, ctx) {
          const data = await toolRequest("handle_dialog", { accept, promptText, tabId });
          return toolResultText(data, accept ? "Accepted dialog" : "Dismissed dialog");
        },
      }),

      browser_click: tool({
        description:
          "Click an element. Optional button (left/right/middle), clickCount (2 = double-click), and modifiers.",
        args: {
          selector: schema.string(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
          button: schema.string().optional(),
          clickCount: schema.number().optional(),
          modifiers: schema.array(schema.string()).optional(),
        },
        async execute({ selector, index, tabId, timeoutMs, pollMs, button, clickCount, modifiers }, ctx) {
          const data = await toolRequest("click", {
            selector,
            index,
            tabId,
            timeoutMs,
            pollMs,
            button,
            clickCount,
            modifiers,
          });
          return toolResultText(data, `Clicked ${selector}`);
        },
      }),

      browser_hover: tool({
        description: "Hover the pointer over an element (opens CSS menus, tooltips).",
        args: {
          selector: schema.string(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, index, tabId, timeoutMs, pollMs }, ctx) {
          const data = await toolRequest("hover", { selector, index, tabId, timeoutMs, pollMs });
          return toolResultText(data, `Hovered ${selector}`);
        },
      }),

      browser_drag: tool({
        description: "Drag from one element to another (selector or uid locators).",
        args: {
          fromSelector: schema.string().optional(),
          selector: schema.string().optional(),
          toSelector: schema.string(),
          fromIndex: schema.number().optional(),
          toIndex: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ fromSelector, selector, toSelector, fromIndex, toIndex, tabId, timeoutMs, pollMs }, ctx) {
          const data = await toolRequest("drag", {
            fromSelector,
            selector,
            toSelector,
            fromIndex,
            toIndex,
            tabId,
            timeoutMs,
            pollMs,
          });
          return toolResultText(data, `Dragged to ${toSelector}`);
        },
      }),

      browser_type: tool({
        description: "Type text into an input element",
        args: {
          selector: schema.string(),
          text: schema.string(),
          clear: schema.boolean().optional(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, text, clear, index, tabId, timeoutMs, pollMs }, ctx) {
          const data = await toolRequest("type", { selector, text, clear, index, tabId, timeoutMs, pollMs });
          return toolResultText(data, `Typed "${text}" into ${selector}`);
        },
      }),

      browser_press: tool({
        description:
          "Press a keyboard key (Enter, Tab, Escape, arrows, or a character), optionally with modifiers and a focus selector.",
        args: {
          key: schema.string(),
          modifiers: schema.array(schema.string()).optional(),
          selector: schema.string().optional(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ key, modifiers, selector, index, tabId, timeoutMs, pollMs }, ctx) {
          const data = await toolRequest("press", { key, modifiers, selector, index, tabId, timeoutMs, pollMs });
          return toolResultText(data, `Pressed ${key}`);
        },
      }),

      browser_select: tool({
        description: "Select an option in a native select element",
        args: {
          selector: schema.string(),
          value: schema.string().optional(),
          label: schema.string().optional(),
          optionIndex: schema.number().optional(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, value, label, optionIndex, index, tabId, timeoutMs, pollMs }, ctx) {
          const data = await toolRequest("select", { selector, value, label, optionIndex, index, tabId, timeoutMs, pollMs });
          const summary = value ?? label ?? (optionIndex != null ? String(optionIndex) : "option");
          return toolResultText(data, `Selected ${summary} in ${selector}`);
        },
      }),

      browser_screenshot: tool({
        description:
          "Take a screenshot of the current page (visible, full-page, selector, or clip). annotate=true draws uid labels on interactive elements (click them with selector=\"uid:e12\") and returns the label list. ifChanged=true returns {unchanged:true} instead of an identical image. savePath writes the image to disk and returns the path instead of image data.",
        args: {
          tabId: schema.number().optional(),
          annotate: schema.boolean().optional(),
          ifChanged: schema.boolean().optional(),
          savePath: schema.string().optional(),
          fullPage: schema.boolean().optional(),
          selector: schema.string().optional(),
          index: schema.number().optional(),
          x: schema.number().optional(),
          y: schema.number().optional(),
          width: schema.number().optional(),
          height: schema.number().optional(),
          format: schema.string().optional(),
          quality: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute(
          { tabId, annotate, ifChanged, savePath, fullPage, selector, index, x, y, width, height, format, quality, timeoutMs, pollMs },
          ctx
        ) {
          const data = await toolRequest("screenshot", {
            tabId,
            annotate,
            ifChanged,
            fullPage,
            selector,
            index,
            x,
            y,
            width,
            height,
            format,
            quality,
            timeoutMs,
            pollMs,
          });
          const text = toolResultText(data, "Screenshot failed");
          return savePath ? saveScreenshot(text, savePath) : text;
        },
      }),

      browser_snapshot: tool({
        description:
          "Capture an accessibility snapshot. First call (or full=true, or changed filters) returns all nodes; later calls return a uid-preserving diff. interactive=true keeps only clickable/typeable elements and drops page text (much smaller). selector limits it to one part of the page (CSS or uid:eN). maxNodes caps the node count (default 800).",
        args: {
          tabId: schema.number().optional(),
          full: schema.boolean().optional(),
          interactive: schema.boolean().optional(),
          selector: schema.string().optional(),
          includeText: schema.boolean().optional(),
          maxNodes: schema.number().optional(),
        },
        async execute({ tabId, full, interactive, selector, includeText, maxNodes }, ctx) {
          const data = await toolRequest("snapshot", { tabId, full, interactive, selector, includeText, maxNodes });
          return toolResultText(data, "Snapshot failed");
        },
      }),

      browser_scroll: tool({
        description: "Scroll the page or scroll an element into view",
        args: {
          selector: schema.string().optional(),
          x: schema.number().optional(),
          y: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, x, y, tabId, timeoutMs, pollMs }, ctx) {
          const data = await toolRequest("scroll", { selector, x, y, tabId, timeoutMs, pollMs });
          return toolResultText(data, "Scrolled");
        },
      }),

      browser_wait: tool({
        description: "Wait for a specified duration",
        args: {
          ms: schema.number().optional(),
          tabId: schema.number().optional(),
        },
        async execute({ ms, tabId }, ctx) {
          const data = await toolRequest("wait", { ms, tabId });
          return toolResultText(data, "Waited");
        },
      }),

      browser_wait_for: tool({
        description: "Wait for a selector, text, page-text regex, URL pattern, or network idle condition.",
        args: {
          selector: schema.string().optional(),
          text: schema.string().optional(),
          pattern: schema.string().optional(),
          urlPattern: schema.string().optional(),
          state: schema.string().optional(),
          networkIdleMs: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
          index: schema.number().optional(),
          flags: schema.string().optional(),
          tabId: schema.number().optional(),
        },
        async execute({ selector, text, pattern, urlPattern, state, networkIdleMs, timeoutMs, pollMs, index, flags, tabId }, ctx) {
          const data = await toolRequest("wait_for", {
            selector,
            text,
            pattern,
            urlPattern,
            state,
            networkIdleMs,
            timeoutMs,
            pollMs,
            index,
            flags,
            tabId,
          });
          return toolResultText(data, "Wait condition failed");
        },
      }),

      browser_query: tool({
        description:
          "Read data from the page using selectors, optional wait, or page_text extraction (shadow DOM + same-origin iframes). mode: text (default), value, attribute, property, html, list (alias all), exists (alias count; returns {exists,count} instead of failing), page_text (no selector needed).",
        args: {
          selector: schema.string().optional(),
          mode: schema.string().optional(),
          attribute: schema.string().optional(),
          property: schema.string().optional(),
          index: schema.number().optional(),
          limit: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
          pattern: schema.string().optional(),
          flags: schema.string().optional(),
          tabId: schema.number().optional(),
        },
        async execute({ selector, mode, attribute, property, index, limit, timeoutMs, pollMs, pattern, flags, tabId }, ctx) {
          const data = await toolRequest("query", {
            selector,
            mode,
            attribute,
            property,
            index,
            limit,
            timeoutMs,
            pollMs,
            pattern,
            flags,
            tabId,
          });
          return toolResultText(data, "Query failed");
        },
      }),

      browser_download: tool({
        description: "Download a file via URL or by clicking an element on the page.",
        args: {
          url: schema.string().optional(),
          selector: schema.string().optional(),
          filename: schema.string().optional(),
          conflictAction: schema.string().optional(),
          saveAs: schema.boolean().optional(),
          wait: schema.boolean().optional(),
          downloadTimeoutMs: schema.number().optional(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute(
          { url, selector, filename, conflictAction, saveAs, wait, downloadTimeoutMs, index, tabId, timeoutMs, pollMs },
          ctx
        ) {
          const data = await toolRequest("download", {
            url,
            selector,
            filename,
            conflictAction,
            saveAs,
            wait,
            downloadTimeoutMs,
            index,
            tabId,
            timeoutMs,
            pollMs,
          });
          return toolResultText(data, "Download started");
        },
      }),

      browser_list_downloads: tool({
        description: "List recent downloads (Chrome backend) or session downloads (agent backend).",
        args: {
          limit: schema.number().optional(),
          state: schema.string().optional(),
          profile: schema.string().optional(),
        },
        async execute({ limit, state, profile }, ctx) {
          const data = await toolRequest("list_downloads", { limit, state, profile });
          return toolResultText(data, "[]");
        },
      }),

      browser_set_file_input: tool({
        description: "Set a file input element's selected file using a local file path.",
        args: {
          selector: schema.string(),
          filePath: schema.string(),
          fileName: schema.string().optional(),
          mimeType: schema.string().optional(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, filePath, fileName, mimeType, index, tabId, timeoutMs, pollMs }, ctx) {
          if (USE_AGENT_BACKEND) {
            const data = await toolRequest("set_file_input", { selector, filePath, tabId, index, timeoutMs, pollMs });
            return toolResultText(data, "Set file input");
          }

          const file = buildFileUploadPayload(filePath, fileName, mimeType);
          const data = await toolRequest("set_file_input", {
            selector,
            tabId,
            index,
            timeoutMs,
            pollMs,
            files: [file],
          });
          return toolResultText(data, "Set file input");
        },
      }),

      browser_highlight: tool({
        description: "Highlight an element on the page with a colored border for visual debugging.",
        args: {
          selector: schema.string(),
          index: schema.number().optional(),
          duration: schema.number().optional(),
          color: schema.string().optional(),
          showInfo: schema.boolean().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, index, duration, color, showInfo, tabId, timeoutMs, pollMs }, ctx) {
          const data = await toolRequest("highlight", {
            selector,
            index,
            duration,
            color,
            showInfo,
            tabId,
            timeoutMs,
            pollMs,
          });
          return toolResultText(data, "Highlight failed");
        },
      }),

      browser_console: tool({
        description:
          "Read console log messages from the page. Uses chrome.debugger API for complete capture. " +
          "The debugger attaches lazily on first call and may show a banner in the browser.",
        args: {
          tabId: schema.number().optional(),
          clear: schema.boolean().optional(),
          filter: schema.string().optional(),
        },
        async execute({ tabId, clear, filter }, ctx) {
          const data = await toolRequest("console", { tabId, clear, filter });
          return toolResultText(data, "[]");
        },
      }),

      browser_errors: tool({
        description:
          "Read JavaScript errors from the page. Uses chrome.debugger API for complete capture. " +
          "The debugger attaches lazily on first call and may show a banner in the browser.",
        args: {
          tabId: schema.number().optional(),
          clear: schema.boolean().optional(),
        },
        async execute({ tabId, clear }, ctx) {
          const data = await toolRequest("errors", { tabId, clear });
          return toolResultText(data, "[]");
        },
      }),

      browser_network_start: tool({
        description:
          "Start capturing network requests for a tab using the Chrome debugger API. Headers are redacted in later output.",
        args: {
          tabId: schema.number().optional(),
          clear: schema.boolean().optional(),
          maxEntries: schema.number().optional(),
        },
        async execute({ tabId, clear, maxEntries }, ctx) {
          const data = await toolRequest("network_start", { tabId, clear, maxEntries });
          return toolResultText(data, "Network capture started");
        },
      }),

      browser_network_stop: tool({
        description:
          "Stop network capture for a tab while keeping captured records available until cleared. Detaches the debugger (removing Chrome's debugging bar, which also stops console/error capture) unless detach=false.",
        args: {
          tabId: schema.number().optional(),
          detach: schema.boolean().optional(),
        },
        async execute({ tabId, detach }, ctx) {
          const data = await toolRequest("network_stop", { tabId, detach });
          return toolResultText(data, "Network capture stopped");
        },
      }),

      browser_network_list: tool({
        description: "List captured network requests for a tab. Headers are omitted unless includeHeaders is true.",
        args: {
          tabId: schema.number().optional(),
          limit: schema.number().optional(),
          includeHeaders: schema.boolean().optional(),
          filter: schema.string().optional(),
          clear: schema.boolean().optional(),
        },
        async execute({ tabId, limit, includeHeaders, filter, clear }, ctx) {
          const data = await toolRequest("network_list", { tabId, limit, includeHeaders, filter, clear });
          return toolResultText(data, "[]");
        },
      }),

      browser_network_get: tool({
        description:
          "Get details for a captured network request. Response body is omitted unless includeBody is true.",
        args: {
          tabId: schema.number().optional(),
          requestId: schema.string().optional(),
          index: schema.number().optional(),
          includeBody: schema.boolean().optional(),
          maxBodyBytes: schema.number().optional(),
        },
        async execute({ tabId, requestId, index, includeBody, maxBodyBytes }, ctx) {
          const data = await toolRequest("network_get", { tabId, requestId, index, includeBody, maxBodyBytes });
          return toolResultText(data, "{}");
        },
      }),

      browser_profile_status: tool({
        description: "Return allowlist gating status per Chrome profile (or for one profile).",
        args: {
          profile: schema.string().optional(),
        },
        async execute({ profile }, ctx) {
          const data = await toolRequest("get_profile_status", { profile });
          return toolResultText(data, "{}");
        },
      }),

      browser_webmcp_status: tool({
        description: "Detect WebMCP/native model context signals on the current page.",
        args: {
          tabId: schema.number().optional(),
        },
        async execute({ tabId }, ctx) {
          const data = await toolRequest("get_webmcp_status", { tabId });
          return toolResultText(data, "{}");
        },
      }),

      browser_name_group: tool({
        description:
          "Name this session's Chrome tab group after the task (2-4 words, e.g. \"Codeable Neverland\"); the harness is appended (\"Codeable Neverland · omo\"). Call it once the task is clear. Optional color: grey, blue, red, yellow, green, pink, purple, cyan, orange.",
        args: {
          name: schema.string(),
          color: schema.string().optional(),
        },
        async execute({ name, color }, ctx) {
          const data = await brokerOnlyRequest("name_group", { name, color });
          return JSON.stringify(data, null, 2);
        },
      }),

      browser_read: tool({
        description:
          "Read the page as clean markdown (headings, lists, tables, links), the cheapest way to read content. Uses <main>/<article> when present and skips nav/header/footer/aside. selector limits it to one part (CSS or uid:eN). outline=true returns only the heading outline. Long pages are paged: pass offset from the truncation note.",
        args: {
          selector: schema.string().optional(),
          maxChars: schema.number().optional(),
          offset: schema.number().optional(),
          outline: schema.boolean().optional(),
          includeLinks: schema.boolean().optional(),
          includeImages: schema.boolean().optional(),
          includeChrome: schema.boolean().optional(),
          tabId: schema.number().optional(),
        },
        async execute({ selector, maxChars, offset, outline, includeLinks, includeImages, includeChrome, tabId }, ctx) {
          const data = await toolRequest("read", { selector, maxChars, offset, outline, includeLinks, includeImages, includeChrome, tabId });
          return toolResultText(data, "");
        },
      }),

      browser_search_history: tool({
        description:
          "Search this Chrome profile's browsing history (title and URL text). query=\"\" lists recent visits. days limits how far back (default 30). Before a profile is chosen, searches every connected profile and labels results by profile.",
        args: {
          query: schema.string().optional(),
          days: schema.number().optional(),
          maxResults: schema.number().optional(),
          profile: schema.string().optional(),
        },
        async execute({ query, days, maxResults, profile }, ctx) {
          const data = await toolRequest("search_history", { query, days, maxResults, profile });
          return toolResultText(data, "[]");
        },
      }),

      browser_bookmarks: tool({
        description:
          "Search this Chrome profile's bookmarks (with folder path). Without query, lists the most recently added. Before a profile is chosen, searches every connected profile.",
        args: {
          query: schema.string().optional(),
          maxResults: schema.number().optional(),
          profile: schema.string().optional(),
        },
        async execute({ query, maxResults, profile }, ctx) {
          const data = await toolRequest("bookmarks", { query, maxResults, profile });
          return toolResultText(data, "[]");
        },
      }),

      browser_recently_closed: tool({
        description:
          "List recently closed tabs and windows (with sessionId), and with devices=true the open tabs on the user's other signed-in devices. restore=<sessionId> reopens one (pass the profile it came from) and returns its tabId.",
        args: {
          maxResults: schema.number().optional(),
          devices: schema.boolean().optional(),
          restore: schema.string().optional(),
          profile: schema.string().optional(),
        },
        async execute({ maxResults, devices, restore, profile }, ctx) {
          const data = await toolRequest("recently_closed", { maxResults, devices, restore, profile });
          return toolResultText(data, "{}");
        },
      }),

      browser_upload: tool({
        description:
          "Upload local files by path. selector is the input[type=file] or the button that opens the file chooser; Iris clicks it and fills Chrome's chooser directly, so no OS dialog appears. Works in background tabs and with custom upload buttons. Uses the debugger.",
        args: {
          selector: schema.string(),
          files: schema.array(schema.string()),
          index: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          tabId: schema.number().optional(),
        },
        async execute({ selector, files, index, timeoutMs, tabId }, ctx) {
          const paths = (files || []).map((file: string) => resolveUploadPath(file));
          const missing = paths.filter((file: string) => !existsSync(file));
          if (missing.length) throw new Error(`File not found: ${missing.join(", ")}`);
          const data = await toolRequest("upload", { selector, files: paths, index, timeoutMs, tabId });
          return toolResultText(data, "Uploaded");
        },
      }),

      browser_request_user: tool({
        description: "Hand the tab to the user for sign-in, 2FA, CAPTCHA, or a choice. Shows a profile-prefixed banner with Done and a notification. Default wait=true blocks until a URL/selector/text condition, Done, or timeout (default 300000ms, max 1800000ms). Set wait=false to return immediately with status=pending and requestId; use browser_request_status or browser_request_cancel while continuing the conversation. Terminal status: condition_met | user_done | timeout | tab_closed | unreadable_page | cancelled. Selector/text waits report unreadable_page with reason/location if page access fails; URL-only waits work without page access. Async requests are session/profile-owned; terminal results are retained for 10 minutes, and pending requests renew the tab claim.",
        args: {
          message: schema.string(),
          urlPattern: schema.string().optional(),
          selector: schema.string().optional(),
          text: schema.string().optional(),
          timeoutMs: schema.number().optional(),
          wait: schema.boolean().optional(),
          focus: schema.boolean().optional(),
          tabId: schema.number().optional(),
        },
        async execute({ message, urlPattern, selector, text, timeoutMs, wait, focus, tabId }, ctx) {
          const data = await toolRequest("request_user", {
            message,
            urlPattern,
            selector,
            text,
            timeoutMs: timeoutMs ?? 300000,
            wait,
            handoffOwner: ctx?.sessionID,
            focus,
            tabId,
          });
          return wait === false ? handoffResultText(data) : toolResultText(data, "{}");
        },
      }),

      browser_request_status: tool({
        description: "Read a nonblocking browser_request_user request without waiting. Returns pending or its terminal result (condition_met, user_done, timeout, tab_closed, unreadable_page, cancelled), with requestId, tabId and profile. Only the creating session and profile may access it. Terminal results expire after 10 minutes.",
        args: { requestId: schema.string() },
        async execute({ requestId }, ctx) {
          return handoffResultText(await toolRequest("request_status", { requestId, handoffOwner: ctx?.sessionID }));
        },
      }),

      browser_request_cancel: tool({
        description: "Cancel a nonblocking browser_request_user request and remove its banner/notification. Idempotent: an already completed or cancelled request keeps its terminal result. Only the creating session and profile may cancel it. Terminal results expire after 10 minutes.",
        args: { requestId: schema.string() },
        async execute({ requestId }, ctx) {
          return handoffResultText(await toolRequest("request_cancel", { requestId, handoffOwner: ctx?.sessionID }));
        },
      }),

      browser_evaluate: tool({
        description:
          "Evaluate a JavaScript expression in the page's main world and return the JSON result (promises are awaited; top-level await works). Uses the debugger (ignores page CSP); falls back to a main-world script. For statements, use an IIFE: (() => { ... })().",
        args: {
          expression: schema.string(),
          awaitPromise: schema.boolean().optional(),
          maxChars: schema.number().optional(),
          tabId: schema.number().optional(),
        },
        async execute({ expression, awaitPromise, maxChars, tabId }, ctx) {
          const data = await toolRequest("evaluate", { expression, awaitPromise, maxChars, tabId });
          return toolResultText(data, "undefined");
        },
      }),
    },
  };
};

export default plugin;
