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


// Screenshots arrive as a data URL, or as JSON with an `image` data URL plus metadata. Return them as image
// content so the model sees a picture instead of a base64 string.
function splitImage(text: string): { image?: { data: string; mimeType: string }; rest?: string } {
  const asImage = (url: unknown) => {
    const match = typeof url === "string" ? url.match(/^data:(image\/[a-z+]+);base64,([\s\S]+)$/) : null;
    return match ? { mimeType: match[1], data: match[2] } : undefined;
  };
  if (text.startsWith("data:image/")) return { image: asImage(text) };
  if (text.startsWith('{"image"')) {
    try {
      const { image, ...rest } = JSON.parse(text);
      const parsed = asImage(image);
      if (parsed) return { image: parsed, rest: JSON.stringify(rest, null, 2) };
    } catch {}
  }
  return {};
}

function normalizeResult(result: unknown) {
  if (typeof result === "string") {
    const { image, rest } = splitImage(result);
    if (image) {
      return {
        content: [
          { type: "image" as const, data: image.data, mimeType: image.mimeType },
          ...(rest ? [{ type: "text" as const, text: rest }] : []),
        ],
      };
    }
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
