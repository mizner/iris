# @mizner/iris-opencode

OpenCode adapter for Iris.

This package exposes Iris as native OpenCode `browser_*` tools while reusing the core broker, native host, and extension runtime.

## Build

```bash
bun run --cwd packages/opencode build
```

The built plugin is written to:

```text
packages/opencode/dist/plugin.js
```

## OpenCode Config

When working from a source checkout, use an absolute file URL:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///absolute/path/to/iris/packages/opencode/dist/plugin.js"
  ]
}
```

If the package is published in your environment:

```json
{
  "plugin": ["@mizner/iris-opencode"]
}
```

## Tool Surface

- `browser_debug`, `browser_version`, `browser_status`, `browser_health`
- `browser_get_tabs`, `browser_get_active_tab`
- `browser_list_claims`, `browser_claim_tab`, `browser_release_tab`
- `browser_open_tab`, `browser_close_tab`, `browser_navigate`
- `browser_click`, `browser_type`, `browser_select`, `browser_scroll`, `browser_wait`
- `browser_query`, `browser_snapshot`, `browser_screenshot`
- `browser_download`, `browser_list_downloads`, `browser_set_file_input`
- `browser_highlight`, `browser_console`, `browser_errors`

## Validation

```bash
bun run --cwd packages/opencode build
node -e 'import("./packages/opencode/dist/plugin.js").then(async (m) => { const p = await m.default({}); console.log(Object.keys(p.tool).filter((n) => n.startsWith("browser_")).length); })'
```
