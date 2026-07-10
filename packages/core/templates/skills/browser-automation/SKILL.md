---
name: browser-automation
description: Reliable browser automation patterns for Iris and OpenCode browser_* tools.
license: MIT
compatibility: opencode
metadata:
  audience: agents
  domain: browser
  plugin: iris
---

# Browser Automation With Iris

Use this skill when OpenCode has Iris `browser_*` tools available and the task needs a real Chrome profile.

Iris routes through a local extension, native messaging host, and broker. The extension path is the preferred low-latency path. AppleScript and `agent-browser` are fallback paths for supported operations.

## Preflight

Always start with:

```text
browser_status
browser_get_tabs
```

If there are connection problems:

```text
browser_health
```

Interpretation:

- `broker: false` usually means the local broker is down or the socket path is wrong.
- `broker: true` and `hostConnected: false` means Chrome/native messaging is not connected.
- Reload the unpacked extension from `~/.iris/extension` when extension files changed.

## Observe Before Acting

Do not guess selectors on non-trivial pages. Discover first:

```text
browser_query selector="button,a,[role=button],input,select,textarea" mode=list limit=50
browser_query mode=page_text limit=1000
browser_snapshot
browser_screenshot
```

Use `browser_snapshot` when accessibility structure matters. Use `browser_screenshot` when layout, modals, or visual state matters.

## Selector Preference

Prefer selectors in this order:

- `label:` for labeled form inputs.
- `aria:` for accessible names.
- `role:` for ARIA roles.
- `text:` for visible link or button text.
- `placeholder:` for input placeholders.
- `name:` for form names.
- `css:` only when semantic selectors are not enough.

When a query returns multiple matches, use `index` only after listing the candidates.

```text
browser_query selector="button" mode=list limit=20
browser_click selector="button" index=2
```

## Act And Verify

Every action should be followed by a read that proves what happened.

```text
browser_click selector="text:Submit" timeoutMs=3000
browser_query mode=page_text pattern="Success|Error|Dashboard"
```

Report results explicitly:

```text
VERIFICATION: SUCCESS | FAILURE | UNCERTAIN
Evidence: observed page state.
Next action: recovery step if needed.
```

## Common Workflows

Open a tab:

```text
browser_open_tab url="https://example.com"
browser_query mode=page_text limit=500
```

Fill a form:

```text
browser_query selector="input,textarea,select,button" mode=list limit=50
browser_type selector="label:Email" text="user@example.com"
browser_query selector="label:Email" mode=value
browser_press key="Enter"
browser_press key="Escape" selector="input.search"
browser_click selector="text:Submit"
browser_query mode=page_text pattern="Success|Error"
```

Download a file:

```text
browser_download selector="a.download" wait=true downloadTimeoutMs=30000
browser_list_downloads limit=5
```

Set a file input:

```text
browser_set_file_input selector="input[type=file]" filePath="/absolute/path/to/file.pdf"
```

Debug a selector:

```text
browser_highlight selector="button.submit" duration=3000 color="red" showInfo=true
browser_query selector="button.submit" mode=list limit=10
```

## Recovery Rules

- If a selector fails twice, run a discovery query before trying again.
- If a click appears to do nothing, check for modals, overlays, disabled buttons, and navigation state.
- If a page is behind login, ask the user to complete the login rather than trying to bypass it.
- If a captcha appears, stop and ask the user.
- If the same action fails three times, switch strategy or ask for user help.

## CLI Fallback

When native OpenCode tools are unavailable, use the installed CLI:

```bash
~/.iris/browser-cli.cjs status
~/.iris/browser-cli.cjs get_tabs
~/.iris/browser-cli.cjs navigate --url https://example.com
```

Use the CLI for diagnostics, not as a replacement for native tools when the plugin is loaded.

## Safety

Iris can see real browser state. Avoid logging private tab contents, screenshots, account pages, auth data, or secrets unless the user explicitly asks and it is necessary for the task.
