# Changelog


## Unreleased

- Tab groups get useful names: the first site a session opens plus its harness (`codeable · omo`), or the agent's own name via the new `browser_name_group` (`Codeable Neverland quote · omo`, optional color). New tabs join the session's own group, so two sessions on the same site stay separate.
- The native host wrapper clears `NODE_COMPILE_CACHE`: a cache on an external drive made Chrome-launched hosts hang at startup (no macOS removable-volume access), so the extension never connected.
- Sessions reuse their own tab group: the broker remembers each session's group per profile, and a session keeps its name and group through lapsed claims, reconnects, and idle periods (up to 12 hours). `browser-cli` calls share one session (the calling agent's `PI_SESSION_ID`, else the working directory) instead of a new one per call, and `name_group` works from the CLI. `open_tab` reports `groupError` when Chrome refuses to group a tab.
- Sessions identify their harness (OMP, OMO, Codex, Hermes, OpenCode, CLI; MCP clients are detected from `clientInfo`) and project. `browser_get_tabs` marks claimed tabs with `claimedBy`, and claims and `browser_status` show the owner.

- Add `browser_read`: the page (or one section) as markdown, with heading outline and paging. Much cheaper than `page_text` or a full snapshot.
- `browser_snapshot`: `interactive=true` (actionable elements only, no page text), `selector` scope, `maxNodes`, `includeText`.
- `browser_screenshot`: `annotate=true` draws uid labels on interactive elements and returns the label list; `ifChanged=true` skips identical images; `savePath` writes to disk.
- MCP and OMP adapters return screenshots as image content instead of base64 text.
- Tabs and popups opened by a claimed tab are claimed for the same session, added to its tab group, and reported once as `openedTabs`.
- Add `browser_search_history`, `browser_bookmarks`, `browser_recently_closed` (restore, other devices). Unscoped calls search every connected profile. Adds `history`, `bookmarks`, `sessions`, `webNavigation` permissions.
- Add `browser_upload`: real file paths through a file input or Chrome's intercepted file chooser, with custom upload buttons and background tabs.
- `iris reconnect` starts the broker with the Node recorded at install (`config.json` `nodePath`).

- Several Chrome profiles: each session picks one (`browser_profiles`, `browser_use_profile`, `browser_resolve_profile`); `PROFILE_REQUIRED` instead of guessing. Optional `browser_run` decision model.
- Add `browser_request_user`: hand a tab to the user for sign-in, 2FA, or CAPTCHA (banner with Done button, notification) and wait for a URL, selector, text, or Done.
- Add `browser_evaluate`: evaluate JavaScript in the page's main world via CDP (ignores page CSP, awaits promises), with a main-world script fallback.
- Session tabs are collected in a Chrome tab group per session (`IRIS_TAB_GROUPS=off` disables). Adds the `tabGroups` permission.
- Fix: the OpenCode/OMP adapter started the broker with `process.execPath`, which inside compiled harnesses (OMP) is the harness binary, not Node; it launched stray agent runs and crashed after harness upgrades. Node is now resolved from `IRIS_NODE`, the running Node, `config.json` `nodePath`, or `PATH`.
- Fix: `browser_wait_for` polls from the service worker, so waits survive navigation and pages that were still loading. Waits longer than 60s no longer time out at the broker or adapter.
- Fix: `browser_network_stop` no longer attaches the debugger; it detaches by default so Chrome's debugging bar goes away (`detach=false` keeps console capture).
- Fix: WebMCP detection checks `document.modelContext` (Chromium removed `navigator.modelContext`).
- A closed tab returns `TAB_NOT_FOUND` with guidance and its claim is released; a session's own closed tab is replaced transparently.
- `browser_query`: `count` and `all` mode aliases; unknown modes list the valid ones; no-match errors suggest discovery calls.
- Skill drift check covers all skill copies, rejects references to tools that do not exist, and requires the OpenCode skill to match the template.

## 4.9.0

- Add `browser_hover` and `browser_drag`; extend `browser_click` with `button`, `clickCount`, and `modifiers`.
- Show a green agent cursor overlay during pointer actions (auto-fades; no settings UI).
- Add `browser_history` (`back` / `forward` / `reload`) and `browser_handle_dialog`.
- Snapshot diffs: preserve `data-iris-uid` across calls; default to added/removed/changed after the first full snapshot (`full=true` restamps).
- Toolbar badge shows claim count; clicking the Iris icon on a claimed tab releases it. Broker pings and claim changes push claim lists to the extension.

- Add `@mizner/iris-omp` Oh My Pi extension adapter (native `browser_*` tools via iris-opencode).
- Mask password/sensitive field values in `browser_snapshot` and page_text input dumps.
- Harden network header/body redaction (form-urlencoded, base64 JSON, credential/session headers); extract `extension/lib/network-redact.mjs` with unit tests.
- Stamp `data-iris-uid` on snapshot nodes; accept `uid=` / `ref=` locators for click/type.
- OMP extension races tool execution against AbortSignal so cancelled turns do not wait full broker timeout.


## 4.8.0

- Added `browser_press` with CDP `Input.dispatchKeyEvent` when the debugger is attached and DOM `KeyboardEvent` fallback; `browser_type` now emits per-character key events.
- Broker default-tab policy prefers the active Chrome tab (when claimable) before opening a blank tab; covered by broker integration tests.
- `iris doctor` / `iris status` report runtime file CURRENT/STALE via content hashes and flag stale installs.
- Extension badge turns green only on broker-sourced traffic (`ping` / `tool_request` / `reload`), not local `config_response`.
- Broker test isolates pong-freshness in `healthyHosts()` before socket reap.
- Fixed root `tool-test` import to `@mizner/iris-opencode` after package layout cleanup.
- Redact sensitive JSON fields in `browser_network_get` response bodies; prefer list without bodies.
- CDP-first `browser_click` via `Input.dispatchMouseEvent` when debugger is attached; DOM fallback otherwise.
- Label AppleScript/agent-browser router successes with plane markers; `IRIS_FALLBACK=off` disables non-extension planes.
- Agent-backend unsupported-tool errors list the supported tool subset.
- Add `test:skill-tools` check that skill docs cover all plugin `browser_*` tools.

## 4.7.0

- Added self-healing broker connection handling with a native-host registry, driven ping/pong keepalive, stale-host reaping, per-host pending rejection, and an extension watchdog.
- Added live `iris status`, `iris doctor`, `iris reconnect`, and update-time extension hot reload.
- Added broker integration tests for the orphan-host bug, host reaping, routing to healthy hosts, per-host pending rejection, and reload fan-out.
- Added a Claude Code MCP registration path while keeping the OpenCode plugin path supported.
- Landed debugger-backed network capture, `wait_for`, and per-tab WebMCP status from the pending adapter and extension work.
- Cleaned architecture by moving the skill template into the core package, dropping the dead root compatibility plugin and dead broker client, and using package exports for core paths.
- Added Iris log prefixes, `IRIS_*` environment aliases with legacy fallbacks, and Node `>=22` engine metadata.
- Fixed shadow-DOM snapshot traversal and AppleScript fallback quoting, tab parsing, and multi-browser fallback.
