# AGENTS.md - Iris

This file is guidance for coding agents working in the Iris repository.

Iris is an open-source Chrome extension and local browser automation runtime for OpenCode. Keep the repo public-safe: do not commit local run evidence, browser tab dumps, private paths, auth files, cookies, tokens, screenshots, or machine-specific deployment notes.

## Architecture

```text
OpenCode / MCP / CLI
        |
        v
adapter package
        |
        v
~/.iris/broker.sock
        |
        v
native messaging host
        |
        v
Iris Chrome extension
        |
        v
real browser tabs
```

Latency preference:

1. Extension -> broker -> adapter.
2. AppleScript tab fallback on macOS for simple tab/navigation operations.
3. `agent-browser` fallback when configured.

## Key Files

| File | Purpose |
| --- | --- |
| `packages/core/bin/cli.js` | Runtime installer, updater, migration, and status CLI |
| `packages/core/bin/broker.cjs` | Unix socket broker and tab ownership coordinator |
| `packages/core/bin/native-host.cjs` | Chrome native messaging bridge |
| `packages/core/bin/browser-cli.cjs` | Direct shell CLI for broker operations |
| `packages/core/extension/background.js` | MV3 extension service worker |
| `packages/core/extension/manifest.json` | Chrome extension manifest |
| `packages/opencode/src/plugin.ts` | OpenCode adapter and `browser_*` tool registration |
| `packages/mcp/src/server.ts` | stdio MCP adapter |
| `packages/skill/SKILL.md` | Portable agent skill |
| `.opencode/skills/browser-automation/SKILL.md` | Optional OpenCode skill template |
| `docs/reliability.md` | Generic runtime reliability notes |

## Runtime Paths

Runtime files are installed outside the repository:

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

The Chrome native messaging host name is `com.iris.host`. The extension ID is expected to remain `ncfalpcdanbcccbaakenefpokeioldgd` when the bundled manifest key is preserved.

## Development Commands

```bash
bun install
bun run build
bun run check:runtime
node packages/core/bin/cli.js status
node packages/core/bin/cli.js update
```

Package-specific builds:

```bash
bun run --cwd packages/opencode build
bun run --cwd packages/mcp build
```

## Coding Rules

- Use 2-space indentation.
- Prefer double quotes and semicolons in TypeScript and Node runtime files.
- Keep extension code compatible with Chrome MV3 service workers.
- Do not add a configuration UI to the Chrome extension; runtime configuration belongs in `~/.iris/config.json` and harness-side docs.
- Keep fallback routing automatic. Do not prompt the user before trying the next available control plane.
- Do not hardcode profile restrictions in source. Use `profileEmails` in `~/.iris/config.json`.
- Do not bake versioned Node paths into `host-wrapper.sh`; use stable symlinks or `command -v node`.
- Regenerate built outputs after changing adapter source.

## Public-Safety Rules

Before committing or pushing:

- Run a secret/private-path scan over tracked and staged files.
- Keep `.sisyphus/`, `.codex-orchestrator.json`, `~/.iris`, logs, screenshots, and captured browser evidence out of Git.
- Avoid personal machine names, private hostnames, private email addresses, local absolute paths, or account-specific docs in public files.
- If an operational note is machine-specific, keep it in a private notes repo or local skill overlay, not in this repository.

## Validation

Minimum checks after runtime or adapter changes:

```bash
bun run build
bun run check:runtime
node packages/core/bin/cli.js status
```

For a live browser smoke test:

```bash
~/.iris/browser-cli.cjs status
~/.iris/browser-cli.cjs get_tabs
```

Expected healthy shape:

```json
{
  "broker": true,
  "hostConnected": true
}
```
