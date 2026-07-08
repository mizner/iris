# Changelog

## 4.7.0

- Added self-healing broker connection handling with a native-host registry, driven ping/pong keepalive, stale-host reaping, per-host pending rejection, and an extension watchdog.
- Added live `iris status`, `iris doctor`, `iris reconnect`, and update-time extension hot reload.
- Added broker integration tests for the orphan-host bug, host reaping, routing to healthy hosts, per-host pending rejection, and reload fan-out.
- Added a Claude Code MCP registration path while keeping the OpenCode plugin path supported.
- Landed debugger-backed network capture, `wait_for`, and per-tab WebMCP status from the pending adapter and extension work.
- Cleaned architecture by moving the skill template into the core package, dropping the dead root compatibility plugin and dead broker client, and using package exports for core paths.
- Added Iris log prefixes, `IRIS_*` environment aliases with legacy fallbacks, and Node `>=22` engine metadata.
- Fixed shadow-DOM snapshot traversal and AppleScript fallback quoting, tab parsing, and multi-browser fallback.
