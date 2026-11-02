---
name: iris
description: Use Iris when browser automation needs the user's real Chrome profiles (signed-in accounts, existing tabs, downloads, console, network) through OpenCode/OMP/MCP/CLI adapters. Several Chrome profiles can be connected at once; each session picks one and stays in it.
---

# Iris

Iris controls real Chrome, Chromium, or Brave profiles through a local broker, a native messaging host, and a Chrome extension running in each profile.

Use Iris when a task needs real cookies, existing tabs, browser downloads, console logs, debugger-backed errors, or authenticated app state. Do not use Iris when a simple HTTP fetch or a disposable headless browser is enough.

## Step 0: pick the Chrome profile

Each Chrome profile is a separate signed-in account with its own extension instance. A session works in exactly one profile. Iris never guesses between profiles: with several connected and none chosen, tab calls fail with `PROFILE_REQUIRED`.

1. Call `browser_profiles`. Each entry shows the profile name, account, `purpose`, `connected`, `openSites`, `windowFocused`, `default`, and `sessionProfile`. `decisionModel.available` says whether `browser_run` and model tie-breaks are on.
2. Choose using the first rule that applies:
   - The user named an account, company, or profile: use that one.
   - Only one profile is connected: it is used automatically.
   - Otherwise call `browser_resolve_profile url=<target> task="<short intent>"`. It checks, in order: the task names a profile, the site is already open in exactly one profile, the site is listed under one profile's `domains`, and finally (when available) a decision model whose answer can be UNSURE. With `confident: true`, use `profile`; `pin=true` selects it in the same call.
   - With `confident: false`, choose from `candidates` using their purpose and open sites. If it is still unclear and the work signs in, submits, sends, buys, or deletes, ask the user and name the candidates. Read-only work may use `suggestion` (the configured default).
3. Call `browser_use_profile profile=<name>` unless it is already selected. Every later call stays in that profile, and results carry `profile` so you can confirm where you are.
4. If you get `PROFILE_NOT_CONNECTED`, run `iris open-profile <name>` in a shell and retry. Do not switch to another profile to make the call succeed.

Do not tell the user to click the Iris icon to switch profiles. That old workaround no longer selects anything. To fix a whole session to one profile at launch, set `IRIS_PROFILE=<name>` for the adapter or CLI.

## Stay out of the user's way

Prefer the least intrusive option that works, in this order:

1. **Your own background tab (default).** Calls without `tabId` use this session's own background tab. `browser_open_tab` opens in the background.
2. **A tab the user already has open.** Find it with `browser_get_tabs` (or `matchingTabs` from `browser_resolve_profile`) and `browser_claim_tab` it. Do not navigate away from a page the user is reading unless asked. `browser_get_active_tab` returns the tab the user is looking at.
3. **Taking focus.** Use `active=true` only when a page must be visible to work, such as some sites that pause rendering in background tabs.
4. **Computer use.** Only for things outside page content: native file dialogs, Chrome's own UI, macOS permission sheets. It takes over the screen, so it is the last resort; use the computer-use skill.

Debugger-backed tools (`browser_console`, `browser_errors`, network capture, some clicks and background screenshots) can show Chrome's "started debugging" bar. Prefer `browser_query` and `browser_snapshot` when they are enough. Release claimed tabs and close tabs you opened when you are done.

## Fast path: browser_run

When `decisionModel.available` is true, prefer `browser_run` for routine multi-step navigation (search and open a result, fill a short form, move through a few pages). A fast decision model picks each click or typing step; it never writes text.

- Give one objective on one site with explicit steps. Split long flows into sub-goals.
- Pass every string to type as `facts: ["name=value"]`. Only fact names reach the model; values stay local.
- Statuses:
  - `done`: verify on the page.
  - `unsure`: read `proposal` and decide yourself.
  - `needs_agent`: an irreversible action is proposed. Do it yourself with the step tools only if the user asked for it.
  - `blocked`, `stuck`, `max_steps`, `error`: inspect the page and change approach.
  - `unavailable`: no decision model is configured.
- Pass `allowIrreversible=true` only when the user explicitly asked for the send, payment, or deletion.
- Use step tools for date pickers, rich editors, canvas apps, and judgment-heavy pages.

## Integration Modes

OMP extension:

- Prefer native Iris `browser_*` tools when the `@mizner/iris-omp` extension is loaded.
- Do not confuse them with OMP's built-in `browser` tool (headless/CDP).

OpenCode plugin:

- Prefer native `browser_*` tools when available.

MCP server:

- Run `node packages/mcp/dist/server.js` and connect it from any MCP-aware client.

CLI:

- Use `~/.iris/browser-cli.cjs` for shell scripts and quick diagnostics. Pass `--profile <name>` or set `IRIS_PROFILE`; each CLI call is its own session.

## Recommended Workflow

1. Pick the profile (Step 0).
2. Use `browser_run` for routine navigation when available; otherwise continue with the step tools.
3. Observe before acting with `browser_query`, `browser_snapshot`, or `browser_screenshot`.
4. Act with the narrowest reliable selector (`uid:` from a snapshot, then `text:` / `label:`). Hover before CSS menus; drag for reorder UIs. After the first snapshot, diffs are the default; pass `full=true` if uids look wrong.
5. Read again before every action: navigation and large DOM changes reissue uids.
6. Verify the result after every navigation, click, type, or download. Two identical failures mean change approach, not retry.
7. Release claimed tabs when done.

## Tool Surface

- `browser_debug` - Debug adapter loading and session wiring.
- `browser_version` - Return adapter version metadata.
- `browser_status` - Show connection state, connected profiles, this session's profile, and tab claims.
- `browser_health` - Probe extension, AppleScript, and agent fallbacks.
- `browser_profiles` - List Chrome profiles with purpose, connection, open sites, and the session's profile.
- `browser_use_profile` - Choose the profile this session works in.
- `browser_resolve_profile` - Suggest a profile for a url and task, with reason, matching tabs, and optional pin.
- `browser_run` - Pursue one short goal with a decision model choosing each step.
- `browser_get_tabs` - List open tabs; before a profile is chosen, lists every profile's tabs labeled by profile.
- `browser_get_active_tab` - Return the tab the user is looking at, with its profile.
- `browser_list_claims` - Show current tab ownership claims.
- `browser_claim_tab` - Claim a tab for the current session (also selects that tab's profile if none is chosen).
- `browser_release_tab` - Release a claimed tab.
- `browser_open_tab` - Open a background tab (and claim it).
- `browser_close_tab` - Close a claimed tab.
- `browser_navigate` - Navigate a tab to a URL.
- `browser_history` - Go back, forward, or reload (`action=back|forward|reload`).
- `browser_handle_dialog` - Accept or dismiss a JavaScript alert/confirm/prompt.
- `browser_click` - Click an element by selector (`button`, `clickCount=2` for double-click, `modifiers`).
- `browser_hover` - Hover the pointer over an element (CSS menus, tooltips).
- `browser_drag` - Drag from `fromSelector` to `toSelector`.
- `browser_type` - Type into an input or editable element.
- `browser_press` - Press a key (Enter/Tab/Escape/arrows/char) with optional modifiers and focus selector.
- `browser_select` - Choose an option in a native `<select>`.
- `browser_scroll` - Scroll the page or an element.
- `browser_wait` - Sleep for a specified duration.
- `browser_wait_for` - Wait for a selector, text, page-text regex, URL pattern, or network idle.
- `browser_query` - Read page text, attributes, properties, or selector matches.
- `browser_snapshot` - Capture the accessibility tree snapshot. First call is full; later calls return a uid-preserving diff unless `full=true`.
- `browser_screenshot` - Capture a visible, full-page, selector, or clipped screenshot (background tabs use the debugger, not focus).
- `browser_download` - Download a file by URL or click path.
- `browser_list_downloads` - List recent downloads.
- `browser_set_file_input` - Populate a file input from a local path.
- `browser_highlight` - Visually mark an element for debugging.
- `browser_console` - Read console log entries.
- `browser_errors` - Read JavaScript errors from the page.
- `browser_network_start` - Start debugger-backed network capture for a tab.
- `browser_network_list` - List captured requests with redacted headers.
- `browser_network_get` - Inspect one captured request; response bodies are opt-in.
- `browser_network_stop` - Stop network capture while retaining records until cleared.
- `browser_profile_status` - Return allowlist gating status per profile.
- `browser_webmcp_status` - Detect WebMCP/native model context signals on the current page.

## Selector Strategy

Discover first; do not guess selectors on complex pages.

Prefer:

- `browser_query selector="button,a,[role=button],input,select,textarea" mode=list limit=50`
- `browser_query mode=page_text limit=1000`
- `browser_snapshot` when structure matters more than raw text.

Selector prefixes, in rough preference order:

- `uid:` / `ref:` for snapshot node ids (`e0`, `e1`, …).
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

Prefer condition-based waits over fixed sleeps:

```text
browser_wait_for selector="text:Dashboard" state="visible" timeoutMs=10000
browser_wait_for urlPattern="/settings" timeoutMs=10000
browser_wait_for state="networkidle" networkIdleMs=500 timeoutMs=15000
```

For web app debugging, start network capture before the action that matters:

```text
browser_network_start clear=true
browser_click selector="text:Save" timeoutMs=5000
browser_wait_for state="networkidle" networkIdleMs=500 timeoutMs=15000
browser_network_list filter="/api/" limit=50
```

Headers are redacted by default. Response bodies are opt-in with `browser_network_get includeBody=true`, and sensitive JSON fields are redacted before return; still avoid dumping secrets into logs.

Report:

```text
VERIFICATION: SUCCESS | FAILURE | UNCERTAIN
Evidence: what changed or did not change.
Next action: what to try if not successful.
```

## Configuration

Runtime configuration lives in `~/.iris/config.json` (never in this repository):

```json
{
  "profileEmails": ["you@example.com", "you@work.example"],
  "profiles": {
    "personal": { "email": "you@example.com", "purpose": "Personal and client work", "domains": ["example-client.com"], "default": true },
    "work": { "email": "you@work.example", "purpose": "Company admin: cloud console, CRM", "domains": ["portal.azure.com"] }
  },
  "decisionModel": { "enabled": true, "model": "jev-1.13.0" }
}
```

- `profileEmails` is the allowlist; profiles outside it are never routing candidates.
- `profiles` gives each account a short name, a purpose, and sites it owns. Agents see these through `browser_profiles`. `default` is only a suggestion for read-only work, never an automatic choice.
- The decision model is used whenever `TYPESAFE_API_KEY` is in the environment or `~/.secrets`. Set `"enabled": false` or `IRIS_DECISION=off` to turn it off. Every decision it makes includes an UNSURE option and is gated on confidence and margin; UNSURE hands the choice back to you.

## Troubleshooting

- `PROFILE_REQUIRED`: several profiles are connected and none is chosen. Do Step 0.
- `PROFILE_NOT_CONNECTED`: the chosen profile has no open window. Run `iris open-profile <name>`.
- `PROFILE_UNKNOWN`: the name is not in `profiles` and no connected profile has that email.
- Broker not running: run `node packages/core/bin/cli.js status` or `iris status`.
- Extension not connected: run `iris reconnect`; reload the unpacked extension from `~/.iris/extension` only as a last resort.
- Custom broker socket: set `IRIS_BROKER_SOCK` for the adapter process.
- Duplicate brokers or stale MCP servers: see `docs/reliability.md` in the Iris repository.

## Safety

Iris exposes real browser state to the calling agent. Never read credentials through the page (no evaluation that extracts passwords, tokens, cookies, or recovery codes), and never clear cookies, cache, or site data: these are the user's real profiles. Avoid dumping private tabs, screenshots, auth pages, or account data into logs or commits.
