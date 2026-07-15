#!/usr/bin/env node
/**
 * Live smoke: load the bundled OMP extension, call browser_status + browser_version.
 * Always process.exit — iris-opencode keeps the broker socket open and would hang otherwise.
 */
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extensionPath = join(__dirname, "..", "dist", "extension.js");

function chainable(base) {
  const s = {
    ...base,
    optional() {
      return chainable({ type: "optional", inner: this });
    },
  };
  return s;
}

const z = {
  object: (shape) => ({ type: "object", shape }),
  string: () => chainable({ type: "string" }),
  number: () => chainable({ type: "number" }),
  boolean: () => chainable({ type: "boolean" }),
  array: (inner) => chainable({ type: "array", inner }),
  unknown: () => chainable({ type: "unknown" }),
};

const tools = new Map();

try {
  const mod = await import(pathToFileURL(extensionPath).href);
  await mod.default({
    setLabel() {},
    zod: { z },
    registerTool(def) {
      tools.set(def.name, def);
    },
    registerCommand() {},
    on() {},
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  });

  const click = tools.get("browser_click");
  if (!click?.parameters?.shape?.selector) {
    console.error("FAIL: browser_click parameters missing selector after conversion");
    process.exit(1);
  }

  const version = await tools.get("browser_version").execute("v", {}, undefined, null, {});
  const status = await tools.get("browser_status").execute("s", {}, undefined, null, {});

  console.log("tools", tools.size);
  console.log("browser_click.params", Object.keys(click.parameters.shape).sort().join(","));
  console.log("version", version.content?.[0]?.text ?? version);
  console.log("status", (status.content?.[0]?.text ?? String(status)).slice(0, 300));
  process.exit(0);
} catch (err) {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
}
