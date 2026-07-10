# Changelog


## Unreleased

- Added `browser_press` with CDP `Input.dispatchKeyEvent` when the debugger is attached and DOM `KeyboardEvent` fallback; `browser_type` now emits per-character key events.
- Broker default-tab policy prefers the active Chrome tab (when claimable) before opening a blank tab; covered by broker integration tests.
- `iris doctor` / `iris status` report runtime file CURRENT/STALE via content hashes and flag stale installs.
- Extension badge turns green only on broker-sourced traffic (`ping` / `tool_request` / `reload`), not local `config_response`.
- Broker test isolates pong-freshness in `healthyHosts()` before socket reap.
- Fixed root `tool-test` import to `@mizner/iris-opencode` after package layout cleanup.

## 4.7.0

- Added self-healing broker connection handling with a native-host registry, driven ping/pong keepalive, stale-host reaping, per-host pending rejection, and an extension watchdog.
- Added live `iris status`, `iris doctor`, `iris reconnect`, and update-time extension hot reload.
- Added broker integration tests for the orphan-host bug, host reaping, routing to healthy hosts, per-host pending rejection, and reload fan-out.
- Added a Claude Code MCP registration path while keeping the OpenCode plugin path supported.
- Landed debugger-backed network capture, `wait_for`, and per-tab WebMCP status from the pending adapter and extension work.
- Cleaned architecture by moving the skill template into the core package, dropping the dead root compatibility plugin and dead broker client, and using package exports for core paths.
- Added Iris log prefixes, `IRIS_*` environment aliases with legacy fallbacks, and Node `>=22` engine metadata.
- Fixed shadow-DOM snapshot traversal and AppleScript fallback quoting, tab parsing, and multi-browser fallback.
