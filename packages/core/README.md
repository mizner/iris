# @mizner/iris

Core runtime package for Iris.

This package owns the pieces that actually connect Chrome to local tools:

- `bin/cli.js` - install, update, migrate, uninstall, and status commands.
- `bin/broker.cjs` - Unix socket broker and tab ownership state.
- `bin/native-host.cjs` - Chrome native messaging host.
- `bin/browser-cli.cjs` - direct shell CLI for broker calls.
- `extension/` - unpacked Chrome extension bundle.

## Quick Start

From the repository root:

```bash
bun run build
node packages/core/bin/cli.js install
node packages/core/bin/cli.js status
```

For a fresh machine, use `install`. For an existing Iris runtime, use `update`.

```bash
node packages/core/bin/cli.js update
```

`migrate` exists for users moving from the legacy `~/.opencode-browser` runtime to `~/.iris`.

## Runtime Layout

The installer writes:

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

The extension should be loaded unpacked from `~/.iris/extension`.

## Configuration

Runtime config lives in `~/.iris/config.json`:

```json
{
  "extensionId": "ncfalpcdanbcccbaakenefpokeioldgd",
  "profileEmails": []
}
```

Set `profileEmails` only when you want Iris to refuse browser profiles that do not match the allowlist.

## CLI

```bash
node packages/core/bin/cli.js install
node packages/core/bin/cli.js update
node packages/core/bin/cli.js migrate
node packages/core/bin/cli.js status
node packages/core/bin/cli.js uninstall
```

After install:

```bash
~/.iris/browser-cli.cjs status
~/.iris/browser-cli.cjs get_tabs
~/.iris/browser-cli.cjs navigate --url https://example.com
```

## Validation

```bash
bun run check:runtime
node packages/core/bin/cli.js status
~/.iris/browser-cli.cjs status
```
