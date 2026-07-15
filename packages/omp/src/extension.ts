import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import irisOpencode from "@mizner/iris-opencode";

type IrisTool = {
  description?: string;
  args?: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown>;
};

type IrisPlugin = {
  tool: Record<string, IrisTool>;
};

type TextContent = { type: "text"; text: string };

type OmpToolResult = {
  content: TextContent[];
  details?: Record<string, unknown>;
};

/** Minimal ExtensionAPI surface used by this adapter (host injects the real object). */
type ExtensionAPI = {
  setLabel: (label: string) => void;
  zod: { z: ZodLike };
  registerTool: (def: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: unknown,
    ) => Promise<OmpToolResult>;
  }) => void;
  registerCommand: (name: string, def: {
    description: string;
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  }) => void;
  on: (event: string, handler: (event: unknown, ctx: ExtensionHandlerContext) => Promise<void>) => void;
  exec: (
    command: string,
    args: string[],
    options?: Record<string, unknown>,
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
};

type ExtensionHandlerContext = {
  hasUI?: boolean;
  ui?: {
    notify?: (message: string, level?: string) => void;
  };
};

type ExtensionCommandContext = ExtensionHandlerContext;

/** Structural subset of zod/v4 needed for parameter rebuild. */
type ZodLike = {
  object: (shape: Record<string, unknown>) => unknown;
  string: () => ZodBuilder;
  number: () => ZodBuilder;
  boolean: () => ZodBuilder;
  array: (inner: unknown) => ZodBuilder;
  unknown: () => ZodBuilder;
};

type ZodBuilder = {
  optional: () => unknown;
};

type ZodTypeNode = {
  type?: string;
  def?: {
    innerType?: unknown;
    element?: unknown;
    type?: unknown;
  };
  _def?: {
    innerType?: unknown;
    type?: unknown;
  };
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_JSON_PATH = join(__dirname, "..", "package.json");

let cachedVersion: string | null = null;

function getPackageVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as { version?: unknown };
    if (typeof pkg.version === "string") {
      cachedVersion = pkg.version;
      return cachedVersion;
    }
  } catch {
    // ignore
  }
  cachedVersion = "unknown";
  return cachedVersion;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asZodNode(value: unknown): ZodTypeNode | null {
  if (!isRecord(value)) return null;
  return value as ZodTypeNode;
}

function convertSchema(z: ZodLike, schema: unknown, path: string): unknown {
  const root = asZodNode(schema);
  if (!root) {
    throw new Error(`Unsupported Zod schema at ${path}: not an object`);
  }

  let cur: ZodTypeNode | null = root;
  let optional = false;

  while (cur?.type === "optional") {
    optional = true;
    const next = cur.def?.innerType ?? cur._def?.innerType ?? cur.def?.type;
    cur = asZodNode(next);
    if (!cur) {
      throw new Error(`Unsupported optional inner type at ${path}`);
    }
  }

  let out: ZodBuilder;
  switch (cur?.type) {
    case "string":
      out = z.string();
      break;
    case "number":
      out = z.number();
      break;
    case "boolean":
      out = z.boolean();
      break;
    case "array": {
      const elRaw = cur.def?.element ?? cur._def?.type ?? cur.def?.type;
      let el = asZodNode(elRaw);
      if (el?.type === "optional") {
        el = asZodNode(el.def?.innerType ?? el._def?.innerType ?? el.def?.type);
      }
      if (el?.type === "string") out = z.array(z.string());
      else if (el?.type === "number") out = z.array(z.number());
      else if (el?.type === "boolean") out = z.array(z.boolean());
      else {
        throw new Error(`Unsupported array element type at ${path}: ${el?.type ?? "unknown"}`);
      }
      break;
    }
    default:
      throw new Error(`Unsupported Zod type for OMP bridge at ${path}: ${cur?.type ?? "unknown"}`);
  }

  return optional ? out.optional() : out;
}

function toOmpZodObject(z: ZodLike, args: Record<string, unknown> | undefined, toolName: string): unknown {
  const shape: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(args || {})) {
    try {
      shape[key] = convertSchema(z, schema, `${toolName}.${key}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed converting schema for ${toolName}.${key}: ${message}`);
    }
  }
  return z.object(shape);
}

function normalizeOmpResult(result: unknown): OmpToolResult {
  if (typeof result === "string") {
    return { content: [{ type: "text", text: result }] };
  }
  if (result == null) {
    return { content: [{ type: "text", text: "" }] };
  }
  const text = JSON.stringify(result, null, 2);
  if (isRecord(result)) {
    return { content: [{ type: "text", text }], details: result };
  }
  return { content: [{ type: "text", text }], details: { value: result } };
}

function humanizeToolName(name: string): string {
  return name
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function notify(ctx: ExtensionHandlerContext, message: string, level: string): void {
  if (ctx.hasUI && ctx.ui?.notify) {
    ctx.ui.notify(message, level);
  }
}

function resultToNotifyText(result: unknown): string {
  if (typeof result === "string") return result.slice(0, 500);
  try {
    return JSON.stringify(result).slice(0, 500);
  } catch {
    return String(result).slice(0, 500);
  }
}

const irisPluginPromise: Promise<IrisPlugin> = Promise.resolve(irisOpencode({})).then((plugin) => {
  if (!isRecord(plugin) || !isRecord(plugin.tool)) {
    throw new Error("iris-opencode plugin did not return a tool map");
  }
  return { tool: plugin.tool as Record<string, IrisTool> };
});

export default async function irisOmpExtension(pi: ExtensionAPI): Promise<void> {
  pi.setLabel("Iris (real Chrome)");
  const { z } = pi.zod;

  const plugin = await irisPluginPromise;
  const browserTools = Object.entries(plugin.tool).filter(([name]) => name.startsWith("browser_"));

  let statusTool: IrisTool | null = null;
  let healthTool: IrisTool | null = null;

  for (const [name, tool] of browserTools) {
    if (name === "browser_status") statusTool = tool;
    if (name === "browser_health") healthTool = tool;
    if (name === "browser_version") continue;

    const parameters = toOmpZodObject(z, tool.args, name);
    pi.registerTool({
      name,
      label: humanizeToolName(name),
      description: tool.description || name,
      parameters,
      async execute(_toolCallId, params, signal) {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "Cancelled" }], details: { cancelled: true } };
        }
        const run = tool.execute(params ?? {}, {});
        if (!signal) {
          return normalizeOmpResult(await run);
        }
        const { promise: abortPromise, reject: rejectAbort } = Promise.withResolvers<never>();
        const onAbort = () => rejectAbort(new Error("Aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          const result = await Promise.race([run, abortPromise]);
          return normalizeOmpResult(result);
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      },

    });
  }

  pi.registerTool({
    name: "browser_version",
    label: "Browser Version",
    description: "Return the installed @mizner/iris-omp extension version.",
    parameters: z.object({}),
    async execute() {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              name: "@mizner/iris-omp",
              version: getPackageVersion(),
              via: "@mizner/iris-opencode",
            }),
          },
        ],
      };
    },
  });

  pi.registerCommand("iris", {
    description: "Iris runtime helpers: /iris status | health | reconnect",
    handler: async (args, ctx) => {
      const sub = (args || "").trim().split(/\s+/)[0]?.toLowerCase() || "status";

      const runTool = async (tool: IrisTool | null, label: string) => {
        if (!tool) {
          notify(ctx, `Iris ${label} tool unavailable`, "warning");
          return;
        }
        try {
          const raw = await tool.execute({}, {});
          notify(ctx, resultToNotifyText(raw), "info");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          notify(ctx, message, "warning");
        }
      };

      if (sub === "status") {
        await runTool(statusTool, "status");
        return;
      }
      if (sub === "health" || sub === "doctor") {
        await runTool(healthTool, "health");
        return;
      }
      if (sub === "reconnect") {
        try {
          const r = await pi.exec("iris", ["reconnect"]);
          if (r.code !== 0) {
            notify(
              ctx,
              `iris reconnect failed. Run: iris reconnect  (or: node packages/core/bin/cli.js reconnect)`,
              "warning",
            );
          } else {
            notify(ctx, (r.stdout || "iris reconnect ok").slice(0, 500), "info");
          }
        } catch {
          notify(
            ctx,
            "iris reconnect failed. Run: iris reconnect  (or: node packages/core/bin/cli.js reconnect)",
            "warning",
          );
        }
        return;
      }

      notify(ctx, "Usage: /iris status | health | reconnect", "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!statusTool) return;
    try {
      await statusTool.execute({}, {});
    } catch (err) {
      notify(
        ctx,
        `Iris broker unavailable: ${err instanceof Error ? err.message : String(err)}. Real-Chrome browser_* tools will fail until iris doctor/reconnect.`,
        "warning",
      );
    }
  });
}
