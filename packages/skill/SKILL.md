---
name: iris
description: Use Iris when browser automation needs a real Chrome profile with persistent tabs, native messaging, downloads, console access, screenshots, and OpenCode/MCP/CLI adapters.
---

# Iris

Iris controls a real Chrome, Chromium, or Brave profile through a local broker, native messaging host, and Chrome extension.

Use Iris when a task needs real cookies, existing tabs, browser downloads, console logs, debugger-backed errors, or authenticated app state. Do not use Iris when a simple HTTP fetch or disposable headless browser is enough.

## Integration Modes

OpenCode plugin:

- Prefer native `browser_*` tools when available.
- Start with `browser_status` or `browser_health`.

MCP server:

- Run `node packages/mcp/dist/server.js`.
- Connect it from any MCP-aware client.

CLI:

- Use `~/.iris/browser-cli.cjs` for shell scripts and quick diagnostics.

## Recommended Workflow

1. Check health with `browser_status` or `browser_health`.
2. Inspect tabs with `browser_get_tabs` or `browser_get_active_tab`.
3. Claim a tab if multiple agents may be active.
4. Observe before acting with `browser_query`, `browser_snapshot`, or `browser_screenshot`.
5. Act with the narrowest reliable selector.
6. Verify the result after every navigation, click, type, or download.
7. Release claimed tabs when done.

## Tool Surface

- `browser_debug` - Debug adapter loading and session wiring.
- `browser_version` - Return adapter version metadata.
- `browser_status` - Show backend connection state and tab claims.
- `browser_health` - Probe extension, AppleScript, and agent fallbacks.
- `browser_get_tabs` - List open browser tabs.
- `browser_get_active_tab` - Return the active tab.
- `browser_list_claims` - Show current tab ownership claims.
- `browser_claim_tab` - Claim a tab for the current session.
- `browser_release_tab` - Release a claimed tab.
- `browser_open_tab` - Open and optionally claim a new tab.
- `browser_close_tab` - Close a claimed tab.
- `browser_navigate` - Navigate a tab to a URL.
- `browser_click` - Click an element by selector.
- `browser_type` - Type into an input or editable element.
- `browser_select` - Choose an option in a native `<select>`.
- `browser_scroll` - Scroll the page or an element.
- `browser_wait` - Sleep for a specified duration.
- `browser_query` - Read page text, attributes, properties, or selector matches.
- `browser_snapshot` - Capture the accessibility tree snapshot.
- `browser_screenshot` - Capture a screenshot.
- `browser_download` - Download a file by URL or click path.
- `browser_list_downloads` - List recent downloads.
- `browser_set_file_input` - Populate a file input from a local path.
- `browser_highlight` - Visually mark an element for debugging.
- `browser_console` - Read console log entries.
- `browser_errors` - Read JavaScript errors from the page.

## Selector Strategy

Discover first; do not guess selectors on complex pages.

Prefer:

- `browser_query selector="button,a,[role=button],input,select,textarea" mode=list limit=50`
- `browser_query mode=page_text limit=1000`
- `browser_snapshot` when structure matters more than raw text.

Selector prefixes, in rough preference order:

- `label:` for labeled form inputs.
- `aria:` for accessible names.
- `role:` for ARIA roles.
- `text:` for visible link/button text.
- `placeholder:` for inputs.
- `name:` for form names.
- `css:` as the last resort.

## Verification Pattern

After every action, verify with a cheap read:

```text
browser_click selector="text:Submit" timeoutMs=3000
browser_query mode=page_text pattern="Success|Error|Dashboard"
```

Report:

```text
VERIFICATION: SUCCESS | FAILURE | UNCERTAIN
Evidence: what changed or did not change.
Next action: what to try if not successful.
```

## Troubleshooting

- Broker not running: run `node packages/core/bin/cli.js status` or `iris status`.
- Extension not connected: reload the unpacked extension from `~/.iris/extension` and click the Iris icon once.
- Wrong browser profile: inspect `~/.iris/config.json`; an empty `profileEmails` list disables profile gating.
- Custom broker socket: set `IRIS_BROKER_SOCK` for the adapter process.
- Duplicate brokers or stale MCP servers: see `docs/reliability.md` in the Iris repository.

## Safety

Iris can expose real browser state to the calling agent. Avoid dumping private tabs, screenshots, cookies, secrets, auth pages, or account data into logs or commits.
