import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const decision = require("../bin/decision.cjs");

function snapshot(nodes, extra = {}) {
  return { content: JSON.stringify({ mode: "full", url: "https://shop.example/", title: "Shop", text: "Welcome", nodes, ...extra }) };
}

const SEARCH_PAGE = [
  { uid: "e1", role: "input", tag: "input", type: "search", name: "Search products", value: "" },
  { uid: "e2", role: "button", tag: "button", name: "Search" },
  { uid: "e3", role: "input", tag: "input", type: "password", name: "Password", value: "[redacted]" },
];

function fakeBrowser(pages) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async callTool(tool, args) {
      calls.push({ tool, args });
      if (tool === "snapshot") return snapshot(pages[Math.min(index, pages.length - 1)]);
      if (tool === "press" || tool === "click" || tool === "type") index += 1;
      return { content: "ok" };
    },
  };
}

function choice(option, p = 0.9, runnerUp = "UNSURE") {
  return { choice: option, confidence: p, probabilities: { [option]: p, [runnerUp]: 1 - p } };
}

test("gateChoice turns model UNSURE, low confidence, and thin margins into UNSURE", () => {
  assert.equal(decision.gateChoice(choice("CLICK", 0.9)).decision, "CLICK");
  assert.deepEqual(decision.gateChoice(choice("UNSURE", 0.9, "CLICK")).tripped, ["model_unsure"]);
  assert.equal(decision.gateChoice(choice("CLICK", 0.45)).decision, "UNSURE");
  const thin = decision.gateChoice({ choice: "CLICK", confidence: 0.55, probabilities: { CLICK: 0.55, TYPE: 0.45 } });
  assert.equal(thin.decision, "UNSURE");
  assert.ok(thin.tripped.includes("low_margin"));
});

test("resolveSettings needs a key and honors the off switch", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "iris-decision-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const saved = { key: process.env.TYPESAFE_API_KEY, secrets: process.env.IRIS_SECRETS_PATH, sw: process.env.IRIS_DECISION };
  t.after(() => {
    for (const [name, value] of [["TYPESAFE_API_KEY", saved.key], ["IRIS_SECRETS_PATH", saved.secrets], ["IRIS_DECISION", saved.sw]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.IRIS_DECISION;

  process.env.IRIS_SECRETS_PATH = path.join(dir, "missing");
  assert.equal(decision.resolveSettings({}).available, false);

  const secrets = path.join(dir, "secrets");
  writeFileSync(secrets, "OTHER=1\nexport TYPESAFE_API_KEY=\"tk_test\"\n");
  process.env.IRIS_SECRETS_PATH = secrets;
  const settings = decision.resolveSettings({});
  assert.equal(settings.available, true);
  assert.equal(settings.apiKey, "tk_test");
  assert.equal(settings.model, "jev-1.13.0");
  assert.deepEqual(decision.publicStatus(settings), { available: true, model: "jev-1.13.0" });

  assert.equal(decision.resolveSettings({ decisionModel: { enabled: false } }).available, false);
  process.env.IRIS_DECISION = "off";
  assert.equal(decision.resolveSettings({}).available, false);
});

test("every decision question offers UNSURE, and typed values never reach the model", async () => {
  const browser = fakeBrowser([SEARCH_PAGE, SEARCH_PAGE]);
  const seen = [];
  const decide = async (state, questions) => {
    seen.push({ state, questions });
    if (seen.length === 1) {
      return {
        model: "jev-test",
        usage: { input_tokens: 100 },
        answers: {
          operation: choice("TYPE"),
          type_target: choice("e1"),
          type_fact: choice("query"),
          submit_after_type: { noul: 0.9 },
          irreversible: { noul: 0.05 },
          injection: { noul: 0.02 },
        },
      };
    }
    return { model: "jev-test", usage: { input_tokens: 90 }, answers: { operation: choice("DONE"), irreversible: { noul: 0 }, injection: { noul: 0 } } };
  };

  const result = await decision.runGoal({
    decide,
    callTool: browser.callTool,
    goal: "Search for blue kettle",
    facts: { query: "secret-ish blue kettle" },
  });

  assert.equal(result.status, "done");
  assert.equal(result.inputTokens, 190);
  assert.deepEqual(
    browser.calls.filter((c) => c.tool === "type" || c.tool === "press").map((c) => [c.tool, c.args.selector, c.args.text ?? c.args.key]),
    [
      ["type", "uid:e1", "secret-ish blue kettle"],
      ["press", "uid:e1", "Enter"],
    ]
  );
  for (const { state, questions } of seen) {
    assert.ok(!JSON.stringify(state).includes("secret-ish"), "fact values must not be sent to the decision model");
    for (const q of Object.values(questions)) {
      if (q.type === "choice") assert.ok("UNSURE" in q.criteria, "choice questions must include UNSURE");
    }
  }
  assert.ok(!JSON.stringify(seen[0].questions.type_target.criteria).includes("Password"), "password fields are not typing targets");
});

test("an UNSURE answer hands the decision back to the agent with the top options", async () => {
  const browser = fakeBrowser([SEARCH_PAGE]);
  const decide = async () => ({
    answers: {
      operation: { choice: "CLICK", confidence: 0.52, probabilities: { CLICK: 0.52, TYPE: 0.48 } },
      irreversible: { noul: 0 },
      injection: { noul: 0 },
    },
  });
  const result = await decision.runGoal({ decide, callTool: browser.callTool, goal: "Find the cart" });
  assert.equal(result.status, "unsure");
  assert.deepEqual(result.proposal.top.map((t) => t.option), ["CLICK", "TYPE"]);
  assert.equal(browser.calls.filter((c) => c.tool === "click").length, 0);
});

test("a click that looks irreversible is proposed, not executed", async () => {
  const browser = fakeBrowser([SEARCH_PAGE]);
  const decide = async () => ({
    answers: { operation: choice("CLICK"), click_target: choice("e2"), irreversible: { noul: 0.8 }, injection: { noul: 0 } },
  });
  const result = await decision.runGoal({ decide, callTool: browser.callTool, goal: "Place the order" });
  assert.equal(result.status, "needs_agent");
  assert.deepEqual(result.proposed, { op: "CLICK", selector: "uid:e2", label: 'button "Search"' });
  assert.equal(browser.calls.filter((c) => c.tool === "click").length, 0);
});

test("page text that addresses the agent stops the loop", async () => {
  const browser = fakeBrowser([SEARCH_PAGE]);
  const decide = async () => ({ answers: { operation: choice("CLICK"), click_target: choice("e2"), irreversible: { noul: 0 }, injection: { noul: 0.92 } } });
  const result = await decision.runGoal({ decide, callTool: browser.callTool, goal: "Search" });
  assert.equal(result.status, "unsure");
  assert.match(result.reason, /instructions aimed at an agent/);
  assert.equal(browser.calls.filter((c) => c.tool === "click").length, 0);
});

test("chooseProfile offers UNSURE and gates the answer", async () => {
  let asked = null;
  const decide = async (state, questions) => {
    asked = questions;
    return { model: "jev-test", answers: { profile: { choice: "work", confidence: 0.6, probabilities: { work: 0.6, home: 0.5 } } } };
  };
  const result = await decision.chooseProfile(decide, {
    task: "check invoices",
    targetHost: "billing.example",
    profiles: [
      { name: "home", purpose: "Personal", knownSites: [], targetOpen: false },
      { name: "work", purpose: "Company admin", knownSites: ["billing.example"], targetOpen: false },
    ],
  });
  assert.ok("UNSURE" in asked.profile.criteria);
  assert.equal(result.decision, "UNSURE", "a 0.1 margin is too thin to act on");
  assert.equal(result.choice, "work");
});
