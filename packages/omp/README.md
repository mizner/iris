# @mizner/iris-omp

Oh My Pi (OMP) extension adapter for Iris.

This package registers Iris `browser_*` tools as a native OMP extension so agents can drive a **real** Chrome / Chromium / Brave profile through the local Iris broker and extension. It reuses the same tool surface as `@mizner/iris-opencode` and `@mizner/iris-mcp`.

## Iris vs OMP built-in `browser`

| Surface | What it is |
|---|---|
| **Iris `browser_*` tools** (this package) | Real browser profile, cookies, downloads, debugger network, tab claims |
| **OMP built-in `browser`** | Headless Chromium / CDP / cmux sandbox |

Use Iris when you need authenticated sessions or the user’s live tabs. Use the built-in tool for disposable automation.

## Build

From the monorepo root:

```bash
bun run build
# or
bun run --cwd packages/omp build
```

Output: `packages/omp/dist/extension.js` (bundles the OpenCode adapter).

## Install into OMP

### Dev link (source checkout)

```bash
bun run --cwd packages/omp build
omp plugin link /absolute/path/to/iris/packages/omp
```

Restart OMP (or start a new session). You should see tools such as `browser_status`, `browser_get_tabs`, and `browser_click`.

### Published package (when on npm)

```bash
omp plugin install @mizner/iris-omp
```

## Slash commands

| Command | Action |
|---|---|
| `/iris status` | Broker / claim status (`browser_status`) |
| `/iris health` or `/iris doctor` | Multi-plane health (`browser_health`) |
| `/iris reconnect` | Runs `iris reconnect` if the `iris` CLI is on `PATH` |

## Environment

Same as other Iris adapters:

- `IRIS_BROKER_SOCK` — override broker socket (default `~/.iris/broker.sock`)
- `IRIS_BACKEND` — `extension` (default) or `agent` / `agent-browser`
- `IRIS_FALLBACK` — set to `off` to disable AppleScript / agent-browser fallbacks

## Validation

```bash
bun run --cwd packages/omp build
node --test packages/omp/test/load.test.mjs
```

Live: after `omp plugin link`, call `browser_status` or `/iris status` with a healthy Iris runtime (`iris doctor` / `node packages/core/bin/cli.js doctor`).
