# Iris

Iris is an open-source Chrome extension and local browser automation runtime for OpenCode. It lets OpenCode agents inspect and control the browser you actually use, with your real tabs, cookies, downloads, console logs, and authenticated sessions.

The important bit: Iris is local-first. There is no cloud proxy between OpenCode and Chrome. OpenCode talks to a local plugin, the plugin talks to a local broker, and the broker talks to Chrome through native messaging.

## What Iris Gives OpenCode

- A real Chrome, Chromium, or Brave profile instead of a disposable headless browser.
- Persistent tabs that survive across tool calls and agent turns.
- `browser_*` tools for navigation, clicks, typing, screenshots, snapshots, console logs, errors, downloads, and file inputs.
- Per-tab ownership so parallel agents can avoid stomping on each other's browser state.
- Fallback routing across the extension path, AppleScript tab operations on macOS, and `agent-browser`.
- Optional profile gating through `~/.iris/config.json`.

## Architecture

```text
OpenCode / MCP / CLI
        |
        v
Iris adapter
        |
        v
~/.iris/broker.sock
        |
        v
Chrome native messaging host
        |
        v
Iris Chrome extension
        |
        v
Real browser tabs
```

The fast path is:

```text
OpenCode -> @mizner/iris-opencode -> ~/.iris/broker.sock -> com.iris.host -> Iris extension
```

The extension path is preferred because it keeps latency low and gives Iris access to Chrome APIs that headless automation does not have.

## Repository Layout

- `packages/core` - CLI, broker, native messaging host, extension files, and runtime installer.
- `packages/opencode` - OpenCode plugin that exposes the `browser_*` tools.
- `packages/mcp` - stdio MCP adapter for clients that speak MCP.
- `packages/omp` - Oh My Pi (OMP) extension adapter for native `browser_*` tools.
- `packages/skill` - portable agent skill/instructions for using Iris safely.
- `.opencode/skills/browser-automation` - optional OpenCode skill template for browser automation patterns.
- `docs/reliability.md` - operational notes for keeping the local runtime healthy.


## Requirements

- macOS or Linux.
- Chrome, Chromium, or Brave.
- Node.js 22 or newer.
- Bun for development/builds.
- OpenCode if you want native OpenCode tools.

Iris currently installs native messaging manifests for Chrome, Chromium, and Brave. Windows support is not implemented.

## Install From Source

```bash
git clone https://github.com/mizner/iris.git
cd iris
bun install
bun run build
node packages/core/bin/cli.js install
```

The installer copies runtime files into `~/.iris`, registers the `com.iris.host` native messaging host, and can optionally update an OpenCode config.

Then load the extension:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select `~/.iris/extension`.
5. Click the Iris extension once if Chrome has not started the native host yet.

Verify:

```bash
node packages/core/bin/cli.js status
~/.iris/browser-cli.cjs status
```

## OpenCode Setup

For a source checkout, build the OpenCode adapter and register the built plugin by absolute `file://` URL:

```bash
bun run --cwd packages/opencode build
```

Example OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///absolute/path/to/iris/packages/opencode/dist/plugin.js"
  ]
}
```

If the package is published in your environment, you can use:

```json
{
  "plugin": ["@mizner/iris-opencode"]
}
```

After restarting OpenCode, these tools should be available:

```text
browser_status
browser_health
browser_get_tabs
browser_open_tab
browser_navigate
browser_click
browser_type
browser_snapshot
browser_screenshot
browser_console
browser_errors
```

## MCP Setup

Build and run the MCP adapter over stdio:

```bash
bun run --cwd packages/mcp build
node packages/mcp/dist/server.js
```

Example MCP config:

```json
{
  "mcpServers": {
    "iris": {
      "command": "node",
      "args": ["/absolute/path/to/iris/packages/mcp/dist/server.js"]
    }
  }
}
```

Set `IRIS_BROKER_SOCK` only if you intentionally run the broker somewhere other than `~/.iris/broker.sock`.

## Claude Code Setup

Register Iris as a user-scope Claude Code MCP server:

```bash
claude mcp add --scope user iris -- node /absolute/path/to/iris/packages/mcp/dist/server.js
```

The OpenCode plugin and Claude MCP server can coexist; both talk to the same local Iris broker.

## OMP Setup

Build the OMP extension and link it into your OMP profile:

```bash
bun run --cwd packages/omp build
omp plugin link /absolute/path/to/iris/packages/omp
```

Restart OMP (or open a new session). Iris tools such as `browser_status`, `browser_get_tabs`, and `browser_click` should be available alongside OMP’s built-in `browser` tool (headless/CDP). Prefer Iris `browser_*` for real Chrome profiles; use built-in `browser` for disposable automation.

Helpers:

```text
/iris status
/iris health
/iris reconnect
```

When published:

```bash
omp plugin install @mizner/iris-omp
```


## CLI Usage

The runtime installer places a small CLI at `~/.iris/browser-cli.cjs`:

```bash
~/.iris/browser-cli.cjs status
~/.iris/browser-cli.cjs get_tabs
~/.iris/browser-cli.cjs navigate --url https://example.com
~/.iris/browser-cli.cjs screenshot
```

The CLI is useful for shell scripts, debugging, and checking whether the extension path is connected before opening OpenCode.

## Runtime Configuration

Iris stores runtime state in `~/.iris`:

```text
~/.iris/
├── broker.cjs
├── broker.sock
├── browser-cli.cjs
├── config.json
├── extension/
├── host-wrapper.sh
└── native-host.cjs
```

`~/.iris/config.json` is the user-owned runtime config. Common fields:

```json
{
  "extensionId": "ncfalpcdanbcccbaakenefpokeioldgd",
  "profileEmails": []
}
```

`profileEmails` is optional. Leave it empty to allow any browser profile, or set one or more email addresses to make the extension refuse the wrong profile.

The unpacked extension includes a fixed manifest key so the extension ID should remain `ncfalpcdanbcccbaakenefpokeioldgd` when loaded from the installed runtime directory.

## Development

```bash
bun install
bun run build
bun run check:runtime
node packages/core/bin/cli.js update
```

Build targets:

- `bun run build` builds the OpenCode adapter and MCP adapter.
- `bun run --cwd packages/opencode build` builds only the OpenCode adapter.
- `bun run --cwd packages/mcp build` builds only the MCP adapter.
- `bun run check:runtime` syntax-checks the runtime JavaScript files.

## Security And Privacy

Iris gives local agents meaningful access to your browser. Treat it like a powerful local automation tool.

- The broker listens on a Unix socket under `~/.iris`; it is intended for same-user local processes.
- Iris does not add a cloud service or send browser data to this repository.
- Browser data can still be exposed to whatever agent or harness you connect to Iris.
- Do not commit `~/.iris`, browser profiles, run evidence, screenshots, auth files, logs, or captured tab dumps.
- Use `profileEmails` if you want Iris to refuse a non-target Chrome profile.

## Troubleshooting

`broker: false`

The local broker is not running or the socket is stale. Run:

```bash
node packages/core/bin/cli.js status
node packages/core/bin/cli.js doctor
node packages/core/bin/cli.js reconnect
```

`broker: true` and `hostConnected: false`

The broker is running, but no healthy native host is connected. Run:

```bash
node packages/core/bin/cli.js doctor
node packages/core/bin/cli.js reconnect
```

Open Chrome in the target profile and wait about 30 seconds. Manual reload from `chrome://extensions` is now the last resort, not the first step.

Runtime update did not activate new extension code

`node packages/core/bin/cli.js update` copies the runtime files and asks the broker to hot-reload the extension when a healthy host is connected. If the extension is offline during update, open Chrome and run `iris reconnect`; reload the unpacked extension manually only if doctor still reports `hostConnected: false`.

Duplicate broker processes

Current broker startup is idempotent: a second broker should detect the live socket and exit instead of stealing it. If you see old duplicate processes, stop the stale ones and rerun `node packages/core/bin/cli.js update`.

Native host broke after a Node upgrade

Rerun:

```bash
node packages/core/bin/cli.js update
```

The installer writes `~/.iris/host-wrapper.sh` with a stable Node path when possible.

Environment variables

- `IRIS_BROKER_SOCK` overrides the broker socket path.
- `IRIS_CLAIM_TTL_MS` controls tab-claim expiry; legacy `OPENCODE_BROWSER_CLAIM_TTL_MS` is still honored.
- `IRIS_PING_INTERVAL_MS` and `IRIS_PONG_TIMEOUT_MS` tune broker keepalive timing.
- `IRIS_NODE` overrides the Node binary used in the native host wrapper; legacy `OPENCODE_BROWSER_NODE` is still honored.
- `IRIS_EXTENSION_ID` overrides extension ID discovery; legacy `OPENCODE_BROWSER_EXTENSION_ID` is still honored.
- `IRIS_BACKEND` selects the adapter backend; legacy `OPENCODE_BROWSER_BACKEND` and `OPENCODE_BROWSER_MODE` are still honored.
- `IRIS_MAX_UPLOAD_BYTES` caps file uploads through the extension path; legacy `OPENCODE_BROWSER_MAX_UPLOAD_BYTES` is still honored.
- `IRIS_BROWSER_APP` selects the AppleScript browser app before the default Chrome, Brave, and Chromium order.

## License

MIT. See [LICENSE](./LICENSE).
