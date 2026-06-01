#!/usr/bin/env node
"use strict";

const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BASE_DIR = path.join(os.homedir(), ".iris");
const SOCKET_PATH = path.join(BASE_DIR, "broker.sock");

let nextId = 1;
const pending = new Map();

function send(socket, toolName, args = {}, timeoutMs = 3000) {
  const id = nextId++;
  const req = { type: "request", id, op: "tool", tool: toolName, args };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.write(JSON.stringify(req) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timeout after ${timeoutMs}ms`));
      }
    }, timeoutMs);
  });
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
      } catch {}
    }
  };
}

async function runSpike() {
  console.log("=== Transport Spike ===\n");
  
  if (!fs.existsSync(SOCKET_PATH)) {
    console.error("❌ Broker not running");
    console.log("Start with: node bin/broker.cjs");
    process.exit(1);
  }
  console.log("✓ Broker socket exists\n");
  
  const socket = net.createConnection(SOCKET_PATH);
  socket.on("error", (err) => {
    console.error("❌ Connection failed:", err.message);
    process.exit(1);
  });
  
  const parser = createJsonLineParser((msg) => {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (!msg.ok) {
        p.reject(new Error(msg.error || "Broker error"));
      } else {
        p.resolve(msg.data);
      }
    }
  });
  socket.on("data", parser);
  await new Promise((resolve) => socket.on("connect", resolve));
  console.log("✓ Connected to broker\n");
  
  console.log("Checking extension connectivity...");
  try {
    const tabs = await send(socket, "get_tabs", {}, 3000);
    console.log("✓ Extension connected");
    let tabCount = 0;
    if (Array.isArray(tabs)) {
      tabCount = tabs.length;
    } else if (tabs && typeof tabs.content === "string") {
      try {
        const parsed = JSON.parse(tabs.content);
        tabCount = Array.isArray(parsed) ? parsed.length : 0;
      } catch {}
    }
    console.log("  Tabs:", tabCount);
    
    console.log("\nLatency test (5 iterations):");
    const times = [];
    for (let i = 0; i < 5; i++) {
      const start = Date.now();
      await send(socket, "get_active_tab", {}, 3000);
      times.push(Date.now() - start);
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    console.log(`  Average: ${avg.toFixed(1)}ms`);
    console.log(`  Range: ${Math.min(...times)}-${Math.max(...times)}ms`);
    
  } catch (err) {
    console.log("✗ Extension not connected");
    console.log("  Error:", err.message);
    console.log("\nTo connect extension:");
    console.log("  1. Open Chrome → chrome://extensions");
    console.log("  2. Enable Developer mode");
    console.log("  3. Click 'Load unpacked'");
    console.log("  4. Select: ~/.iris/extension");
    console.log("  5. Install native host: node packages/core/bin/cli.js install");
  }
  
  socket.end();
  console.log("\n=== Spike Complete ===");
}

runSpike().catch(console.error);
