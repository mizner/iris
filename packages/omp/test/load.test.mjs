import assert from "node:assert/strict";
import { test } from "node:test";
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

function paramType(node) {
  if (!node || typeof node !== "object") return null;
  if (node.type === "optional") {
    return { optional: true, type: paramType(node.inner)?.type ?? null };
  }
  return { optional: false, type: node.type ?? null };
}

test("OMP extension registers 34 browser_* tools with rebuilt schemas", async () => {
  const mod = await import(pathToFileURL(extensionPath).href);
  const factory = mod.default;
  assert.equal(typeof factory, "function");

  const z = {
    object: (shape) => ({ type: "object", shape }),
    string: () => chainable({ type: "string" }),
    number: () => chainable({ type: "number" }),
    boolean: () => chainable({ type: "boolean" }),
    array: (inner) => chainable({ type: "array", inner }),
    unknown: () => chainable({ type: "unknown" }),
  };

  /** @type {string[]} */
  const registered = [];
  /** @type {Map<string, { name: string, parameters: { type?: string, shape?: Record<string, unknown> } }>} */
  const toolDefs = new Map();

  const pi = {
    setLabel() {},
    zod: { z },
    registerTool(def) {
      registered.push(def.name);
      toolDefs.set(def.name, def);
    },
    registerCommand() {},
    on() {},
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  };

  await factory(pi);

  const browserTools = registered.filter((n) => n.startsWith("browser_"));
  assert.equal(browserTools.length, 34);
  assert.ok(registered.includes("browser_status"));
  assert.ok(registered.includes("browser_version"));
  assert.ok(registered.includes("browser_click"));

  // Empty-arg tools must still be z.object({})
  const status = toolDefs.get("browser_status");
  assert.ok(status);
  assert.equal(status.parameters?.type, "object");
  assert.deepEqual(status.parameters?.shape ?? {}, {});

  // Complex tool: browser_click must expose selector (required string) + optional tabId/index/…
  // Proves schema conversion did not collapse to empty object.
  const click = toolDefs.get("browser_click");
  assert.ok(click);
  assert.equal(click.parameters?.type, "object");
  const clickShape = click.parameters?.shape ?? {};
  assert.deepEqual(Object.keys(clickShape).sort(), ["index", "pollMs", "selector", "tabId", "timeoutMs"]);
  assert.deepEqual(paramType(clickShape.selector), { optional: false, type: "string" });
  assert.deepEqual(paramType(clickShape.tabId), { optional: true, type: "number" });
  assert.deepEqual(paramType(clickShape.index), { optional: true, type: "number" });

  // Array arg survives rebuild (browser_press.modifiers)
  const press = toolDefs.get("browser_press");
  assert.ok(press);
  const pressShape = press.parameters?.shape ?? {};
  assert.deepEqual(paramType(pressShape.key), { optional: false, type: "string" });
  const modifiers = paramType(pressShape.modifiers);
  assert.equal(modifiers?.optional, true);
  assert.equal(modifiers?.type, "array");
});
