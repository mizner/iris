#!/usr/bin/env node
"use strict";

/**
 * browser-cli.cjs — Thin CLI for browser control via broker socket.
 *
 * Usage:
 *   node browser-cli.cjs <tool> [json-args]
 *   node browser-cli.cjs <tool> --key value --key2 value2
 *   node browser-cli.cjs status
 *
 * Examples:
 *   node browser-cli.cjs open_tab '{"url":"https://example.com"}'
 *   node browser-cli.cjs navigate --url https://example.com --tabId 123
 *   node browser-cli.cjs snapshot --tabId 123
 *   node browser-cli.cjs get_tabs
 *   node browser-cli.cjs status
 *
 *   node browser-cli.cjs profiles
 *   node browser-cli.cjs get_tabs --profile work
 *   IRIS_PROFILE=work node browser-cli.cjs snapshot
 *
 * Environment:
 *   BROWSER_SESSION  — Override session ID (default: auto-generated)
 *   BROWSER_TIMEOUT  — Request timeout in ms (default: 15000; run uses at least 120000)
 *   IRIS_PROFILE     — Chrome profile (alias or email) for this invocation
 *
 * Exit codes:
 *   0 = success (JSON on stdout)
 *   1 = broker/extension error (error JSON on stderr)
 *   2 = usage error
 */

const net = require("net");
const os = require("os");
const path = require("path");

const BASE_DIR = path.join(os.homedir(), ".iris");
const SOCKET_PATH = path.join(BASE_DIR, "broker.sock");
const TIMEOUT_MS = parseInt(process.env.BROWSER_TIMEOUT, 10) || 15000;
const SESSION_ID = process.env.BROWSER_SESSION || "cli-" + process.pid;

// --- Arg parsing ---

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
  process.stderr.write(
    "Usage: browser-cli.cjs <tool|status> [json-args | --key value ...]\n" +
    "\nTools: open_tab, navigate, snapshot, query, get_tabs, get_active_tab,\n" +
    "       click, hover, drag, type, select, scroll, screenshot, close_tab, wait, wait_for,\n" +
    "       history, handle_dialog,\n" +
    "       console, errors, network_start, network_stop, network_list, network_get,\n" +
    "       download, highlight, set_file_input,\n" +
    "       get_profile_status, get_webmcp_status, request_user, evaluate\n" +
    "\nOps:   status, list_claims, claim_tab, release_tab,\n" +
    "       profiles, use_profile --profile <name>, resolve_profile --url <url> --task <text>,\n" +
    "       run --goal <text> [--url <url>] [--facts '[\"name=value\"]']\n" +
    "\nAny tool accepts --profile <alias|email>; IRIS_PROFILE sets it for every call.\n"
  );
  process.exit(2);
}

const command = argv[0];
let args = {};

if (argv.length > 1) {
  // Try JSON first
  if (argv[1].startsWith("{")) {
    try {
      args = JSON.parse(argv.slice(1).join(" "));
    } catch (e) {
      process.stderr.write("Invalid JSON: " + e.message + "\n");
      process.exit(2);
    }
  } else {
    // Parse --key value pairs
    for (let i = 1; i < argv.length; i++) {
      const key = argv[i];
      if (!key.startsWith("--")) {
        process.stderr.write("Expected --key, got: " + key + "\n");
        process.exit(2);
      }
      const name = key.slice(2);
      const val = argv[++i];
      if (val === undefined) {
        // boolean flag
        args[name] = true;
      } else if (val === "true") {
        args[name] = true;
      } else if (val === "false") {
        args[name] = false;
      } else if (/^-?\d+$/.test(val)) {
        args[name] = parseInt(val, 10);
      } else if (/^-?\d+\.\d+$/.test(val)) {
        args[name] = parseFloat(val);
      } else {
        args[name] = val;
      }
    }
  }
}

// --- Broker ops vs tool ops ---

const BROKER_OPS = ["status", "list_claims", "claim_tab", "release_tab", "profiles", "use_profile", "resolve_profile", "run"];
const isBrokerOp = BROKER_OPS.includes(command);
const PROFILE = (process.env.IRIS_PROFILE || "").trim();
if (typeof args.facts === "string" && args.facts.trim().startsWith("[")) {
  try {
    args.facts = JSON.parse(args.facts);
  } catch {}
}

// --- Socket communication ---

let buffer = "";
let replied = false;

function die(msg, code) {
  if (replied) return;
  replied = true;
  // Exit only after the write drains: process.exit() right after a large write truncates piped output.
  process.stderr.write(JSON.stringify({ error: msg }) + "\n", () => process.exit(code || 1));
}

function succeed(data) {
  if (replied) return;
  replied = true;
  process.stdout.write(JSON.stringify(data, null, 2) + "\n", () => process.exit(0));
}

// Long waits (wait_for, request_user) get their own timeoutMs plus a margin, and the broker is told to wait as long.
const REQUESTED_WAIT_MS = Number.isFinite(args.timeoutMs) ? args.timeoutMs + 15000 : 0;
const EFFECTIVE_TIMEOUT_MS = Math.max(command === "run" ? Math.max(TIMEOUT_MS, 120000) : TIMEOUT_MS, REQUESTED_WAIT_MS);
const timer = setTimeout(() => die("Timeout after " + EFFECTIVE_TIMEOUT_MS + "ms", 1), EFFECTIVE_TIMEOUT_MS);

const sock = net.createConnection(SOCKET_PATH, () => {
  // Handshake
  sock.write(
    JSON.stringify({ type: "hello", role: "plugin", sessionId: SESSION_ID, pid: process.pid, profile: PROFILE || undefined }) + "\n"
  );

  // Send request immediately (broker doesn't ack hello for plugins)
  if (isBrokerOp) {
    const payload = { type: "request", id: 1, op: command };
    // Merge args into payload for claim_tab/release_tab which need tabId at top level
    Object.assign(payload, args);
    sock.write(JSON.stringify(payload) + "\n");
  } else {
    const timeoutMs = REQUESTED_WAIT_MS || undefined;
    sock.write(JSON.stringify({ type: "request", id: 1, op: "tool", tool: command, args, timeoutMs }) + "\n");
  }
});

sock.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  while (true) {
    const idx = buffer.indexOf("\n");
    if (idx === -1) return;
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.type === "response" && msg.id === 1) {
        clearTimeout(timer);
        if (msg.ok) {
          succeed(msg.data);
        } else {
          die(msg.error || "Unknown error", 1);
        }
      }
    } catch {}
  }
});

sock.on("error", (e) => {
  clearTimeout(timer);
  die("Socket error: " + e.message + ". Is the broker running?", 1);
});

sock.on("close", () => {
  clearTimeout(timer);
  if (!replied) die("Socket closed before response", 1);
});
