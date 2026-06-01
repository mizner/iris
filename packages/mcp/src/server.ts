#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import irisOpencode from "@mizner/iris-opencode";

type IrisTool = {
  description?: string;
  args?: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown>;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_JSON_PATH = join(__dirname, "..", "package.json");

function getPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
    return typeof pkg?.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

function toStructuredContent(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (Array.isArray(value)) {
    return { items: value };
  }
  if (value == null) {
    return undefined;
  }
  return { value };
}

function normalizeResult(result: unknown) {
  if (typeof result === "string") {
    try {
      const parsed = JSON.parse(result);
      return {
        content: [{ type: "text" as const, text: result }],
        structuredContent: toStructuredContent(parsed),
      };
    } catch {
      return {
        content: [{ type: "text" as const, text: result }],
      };
    }
  }

  if (result == null) {
    return {
      content: [{ type: "text" as const, text: "" }],
    };
  }

  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    structuredContent: toStructuredContent(result),
  };
}

function installProcessGuards(): void {
  const originalParentPid = process.ppid;
  const exitCleanly = () => process.exit(0);

  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.once(signal, exitCleanly);
  }

  process.stdin.once("end", exitCleanly);
  process.stdin.once("close", exitCleanly);
  process.stdin.once("error", exitCleanly);

  const timer = setInterval(() => {
    if (originalParentPid !== 1 && process.ppid === 1) {
      process.exit(0);
    }
  }, 30000);
  timer.unref?.();
}

async function main() {
  installProcessGuards();

  const plugin = await irisOpencode({});
  const browserTools = Object.entries((plugin as { tool: Record<string, IrisTool> }).tool).filter(([name]) =>
    name.startsWith("browser_")
  );

  const server = new McpServer({
    name: "@mizner/iris-mcp",
    version: getPackageVersion(),
  });

  for (const [name, tool] of browserTools) {
    server.registerTool(
      name,
      {
        description: tool.description || name,
        inputSchema: tool.args || {},
      },
      async (args) => normalizeResult(await tool.execute((args as Record<string, unknown>) || {}, {}))
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
