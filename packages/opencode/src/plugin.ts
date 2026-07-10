import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { BASE_DIR, SOCKET_PATH as DEFAULT_SOCKET_PATH } from "@mizner/iris/paths";
import net from "net";
import { createAgentBackend, type AgentBackend } from "./agent-backend.js";
import { existsSync, mkdirSync, openSync, readFileSync, statSync } from "fs";
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
    const child = spawn(process.execPath, [brokerPath], { detached: true, stdio: ["ignore", "ignore", out] });
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

  writeJsonLine(socket, { type: "hello", role: "plugin", sessionId, pid: process.pid });

  return socket;
}

async function brokerRequest(op: string, payload: Record<string, any>): Promise<any> {
  const s = await ensureBrokerSocket();
  const id = ++reqId;

  return await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    writeJsonLine(s, { type: "request", id, op, ...payload });
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error("Timed out waiting for broker response"));
    }, 60000);
  });
}

async function brokerOnlyRequest(op: string, payload: Record<string, any>): Promise<any> {
  if (USE_AGENT_BACKEND) {
    throw new Error("Tab claims are not supported with agent-browser backend");
  }
  return await brokerRequest(op, payload);
}

function toolResultText(data: any, fallback: string): string {
  if (typeof data?.content === "string") return data.content;
  if (typeof data === "string") return data;
  if (data?.content != null) return JSON.stringify(data.content);
  return fallback;
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

async function routerRequest(toolName: string, args: Record<string, any>): Promise<any> {
  const errors: string[] = [];
  
  // Try 1: Extension (broker)
  if (!USE_AGENT_BACKEND || !USE_ROUTER_FALLBACKS) {
    try {
      const result = await brokerRequest("tool", { tool: toolName, args });
      logRouter(`SUCCESS[extension]: ${toolName}`);
      return result;
    } catch (err: any) {
      const msg = err?.message || String(err);
      errors.push(`extension: ${msg}`);
      logRouter(`FAIL[extension]: ${toolName} - ${msg}`);
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
        description: "Check backend connection status and current tab claims.",
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

      browser_get_tabs: tool({
        description: "List all open browser tabs",
        args: {},
        async execute(args, ctx) {
          const data = await toolRequest("get_tabs", {});
          return toolResultText(data, "ok");
        },
      }),

      browser_get_active_tab: tool({
        description: "Return the active browser tab",
        args: {},
        async execute(args, ctx) {
          const data = await toolRequest("get_active_tab", {});
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
          const data = await brokerOnlyRequest("claim_tab", { tabId, force });
          return JSON.stringify(data);
        },
      }),

      browser_release_tab: tool({
        description: "Release a claimed browser tab",
        args: {
          tabId: schema.number(),
        },
        async execute({ tabId }, ctx) {
          const data = await brokerOnlyRequest("release_tab", { tabId });
          return JSON.stringify(data);
        },
      }),

      browser_open_tab: tool({
        description: "Open a new browser tab",
        args: {
          url: schema.string().optional(),
          active: schema.boolean().optional(),
        },
        async execute({ url, active }, ctx) {
          const data = await toolRequest("open_tab", { url, active });
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
        description: "Navigate to a URL in the browser",
        args: {
          url: schema.string(),
          tabId: schema.number().optional(),
        },
        async execute({ url, tabId }, ctx) {
          const data = await toolRequest("navigate", { url, tabId });
          return toolResultText(data, `Navigated to ${url}`);
        },
      }),

      browser_click: tool({
        description: "Click an element on the page using a CSS selector",
        args: {
          selector: schema.string(),
          index: schema.number().optional(),
          tabId: schema.number().optional(),
          timeoutMs: schema.number().optional(),
          pollMs: schema.number().optional(),
        },
        async execute({ selector, index, tabId, timeoutMs, pollMs }, ctx) {
          const data = await toolRequest("click", { selector, index, tabId, timeoutMs, pollMs });
          return toolResultText(data, `Clicked ${selector}`);
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
        description: "Take a screenshot of the current page. Supports visible, full-page, selector, and manual clip captures. Returns base64 image data URL.",
        args: {
          tabId: schema.number().optional(),
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
        async execute({ tabId, fullPage, selector, index, x, y, width, height, format, quality, timeoutMs, pollMs }, ctx) {
          const data = await toolRequest("screenshot", {
            tabId,
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
          return toolResultText(data, "Screenshot failed");
        },
      }),

      browser_snapshot: tool({
        description: "Get an accessibility tree snapshot of the page.",
        args: {
          tabId: schema.number().optional(),
        },
        async execute({ tabId }, ctx) {
          const data = await toolRequest("snapshot", { tabId });
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
          "Read data from the page using selectors, optional wait, or page_text extraction (shadow DOM + same-origin iframes).",
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
        },
        async execute({ limit, state }, ctx) {
          const data = await toolRequest("list_downloads", { limit, state });
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
        description: "Stop network capture for a tab while keeping captured records available until cleared.",
        args: {
          tabId: schema.number().optional(),
        },
        async execute({ tabId }, ctx) {
          const data = await toolRequest("network_stop", { tabId });
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
        description: "Return Iris profile gating status for the active Chrome profile.",
        args: {},
        async execute(args, ctx) {
          const data = await toolRequest("get_profile_status", {});
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
    },
  };
};

export default plugin;
