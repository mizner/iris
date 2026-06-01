# Contributing

Thanks for improving Iris.

## Development Setup

```bash
bun install
bun run build
bun run check:runtime
```

To test against a real browser:

```bash
node packages/core/bin/cli.js install
~/.iris/browser-cli.cjs status
```

Load the unpacked extension from `~/.iris/extension`.

## Pull Request Checklist

- Keep changes public-safe. Do not include local run evidence, private paths, screenshots, tokens, cookies, or captured browser data.
- Update docs when setup, runtime behavior, tool names, or troubleshooting steps change.
- Rebuild generated adapters after source changes.
- Run `bun run build` and `bun run check:runtime`.
- Prefer small, reviewable changes with clear motivation.

## Generated Files

The OpenCode and MCP adapters have built outputs under `dist/`. If you change adapter source, regenerate the matching built file before opening a PR.
