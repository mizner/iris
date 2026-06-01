#!/usr/bin/env node
"use strict";

/**
 * Latency benchmark suite for browser control router
 * Measures p50/p95/p99 for key operations
 */

const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BASE_DIR = path.join(os.homedir(), ".iris");
const SOCKET_PATH = path.join(BASE_DIR, "broker.sock");
const EVIDENCE_DIR = path.join(BASE_DIR, "benchmarks");

// Ensure evidence directory exists
if (!fs.existsSync(EVIDENCE_DIR)) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
}

let nextId = 1;
const pending = new Map();

function send(socket, toolName, args = {}, timeoutMs = 10000) {
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

function calculatePercentile(sorted, p) {
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

async function runBenchmark(name, iterations, fn) {
  const times = [];
  const errors = [];
  
  for (let i = 0; i < iterations; i++) {
    const start = Date.now();
    try {
      await fn();
      times.push(Date.now() - start);
    } catch (err) {
      errors.push(err?.message || String(err));
    }
  }
  
  if (times.length === 0) {
    return { name, error: "All iterations failed", errors };
  }
  
  const sorted = times.sort((a, b) => a - b);
  return {
    name,
    iterations,
    success: times.length,
    failed: errors.length,
    p50: calculatePercentile(sorted, 50),
    p95: calculatePercentile(sorted, 95),
    p99: calculatePercentile(sorted, 99),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: Math.round(times.reduce((a, b) => a + b, 0) / times.length),
    samples: times,
  };
}

async function runAllBenchmarks() {
  console.log("=== Browser Control Latency Benchmarks ===\n");
  
  if (!fs.existsSync(SOCKET_PATH)) {
    console.error("❌ Broker not running at:", SOCKET_PATH);
    console.log("Start with: node bin/broker.cjs");
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

  socket.write(
    JSON.stringify({
      type: "hello",
      role: "plugin",
      sessionId: `bench-${Date.now()}`,
      pid: process.pid,
    }) + "\n"
  );

  const tabsRaw = await send(socket, "get_tabs", {}, 5000);
  let tabs = [];
  if (Array.isArray(tabsRaw)) {
    tabs = tabsRaw;
  } else if (tabsRaw && typeof tabsRaw.content === "string") {
    try {
      const parsed = JSON.parse(tabsRaw.content);
      if (Array.isArray(parsed)) tabs = parsed;
    } catch {}
  }
  const firstHttpTab = tabs.find((t) => typeof t?.url === "string" && t.url.startsWith("http"));
  const targetTabId = firstHttpTab?.id;
  
  const results = [];
  
  // Benchmark 1: get_active_tab
  console.log("Benchmark 1: get_active_tab (100 iterations)");
  results.push(await runBenchmark("get_active_tab", 100, async () => {
    await send(socket, "get_active_tab", {}, 5000);
  }));
  
  // Benchmark 2: get_tabs
  console.log("Benchmark 2: get_tabs (50 iterations)");
  results.push(await runBenchmark("get_tabs", 50, async () => {
    await send(socket, "get_tabs", {}, 5000);
  }));
  
  // Benchmark 3: snapshot
  console.log("Benchmark 3: snapshot (20 iterations)");
  results.push(await runBenchmark("snapshot", 20, async () => {
    await send(socket, "snapshot", { tabId: targetTabId }, 10000);
  }));
  
  // Benchmark 4: execute_script (simple)
  console.log("Benchmark 4: query exists (body, 50 iterations)");
  results.push(await runBenchmark("query_exists_body", 50, async () => {
    await send(
      socket,
      "query",
      { selector: "css:body", mode: "exists", tabId: targetTabId },
      5000
    );
  }));
  
  socket.end();
  
  // Save results
  const output = {
    timestamp: new Date().toISOString(),
    results,
  };
  
  const outputPath = path.join(EVIDENCE_DIR, "browser-latency.json");
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n✓ Results saved to: ${outputPath}`);
  
  // Print summary
  console.log("\n=== Summary ===");
  for (const r of results) {
    if (r.error) {
      console.log(`\n${r.name}: ${r.error}`);
    } else {
      console.log(`\n${r.name}:`);
      console.log(`  Success: ${r.success}/${r.iterations}`);
      console.log(`  p50: ${r.p50}ms, p95: ${r.p95}ms, p99: ${r.p99}ms`);
      console.log(`  Range: ${r.min}-${r.max}ms, Avg: ${r.avg}ms`);
    }
  }
  
  // Check targets
  console.log("\n=== Target Check ===");
  const getActiveTab = results.find(r => r.name === "get_active_tab");
  if (getActiveTab && getActiveTab.p50 < 25) {
    console.log("✓ get_active_tab p50 < 25ms (target met)");
  } else {
    console.log("✗ get_active_tab p50 >= 25ms (target not met)");
  }
  
  console.log("\n=== Benchmark Complete ===");
}

runAllBenchmarks().catch(console.error);
