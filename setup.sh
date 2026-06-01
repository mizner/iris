#!/usr/bin/env bash
set -euo pipefail

# Iris local source setup.
# This is intentionally conservative: it builds the repo, installs the local
# runtime, and registers the built OpenCode plugin by absolute file URL.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENCODE_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
OPENCODE_JSON="$OPENCODE_CONFIG_DIR/opencode.json"
PLUGIN_PATH="$(
  node -e 'const path = require("path"); const { pathToFileURL } = require("url"); console.log(pathToFileURL(path.join(process.argv[1], "packages/opencode/dist/plugin.js")).href);' "$SCRIPT_DIR"
)"

echo "==> Iris setup"
echo ""

echo "[1/5] Installing dependencies"
cd "$SCRIPT_DIR"
if command -v bun >/dev/null 2>&1; then
  bun install
else
  echo "bun is required for the Iris workspace build." >&2
  exit 1
fi

echo "[2/5] Building adapters"
bun run build

echo "[3/5] Installing runtime"
node packages/core/bin/cli.js install

echo "[4/5] Registering local OpenCode plugin"
mkdir -p "$OPENCODE_CONFIG_DIR"

if [ ! -f "$OPENCODE_JSON" ]; then
  printf '{\n  "$schema": "https://opencode.ai/config.json",\n  "plugin": []\n}\n' > "$OPENCODE_JSON"
  echo "  Created $OPENCODE_JSON"
fi

node - "$OPENCODE_JSON" "$PLUGIN_PATH" <<'NODE'
const fs = require("fs");
const [configPath, pluginPath] = process.argv.slice(2);

function stripJsonc(contents) {
  return contents
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,\s*([}\]])/g, "$1");
}

let config;
try {
  config = JSON.parse(stripJsonc(fs.readFileSync(configPath, "utf8")));
} catch (error) {
  const backupPath = `${configPath}.bak-${Date.now()}`;
  fs.copyFileSync(configPath, backupPath);
  config = { $schema: "https://opencode.ai/config.json", plugin: [] };
  console.error(`  Backed up invalid config to ${backupPath}`);
}

if (!Array.isArray(config.plugin)) {
  config.plugin = typeof config.plugin === "string" && config.plugin.trim() ? [config.plugin.trim()] : [];
}

if (!config.plugin.includes(pluginPath)) {
  config.plugin.push(pluginPath);
}

if (typeof config.$schema !== "string") {
  config.$schema = "https://opencode.ai/config.json";
}

fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
console.log(`  Registered ${pluginPath}`);
NODE

echo "[5/5] Checking runtime status"
node packages/core/bin/cli.js status

echo ""
echo "==> Setup complete"
echo ""
echo "Next steps:"
echo "  1. Open chrome://extensions"
echo "  2. Enable Developer mode"
echo "  3. Load unpacked: ~/.iris/extension"
echo "  4. Restart OpenCode"
echo "  5. Try browser_status"
