#!/usr/bin/env node
/**
 * Iris - CLI
 *
 * Architecture (v4):
 *   Harness Adapter <-> Local Broker (unix socket) <-> Native Messaging Host <-> Chrome Extension
 *
 * Commands:
 *   install   - Install extension + native host
 *   migrate   - Copy legacy runtime state from ~/.opencode-browser to ~/.iris
 *   uninstall - Remove native host registration
 *   status    - Show installation and live status
 *   doctor    - Diagnose broker/extension connectivity
 *   reconnect - Restart the local broker/native-host pipeline
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  readdirSync,
  unlinkSync,
  chmodSync,
  openSync,
} from "fs";
import { homedir, platform } from "os";
import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { createInterface } from "readline";
import { createConnection } from "net";
import { execSync, spawn } from "child_process";
import { createHash } from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = join(__dirname, "..");

const BASE_DIR = join(homedir(), ".iris");
const LEGACY_BASE_DIR = join(homedir(), ".opencode-browser");
const EXTENSION_DIR = join(BASE_DIR, "extension");
const EXTENSION_MANIFEST_PATH = join(PACKAGE_ROOT, "extension", "manifest.json");
const BROKER_DST = join(BASE_DIR, "broker.cjs");
const BROWSER_CLI_DST = join(BASE_DIR, "browser-cli.cjs");
const NATIVE_HOST_DST = join(BASE_DIR, "native-host.cjs");
const NATIVE_HOST_WRAPPER = join(BASE_DIR, "host-wrapper.sh");
const CONFIG_DST = join(BASE_DIR, "config.json");
const BROKER_SOCKET = join(BASE_DIR, "broker.sock");
const LEGACY_CONFIG_DST = join(LEGACY_BASE_DIR, "config.json");

const NATIVE_HOST_NAME = "com.iris.host";
const LEGACY_NATIVE_HOST_NAME = "com.opencode.browser_automation";

const COLORS = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

function color(c, text) {
  return `${COLORS[c]}${text}${COLORS.reset}`;
}

function log(msg) {
  console.log(msg);
}

function success(msg) {
  console.log(color("green", "  " + msg));
}

function warn(msg) {
  console.log(color("yellow", "  " + msg));
}

function error(msg) {
  console.log(color("red", "  " + msg));
}

function header(msg) {
  console.log("\n" + color("cyan", color("bright", msg)));
  console.log(color("cyan", "-".repeat(msg.length)));
}

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function confirm(question) {
  const answer = await ask(`${question} (y/n): `);
  return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
}

function getFlagValue(flag) {
  const index = process.argv.findIndex((arg) => arg === flag || arg.startsWith(`${flag}=`));
  if (index === -1) return null;
  const arg = process.argv[index];
  if (arg.includes("=")) return arg.slice(arg.indexOf("=") + 1).trim() || null;
  const next = process.argv[index + 1];
  if (!next || next.startsWith("-")) return null;
  return next.trim();
}

function getExtensionIdOverride() {
  const cliValue = getFlagValue("--extension-id") || getFlagValue("-e");
  if (cliValue) return cliValue;
  const envValue = process.env.OPENCODE_BROWSER_EXTENSION_ID;
  return envValue ? envValue.trim() : null;
}

function readExtensionManifest() {
  try {
    if (!existsSync(EXTENSION_MANIFEST_PATH)) return null;
    return JSON.parse(readFileSync(EXTENSION_MANIFEST_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function computeExtensionIdFromKey(key) {
  try {
    const raw = String(key || "").trim();
    if (!raw) return null;
    const buffer = Buffer.from(raw, "base64");
    if (!buffer.length) return null;
    const hash = createHash("sha256").update(buffer).digest();
    const bytes = hash.subarray(0, 16);
    return Array.from(bytes)
      .map((b) => {
        const hi = b >> 4;
        const lo = b & 15;
        return String.fromCharCode(97 + hi) + String.fromCharCode(97 + lo);
      })
      .join("");
  } catch {
    return null;
  }
}

function getExtensionIdFromManifest() {
  const manifest = readExtensionManifest();
  if (!manifest?.key) return null;
  return computeExtensionIdFromKey(manifest.key);
}

async function resolveExtensionId({ allowPrompt = true, preferConfig = false } = {}) {
  const override = getExtensionIdOverride();
  if (override) return { id: override, source: "override" };

  const config = loadConfig();
  if (preferConfig && config?.extensionId) {
    return { id: config.extensionId, source: "config" };
  }

  const manifestId = getExtensionIdFromManifest();
  if (manifestId) {
    return { id: manifestId, source: "manifest" };
  }

  if (!preferConfig && config?.extensionId) {
    return { id: config.extensionId, source: "config" };
  }

  if (!allowPrompt) {
    return { id: null, source: "missing" };
  }

  const extensionId = await ask(color("bright", "Paste Extension ID: "));
  return { id: extensionId || null, source: extensionId ? "prompt" : "missing" };
}

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

function resolveNodePath() {
  if (process.env.OPENCODE_BROWSER_NODE) return process.env.OPENCODE_BROWSER_NODE;
  const stableCandidates = [];
  if (platform() === "darwin") {
    stableCandidates.push("/opt/homebrew/bin/node", "/usr/local/bin/node");
  }
  for (const candidate of stableCandidates) {
    if (existsSync(candidate)) return candidate;
  }
  try {
    const output = execSync("which node", { stdio: ["ignore", "pipe", "ignore"] })
      .toString("utf8")
      .trim();
    if (output) return output;
  } catch {}
  if (process.execPath && /node(\.exe)?$/.test(process.execPath)) return process.execPath;
  return process.execPath;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function writeHostWrapper(nodePath) {
  ensureDir(BASE_DIR);
  const script =
    `#!/bin/sh\n` +
    `# Prefer a stable Node symlink so runtime updates do not break Chrome native messaging.\n` +
    `NODE=${shellQuote(nodePath)}\n` +
    `[ -x "$NODE" ] || NODE="$(command -v node)"\n` +
    `exec "$NODE" ${shellQuote(NATIVE_HOST_DST)}\n`;
  writeFileSync(NATIVE_HOST_WRAPPER, script, { mode: 0o755 });
  chmodSync(NATIVE_HOST_WRAPPER, 0o755);
  return NATIVE_HOST_WRAPPER;
}

function normalizeProfileEmails(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => String(entry || "").trim().toLowerCase()).filter(Boolean))];
}

function parseProfileEmails(value) {
  if (!value) return [];
  return normalizeProfileEmails(String(value).split(","));
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
      } catch {
        // ignore
      }
    }
  };
}

async function getBrokerStatus(timeoutMs = 2000) {
  return await brokerRequestOnce("status", timeoutMs);
}

async function brokerRequestOnce(op, timeoutMs = 2000) {
  return await new Promise((resolve) => {
    let done = false;
    const socket = createConnection(BROKER_SOCKET);

    const finish = (result) => {
      if (done) return;
      done = true;
      try {
        socket.end();
      } catch {}
      resolve(result);
    };

    const timeout = setTimeout(() => {
      finish({ ok: false, error: "Timed out waiting for broker" });
    }, timeoutMs);

    socket.once("error", (err) => {
      clearTimeout(timeout);
      finish({ ok: false, error: err.message || "Broker connection failed" });
    });

    socket.once("connect", () => {
      socket.write(JSON.stringify({ type: "request", id: 1, op }) + "\n");
    });

    socket.on(
      "data",
      createJsonLineParser((msg) => {
        if (msg && msg.type === "response" && msg.id === 1) {
          clearTimeout(timeout);
          if (msg.ok) {
            finish({ ok: true, data: msg.data });
          } else {
            finish({ ok: false, error: msg.error || "Broker status error" });
          }
        }
      })
    );
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnBroker() {
  ensureDir(BASE_DIR);
  const out = openSync(join(BASE_DIR, "broker.log"), "a");
  const child = spawn(process.execPath, [BROKER_DST], { detached: true, stdio: ["ignore", "ignore", out] });
  child.unref();
}

function copyDirRecursive(srcDir, destDir) {
  ensureDir(destDir);
  const entries = readdirSync(srcDir, { recursive: true });
  for (const entry of entries) {
    const srcPath = join(srcDir, entry);
    const destPath = join(destDir, entry);

    try {
      readdirSync(srcPath);
      ensureDir(destPath);
    } catch {
      ensureDir(dirname(destPath));
      copyFileSync(srcPath, destPath);
    }
  }
}

function getNativeHostDirs(osName) {
  if (osName === "darwin") {
    const base = join(homedir(), "Library", "Application Support");
    return [
      join(base, "Google", "Chrome", "NativeMessagingHosts"),
      join(base, "Chromium", "NativeMessagingHosts"),
      join(base, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"),
    ];
  }

  // linux
  const base = join(homedir(), ".config");
  return [
    join(base, "google-chrome", "NativeMessagingHosts"),
    join(base, "chromium", "NativeMessagingHosts"),
    join(base, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"),
  ];
}

function nativeHostManifestPath(dir) {
  return join(dir, `${NATIVE_HOST_NAME}.json`);
}

function legacyNativeHostManifestPath(dir) {
  return join(dir, `${LEGACY_NATIVE_HOST_NAME}.json`);
}

function writeNativeHostManifest(dir, extensionId, hostPath) {
  ensureDir(dir);

  const manifest = {
    name: NATIVE_HOST_NAME,
    description: "Iris native messaging host",
    path: hostPath || NATIVE_HOST_DST,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };

  writeFileSync(nativeHostManifestPath(dir), JSON.stringify(manifest, null, 2) + "\n");
}

function loadConfig(configPath = CONFIG_DST) {
  try {
    if (!existsSync(configPath)) return null;
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return null;
  }
}

function saveConfig(config, configPath = CONFIG_DST) {
  ensureDir(dirname(configPath));
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        ...config,
        profileEmails: normalizeProfileEmails(config?.profileEmails),
      },
      null,
      2
    ) + "\n"
  );
}

function installRuntimeFiles() {
  const brokerSrc = join(PACKAGE_ROOT, "bin", "broker.cjs");
  const browserCliSrc = join(PACKAGE_ROOT, "bin", "browser-cli.cjs");
  const nativeHostSrc = join(PACKAGE_ROOT, "bin", "native-host.cjs");

  copyFileSync(brokerSrc, BROKER_DST);
  copyFileSync(browserCliSrc, BROWSER_CLI_DST);
  copyFileSync(nativeHostSrc, NATIVE_HOST_DST);

  try {
    chmodSync(BROKER_DST, 0o755);
  } catch {}
  try {
    chmodSync(BROWSER_CLI_DST, 0o755);
  } catch {}
  try {
    chmodSync(NATIVE_HOST_DST, 0o755);
  } catch {}
}

function removeNativeHostManifest(manifestPath) {
  if (!existsSync(manifestPath)) return false;
  try {
    unlinkSync(manifestPath);
    success(`Removed native host manifest: ${manifestPath}`);
    return true;
  } catch {
    warn(`Could not remove: ${manifestPath}`);
    return false;
  }
}

function removeLegacyNativeHostManifests(hostDirs) {
  for (const dir of hostDirs) {
    removeNativeHostManifest(legacyNativeHostManifestPath(dir));
  }
}

async function promptForProfileEmails(defaultProfileEmails = []) {
  const suffix = defaultProfileEmails.length
    ? ` [current: ${defaultProfileEmails.join(", ")}]`
    : "";
  const answer = await ask(
    `Restrict extension to specific Google account emails? (comma-separated, blank = no restriction)${suffix}: `
  );
  if (!answer) return [];
  return parseProfileEmails(answer);
}

async function main() {
  const command = process.argv[2];

  console.log(`
${color("cyan", color("bright", "Iris v4"))}
${color("cyan", "Browser automation runtime (native messaging + per-tab ownership)")}
`);

  if (command === "install") {
    await install();
  } else if (command === "update") {
    await update();
  } else if (command === "migrate") {
    await migrate();
  } else if (command === "uninstall") {
    await uninstall();
  } else if (command === "status") {
    await status();
  } else if (command === "doctor") {
    await doctor();
  } else if (command === "reconnect") {
    await reconnect();
  } else if (command === "agent-install") {
    await agentInstall();
  } else if (command === "agent-gateway") {
    await agentGateway();
  } else {
    log(`
${color("bright", "Usage:")}
  iris install
  iris update
  iris migrate
  iris status
  iris doctor
  iris reconnect
  iris uninstall
  iris agent-install
  iris agent-gateway

${color("bright", "Options:")}
  --extension-id <id> (or OPENCODE_BROWSER_EXTENSION_ID)

${color("bright", "Quick Start:")}
  1. Run: iris install
  2. Restart OpenCode
  3. Use: browser_navigate / browser_click / browser_snapshot

${color("bright", "Agent Mode:")}
  1. Run: iris agent-install
  2. Set OPENCODE_BROWSER_BACKEND=agent
  3. Optionally run: iris agent-gateway

${color("bright", "Connection Recovery:")}
  iris doctor
  iris reconnect
`);
  }

  rl.close();
}

async function install() {
  header("Step 1: Check Platform");

  const osName = platform();
  if (osName !== "darwin" && osName !== "linux") {
    error(`Unsupported platform: ${osName}`);
    error("Iris currently supports macOS and Linux only.");
    process.exit(1);
  }
  success(`Platform: ${osName === "darwin" ? "macOS" : "Linux"}`);

  header("Step 2: Copy Extension Files");

  ensureDir(BASE_DIR);
  const srcExtensionDir = join(PACKAGE_ROOT, "extension");
  copyDirRecursive(srcExtensionDir, EXTENSION_DIR);
  success(`Extension files copied to: ${EXTENSION_DIR}`);

  header("Step 3: Load & Pin Extension");

  log(`
To load the extension:

1. Open ${color("cyan", "chrome://extensions")}
2. Enable ${color("bright", "Developer mode")}
3. Click ${color("bright", "Load unpacked")}
4. Select:
   ${color("cyan", EXTENSION_DIR)}

After loading, ${color("bright", "pin the extension")}: open the Extensions menu (puzzle icon) and click the pin.
`);

  await ask(color("bright", "Press Enter when you've loaded and pinned the extension..."));

  header("Step 4: Extension ID");

  let resolved = await resolveExtensionId({ allowPrompt: false, preferConfig: true });
  let extensionId = resolved.id;

  if (!extensionId) {
    log(`
We need the extension ID to register the native messaging host.

Find it at ${color("cyan", "chrome://extensions")}:
- Locate ${color("bright", "Iris")}
- Click ${color("bright", "Details")}
- Copy the ${color("bright", "ID")}
`);

    resolved = await resolveExtensionId({ allowPrompt: true, preferConfig: false });
    extensionId = resolved.id;
  } else if (resolved.source === "manifest") {
    success(`Using fixed extension ID from manifest: ${extensionId}`);
    log(`If you already loaded a different ID, rerun with --extension-id to override.`);
  } else if (resolved.source === "config") {
    success(`Using extension ID from config.json: ${extensionId}`);
  } else if (resolved.source === "override") {
    success(`Using extension ID override: ${extensionId}`);
  }

  if (!extensionId) {
    error("Extension ID is required to continue.");
    process.exit(1);
  }

  if (!/^[a-p]{32}$/i.test(extensionId)) {
    warn("That doesn't look like a Chrome extension ID (expected 32 chars a-p). Continuing anyway.");
  }

  header("Step 5: Profile Gate");
  const existingConfig = loadConfig();
  const profileEmails = await promptForProfileEmails(existingConfig?.profileEmails || []);

  header("Step 6: Install Local Host + Broker");

  installRuntimeFiles();

  success(`Installed broker: ${BROKER_DST}`);
  success(`Installed browser CLI: ${BROWSER_CLI_DST}`);
  success(`Installed native host: ${NATIVE_HOST_DST}`);

  const nodePath = resolveNodePath();
  if (!/node(\.exe)?$/.test(nodePath)) {
    warn(`Node not detected; using ${nodePath}. Set OPENCODE_BROWSER_NODE if needed.`);
  }
  const hostPath = writeHostWrapper(nodePath);
  success(`Installed host wrapper: ${hostPath}`);

  saveConfig({ extensionId, installedAt: new Date().toISOString(), nodePath, profileEmails });

  header("Step 7: Register Native Messaging Host");

  const hostDirs = getNativeHostDirs(osName);
  removeLegacyNativeHostManifests(hostDirs);
  for (const dir of hostDirs) {
    try {
      writeNativeHostManifest(dir, extensionId, hostPath);
      success(`Wrote native host manifest: ${nativeHostManifestPath(dir)}`);
    } catch (e) {
      warn(`Could not write native host manifest to: ${dir}`);
    }
  }

  header("Step 8: Configure OpenCode");

  const localPluginPath = join(PACKAGE_ROOT, "..", "opencode", "dist", "plugin.js");
  const desiredPlugin = existsSync(localPluginPath)
    ? pathToFileURL(localPluginPath).href
    : "@mizner/iris-opencode";

  function normalizePlugins(val) {
    if (Array.isArray(val)) return val.filter((v) => typeof v === "string");
    if (typeof val === "string" && val.trim()) return [val.trim()];
    return [];
  }

  function stripJsoncComments(contents) {
    return contents
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  }

  function sanitizeJson(contents) {
    return stripJsoncComments(contents).replace(/,\s*(\]|\})/g, "$1");
  }

  function findOpenCodeConfigPath(configDir) {
    const jsoncPath = join(configDir, "opencode.jsonc");
    if (existsSync(jsoncPath)) return jsoncPath;
    const jsonPath = join(configDir, "opencode.json");
    return jsonPath;
  }

  const configOptions = [
    "1) Project (./opencode.json or opencode.jsonc)",
    "2) Global (~/.config/opencode/opencode.json)",
    "3) Custom path",
    "4) Skip (does nothing)",
  ];

  log(`\n${configOptions.join("\n")}`);
  const selection = await ask("Choose config location [1-4]: ");

  let configPath = null;
  let configDir = null;

  if (selection === "1") {
    configDir = process.cwd();
    configPath = findOpenCodeConfigPath(configDir);
  } else if (selection === "2") {
    const xdgConfig = process.env.XDG_CONFIG_HOME;
    configDir = xdgConfig ? join(xdgConfig, "opencode") : join(homedir(), ".config", "opencode");
    configPath = findOpenCodeConfigPath(configDir);
  } else if (selection === "3") {
    const customPath = await ask("Enter full path to opencode.json or opencode.jsonc: ");
    if (customPath) {
      configPath = customPath;
      configDir = dirname(customPath);
    } else {
      warn("No path provided. Skipping OpenCode config.");
    }
  } else if (selection === "4") {
    warn("Skipping OpenCode config (does nothing).");
  } else {
    warn("Invalid selection. Skipping OpenCode config.");
  }

  if (configPath && configDir) {
    const hasExistingConfig = existsSync(configPath);
    const shouldUpdate = hasExistingConfig
      ? await confirm(`Found ${configPath}. Add plugin automatically?`)
      : await confirm(`No config found at ${configPath}. Create one?`);

    if (shouldUpdate) {
      try {
        let config = { $schema: "https://opencode.ai/config.json", plugin: [] };
        let canWriteConfig = true;

        if (hasExistingConfig) {
          const rawConfig = readFileSync(configPath, "utf-8");
          try {
            config = JSON.parse(sanitizeJson(rawConfig));
          } catch (e) {
            error(`Failed to parse ${configPath}: ${e.message}`);
            const shouldOverwrite = await confirm("Config is invalid JSON. Back up and recreate it?");
            if (shouldOverwrite) {
              const backupPath = `${configPath}.bak-${Date.now()}`;
              writeFileSync(backupPath, rawConfig);
              warn(`Backed up invalid config to ${backupPath}`);
              config = { $schema: "https://opencode.ai/config.json", plugin: [] };
            } else {
              canWriteConfig = false;
            }
          }
        }

        if (canWriteConfig) {
          config.plugin = normalizePlugins(config.plugin);
          if (!config.plugin.includes(desiredPlugin)) config.plugin.push(desiredPlugin);
          if (typeof config.$schema !== "string") config.$schema = "https://opencode.ai/config.json";

          ensureDir(configDir);
          writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
          success(`Updated ${configPath} with plugin`);
        } else {
          warn(`Skipped updating ${configPath}. Fix JSON manually and rerun install.`);
        }
      } catch (e) {
        error(`Failed to update ${configPath}: ${e.message}`);
      }
    }
  }

  header("Step 9: Optional Agent Skill");

  log(`
Agent Skills are reusable instructions discovered by OpenCode.

Format rules (summary):
- Place a skill at .opencode/skills/<name>/SKILL.md
- SKILL.md must start with YAML frontmatter with name + description
- name must match the directory and use: ^[a-z0-9]+(-[a-z0-9]+)*$
`);

  const skillName = "browser-automation";
  const packagedSkillSrc = join(PACKAGE_ROOT, "templates", "skills", skillName, "SKILL.md");
  const repoSkillSrc = join(PACKAGE_ROOT, "..", "..", ".opencode", "skills", skillName, "SKILL.md");
  const skillSrc = existsSync(packagedSkillSrc) ? packagedSkillSrc : repoSkillSrc;
  const skillDstDir = join(process.cwd(), ".opencode", "skills", skillName);
  const skillDst = join(skillDstDir, "SKILL.md");

  if (existsSync(skillSrc)) {
    const shouldAddSkill = await confirm(`Add ${skillName} skill to this repo?`);
    if (shouldAddSkill) {
      ensureDir(skillDstDir);
      copyFileSync(skillSrc, skillDst);
      success(`Added skill: ${skillDst}`);
    }
  } else {
    warn("Skill template missing from package; skipping.");
  }

  header("Step 10: Verify Extension Connection (optional)");

  const shouldCheck = await confirm("Check broker + extension connection now?");
  if (shouldCheck) {
    while (true) {
      const status = await getBrokerStatus();
      if (status.ok && status.data?.hostConnected) {
        success("Broker is running and extension is connected.");
        break;
      }

      if (status.ok && !status.data?.hostConnected) {
        warn("Broker is running but extension is not connected.");
      } else {
        warn(`Could not connect to local broker (${status.error || "unknown error"}).`);
      }

      log(`
Open Chrome and:
- Verify the extension is loaded in chrome://extensions
- Click the Iris extension icon to connect
`);

      const retry = await confirm("Retry broker check?");
      if (!retry) break;
    }
  }

  header("Installation Complete!");

  log(`
 ${color("bright", "What happens now:")}
  - The extension connects to the native host automatically.
  - Your harness adapter talks to the broker through the native host.
  - The broker enforces ${color("bright", "per-tab ownership")}. First touch auto-claims.

 ${color("bright", "Try it:")}
  Restart OpenCode and run: ${color("cyan", "browser_get_tabs")}
 `);
 }

async function update() {
  header("Update: Check Platform");

  const osName = platform();
  if (osName !== "darwin" && osName !== "linux") {
    error(`Unsupported platform: ${osName}`);
    error("Iris currently supports macOS and Linux only.");
    process.exit(1);
  }
  success(`Platform: ${osName === "darwin" ? "macOS" : "Linux"}`);

  header("Step 1: Copy Extension Files");

  ensureDir(BASE_DIR);
  const srcExtensionDir = join(PACKAGE_ROOT, "extension");
  copyDirRecursive(srcExtensionDir, EXTENSION_DIR);
  success(`Extension files copied to: ${EXTENSION_DIR}`);

  header("Step 2: Resolve Extension ID");

  let resolved = await resolveExtensionId({ allowPrompt: false, preferConfig: true });
  let extensionId = resolved.id;

  if (!extensionId) {
    log(`
We need the extension ID to register the native messaging host.

Find it at ${color("cyan", "chrome://extensions")}:
- Locate ${color("bright", "Iris")}
- Click ${color("bright", "Details")}
- Copy the ${color("bright", "ID")}
`);

    resolved = await resolveExtensionId({ allowPrompt: true, preferConfig: false });
    extensionId = resolved.id;
  } else if (resolved.source === "manifest") {
    success(`Using fixed extension ID from manifest: ${extensionId}`);
  } else if (resolved.source === "config") {
    success(`Using extension ID from config.json: ${extensionId}`);
  } else if (resolved.source === "override") {
    success(`Using extension ID override: ${extensionId}`);
  }

  if (!extensionId) {
    error("Extension ID is required to continue.");
    process.exit(1);
  }

  if (!/^[a-p]{32}$/i.test(extensionId)) {
    warn("That doesn't look like a Chrome extension ID (expected 32 chars a-p). Continuing anyway.");
  }

  const manifestId = getExtensionIdFromManifest();
  if (resolved.source === "config" && manifestId && manifestId !== extensionId) {
    warn(`Manifest key implies ${manifestId}, but config.json uses ${extensionId}. Run update with --extension-id ${manifestId} to switch.`);
  }

  header("Step 3: Install Local Host + Broker");

  installRuntimeFiles();

  success(`Updated broker: ${BROKER_DST}`);
  success(`Updated browser CLI: ${BROWSER_CLI_DST}`);
  success(`Updated native host: ${NATIVE_HOST_DST}`);

  const nodePath = resolveNodePath();
  if (!/node(\.exe)?$/.test(nodePath)) {
    warn(`Node not detected; using ${nodePath}. Set OPENCODE_BROWSER_NODE if needed.`);
  }
  const hostPath = writeHostWrapper(nodePath);
  success(`Updated host wrapper: ${hostPath}`);

  const existingConfig = loadConfig();
  saveConfig({
    extensionId,
    installedAt: new Date().toISOString(),
    nodePath,
    profileEmails: existingConfig?.profileEmails || [],
  });

  header("Step 4: Register Native Messaging Host");

  const hostDirs = getNativeHostDirs(osName);
  removeLegacyNativeHostManifests(hostDirs);
  for (const dir of hostDirs) {
    try {
      writeNativeHostManifest(dir, extensionId, hostPath);
      success(`Wrote native host manifest: ${nativeHostManifestPath(dir)}`);
    } catch {
      warn(`Could not write native host manifest to: ${dir}`);
    }
  }

  const brokerStatus = await getBrokerStatus();
  if (brokerStatus.ok && brokerStatus.data?.hostConnected) {
    const reload = await brokerRequestOnce("extension_reload");
    if (reload.ok) {
      success("Sent reload to the extension — new code active after it reconnects (~5-30s)");
    } else {
      warn(`Could not hot-reload extension (${reload.error || "unknown error"}). Reload it once manually in chrome://extensions`);
    }
  } else {
    warn("Extension not connected — reload it once manually in chrome://extensions");
  }

  header("Update Complete!");
}

async function migrate() {
  header("Migrate Runtime");

  const osName = platform();
  if (osName !== "darwin" && osName !== "linux") {
    error(`Unsupported platform: ${osName}`);
    error("Iris currently supports macOS and Linux only.");
    process.exit(1);
  }

  ensureDir(BASE_DIR);
  copyDirRecursive(join(PACKAGE_ROOT, "extension"), EXTENSION_DIR);
  installRuntimeFiles();

  const currentConfig = loadConfig();
  const legacyConfig = loadConfig(LEGACY_CONFIG_DST);
  const resolved = await resolveExtensionId({ allowPrompt: false, preferConfig: true });
  const extensionId = resolved.id || legacyConfig?.extensionId || currentConfig?.extensionId;

  if (!extensionId) {
    error("Could not determine the extension ID from manifest or existing configs.");
    process.exit(1);
  }

  const nodePath = resolveNodePath();
  const hostPath = writeHostWrapper(nodePath);
  const profileEmails = currentConfig?.profileEmails || [];

  saveConfig({
    extensionId,
    installedAt: currentConfig?.installedAt || legacyConfig?.installedAt || new Date().toISOString(),
    migratedAt: new Date().toISOString(),
    migratedFrom: existsSync(LEGACY_BASE_DIR) ? LEGACY_BASE_DIR : null,
    nodePath,
    profileEmails,
  });

  const hostDirs = getNativeHostDirs(osName);
  removeLegacyNativeHostManifests(hostDirs);
  for (const dir of hostDirs) {
    try {
      writeNativeHostManifest(dir, extensionId, hostPath);
      success(`Wrote native host manifest: ${nativeHostManifestPath(dir)}`);
    } catch {
      warn(`Could not write native host manifest to: ${dir}`);
    }
  }

  success(`Migrated runtime into: ${BASE_DIR}`);
  if (existsSync(LEGACY_BASE_DIR)) {
    warn(`Legacy runtime preserved as backup: ${LEGACY_BASE_DIR}`);
  }
}


async function status() {
  header("Status");

  success(`Base dir: ${BASE_DIR}`);
  success(`Extension dir present: ${existsSync(EXTENSION_DIR)}`);
  success(`Broker installed: ${existsSync(BROKER_DST)}`);
  success(`Browser CLI installed: ${existsSync(BROWSER_CLI_DST)}`);
  success(`Native host installed: ${existsSync(NATIVE_HOST_DST)}`);
  success(`Host wrapper installed: ${existsSync(NATIVE_HOST_WRAPPER)}`);

  const cfg = loadConfig();
  if (cfg?.extensionId) {
    success(`Configured extension ID: ${cfg.extensionId}`);
  } else {
    warn("No config.json found (run: iris install)");
  }

  const manifestId = getExtensionIdFromManifest();
  if (manifestId) {
    success(`Fixed extension ID (manifest): ${manifestId}`);
  }

  if (cfg?.nodePath) {
    success(`Node path: ${cfg.nodePath}`);
  }

  if (Array.isArray(cfg?.profileEmails) && cfg.profileEmails.length) {
    success(`Profile gate: ${cfg.profileEmails.join(", ")}`);
  } else {
    success("Profile gate: unrestricted");
  }

  const osName = platform();
  const hostDirs = getNativeHostDirs(osName);
  let foundAny = false;
  for (const dir of hostDirs) {
    const p = nativeHostManifestPath(dir);
    if (existsSync(p)) {
      foundAny = true;
      success(`Native host manifest: ${p}`);
    }
  }
  if (!foundAny) {
    warn("No native host manifest found. Run: iris install");
  }

  header("Live");
  const live = await getBrokerStatus();
  if (!live.ok) {
    warn(`Broker: not reachable (${live.error || "unknown error"})`);
    warn("Extension: NOT connected");
    warn("Claims: unknown");
    warn("VERDICT: Run: node packages/core/bin/cli.js reconnect");
    return;
  }

  success("Broker: running");
  const hostCount = Number(live.data?.hostCount || 0);
  if (live.data?.hostConnected) {
    success(`Extension: connected (hosts: ${hostCount})`);
  } else {
    warn(`Extension: NOT connected (hosts: ${hostCount})`);
  }
  const claimCount = Array.isArray(live.data?.claims) ? live.data.claims.length : 0;
  success(`Claims: ${claimCount}`);
  if (live.data?.hostConnected) {
    success("VERDICT: no action needed");
  } else {
    warn("VERDICT: Open Chrome; the extension reconnects within ~30s. If it stays down: iris reconnect");
  }
}

function processTable() {
  try {
    return execSync("ps -axo pid,ppid,lstart,command | grep -E '[.]iris/(broker|native-host)' ", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString("utf8")
      .trim();
  } catch {
    return "";
  }
}

async function doctor() {
  header("Doctor");

  const live = await getBrokerStatus();
  if (live.ok) {
    success("Broker: running");
    const hostCount = Number(live.data?.hostCount || 0);
    if (live.data?.hostConnected) {
      success(`Extension: connected (hosts: ${hostCount})`);
    } else {
      warn(`Extension: NOT connected (hosts: ${hostCount})`);
    }
    const claims = Array.isArray(live.data?.claims) ? live.data.claims.length : 0;
    success(`Claims: ${claims}`);
    const hosts = Array.isArray(live.data?.hosts) ? live.data.hosts : [];
    if (hosts.length) {
      for (const host of hosts) {
        success(`Host pid=${host.pid ?? "unknown"} connectedAt=${host.connectedAt} lastPongAgoMs=${host.lastPongAgoMs}`);
      }
    } else {
      warn("Hosts: none");
    }
  } else {
    warn(`Broker: not reachable (${live.error || "unknown error"})`);
    warn("Extension: NOT connected");
  }

  header("Processes");
  const ps = processTable();
  if (ps) {
    log(ps);
  } else {
    warn("No .iris broker/native-host processes found");
  }

  header("Socket");
  success(`Socket file present: ${existsSync(BROKER_SOCKET)}`);

  header("Verdict");
  if (!live.ok) {
    warn("VERDICT: run node packages/core/bin/cli.js reconnect");
  } else if (!live.data?.hostConnected) {
    warn("VERDICT: open Chrome and wait ~30s; if it stays down, run iris reconnect");
  } else {
    success("VERDICT: no action needed");
  }
}

async function reconnect() {
  header("Reconnect");

  for (const pattern of [join(BASE_DIR, "broker.cjs"), join(BASE_DIR, "native-host.cjs")]) {
    try {
      execSync(`pkill -f ${shellQuote(pattern)}`, { stdio: "ignore" });
    } catch {}
  }

  try {
    if (existsSync(BROKER_SOCKET)) unlinkSync(BROKER_SOCKET);
  } catch {}

  spawnBroker();
  success("Started fresh broker");

  const brokerDeadline = Date.now() + 5000;
  let brokerLive = false;
  while (Date.now() < brokerDeadline) {
    const live = await getBrokerStatus(500);
    if (live.ok && live.data?.broker) {
      brokerLive = true;
      break;
    }
    await sleep(250);
  }

  if (!brokerLive) {
    warn("Broker did not answer within 5s");
    return;
  }
  success("Broker is running");

  const hostDeadline = Date.now() + 40000;
  let nextProgressAt = Date.now();
  while (Date.now() < hostDeadline) {
    const live = await getBrokerStatus(1000);
    if (live.ok && live.data?.hostConnected) {
      success("Extension connected");
      return;
    }
    if (Date.now() >= nextProgressAt) {
      warn("Waiting for Chrome extension host...");
      nextProgressAt = Date.now() + 5000;
    }
    await sleep(1000);
  }

  warn("Broker is running, but extension did not connect within 40s. Open Chrome and run iris doctor.");
}

async function agentInstall() {
  header("Agent Browser Install");

  const extraArgs = process.argv.slice(3).join(" ");
  const command = `npx agent-browser install ${extraArgs}`.trim();
  try {
    execSync(command, { stdio: "inherit" });
    success("agent-browser install completed.");
  } catch (err) {
    error(`agent-browser install failed: ${err?.message || err}`);
  }
}

async function agentGateway() {
  header("Agent Browser Gateway");

  const gatewayPath = join(PACKAGE_ROOT, "bin", "agent-gateway.cjs");
  success(`Starting gateway: ${gatewayPath}`);

  await new Promise((resolve) => {
    const child = spawn(process.execPath, [gatewayPath], { stdio: "inherit" });
    child.on("exit", resolve);
  });
}

async function uninstall() {
  header("Uninstall");

  const osName = platform();
  const hostDirs = getNativeHostDirs(osName);
  for (const dir of hostDirs) {
    removeNativeHostManifest(nativeHostManifestPath(dir));
  }

  for (const p of [BROKER_DST, BROWSER_CLI_DST, NATIVE_HOST_DST, NATIVE_HOST_WRAPPER, CONFIG_DST, BROKER_SOCKET]) {
    if (!existsSync(p)) continue;
    try {
      unlinkSync(p);
      success(`Removed: ${p}`);
    } catch {
      // ignore
    }
  }

  log(`
${color("bright", "Note:")}
- The unpacked extension folder remains at: ${EXTENSION_DIR}
- Remove it manually in ${color("cyan", "chrome://extensions")}
- Remove ${color("bright", "@mizner/iris-opencode")} from your opencode.json/opencode.jsonc plugin list if desired.
`);
}

main().catch((e) => {
  error(e.message || String(e));
  process.exit(1);
});
