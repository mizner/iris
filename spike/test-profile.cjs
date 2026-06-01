#!/usr/bin/env node
"use strict";

/**
 * Test Iris profile gate functionality
 */

const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BASE_DIR = path.join(os.homedir(), ".iris");
const SOCKET_PATH = path.join(BASE_DIR, "broker.sock");

let nextId = 1;
const pending = new Map();

function send(socket, msg, timeoutMs = 5000) {
  const id = nextId++;
  const req = { ...msg, id };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.write(JSON.stringify(req) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(msg.id);
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

async function runTest() {
  console.log("=== Profile Gate Test ===\n");
  
  if (!fs.existsSync(SOCKET_PATH)) {
    console.error("❌ Broker not running");
    process.exit(1);
  }
  
  const socket = net.createConnection(SOCKET_PATH);
  socket.on("error", (err) => {
    console.error("❌ Connection failed:", err.message);
    process.exit(1);
  });
  
  const parser = createJsonLineParser((msg) => {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg);
    }
  });
  socket.on("data", parser);
  await new Promise((resolve) => socket.on("connect", resolve));
  console.log("✓ Connected to broker\n");
  
  // Test 1: Get profile status
  console.log("Test 1: Get profile status");
  try {
    const result = await send(socket, { tool: "get_profile_status" }, 5000);
    console.log("  Result:", JSON.stringify(result.result, null, 2));
    if (result.result?.allowed) {
      console.log("  ✓ Profile authorized\n");
    } else {
      console.log("  ✗ Profile NOT authorized");
      console.log(`  Expected: ${result.result?.expected}`);
      console.log(`  Actual: ${result.result?.profileId}\n`);
    }
  } catch (err) {
    console.log("  ✗ Failed:", err.message);
    console.log("  (Extension may not be connected)\n");
  }
  
  // Test 2: Try to execute a tool (should check profile)
  console.log("Test 2: Execute tool with profile check");
  try {
    const result = await send(socket, { tool: "get_active_tab" }, 5000);
    console.log("  ✓ Tool executed successfully");
    console.log("  Tab:", result.result?.title || "N/A");
  } catch (err) {
    if (err.message.includes("Profile not authorized")) {
      console.log("  ✓ Profile gate working - blocked unauthorized profile");
      console.log("  Error:", err.message);
    } else {
      console.log("  ✗ Failed:", err.message);
    }
  }
  
  socket.end();
  console.log("\n=== Test Complete ===");
}

runTest().catch(console.error);
