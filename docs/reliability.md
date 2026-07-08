# Iris Reliability Notes

Iris is a small local control plane:

```text
OpenCode/MCP/CLI -> ~/.iris/broker.sock -> ~/.iris/native-host.cjs -> Chrome Iris extension
```

The reliability goal is intentionally boring: one broker per user, a native host wrapper that survives Node upgrades, and diagnostics that separate "broker down" from "no healthy Chrome extension host."

## Runtime Contract

- `~/.iris/broker.cjs` listens on `~/.iris/broker.sock`.
- Broker startup must be idempotent. If a live broker already owns the socket, a second broker exits cleanly instead of unlinking the socket.
- The broker keeps a registry of every connected native-host socket. A newer host is preferred only while it is healthy; an older healthy host remains usable if the newer socket exits.
- The broker sends pings every 20 seconds and drops hosts that have not produced inbound traffic within 45 seconds. `hostConnected: true` means at least one registered host is healthy by that rule.
- The extension does not mark itself connected until it receives broker traffic. After it sees a broker ping, its watchdog reconnects a silent port after about 50 seconds.
- Chrome's alarm is cold-start recovery. It wakes the service worker to connect when disconnected and sends config probes against older brokers that do not ping.
- `~/.iris/host-wrapper.sh` should call a stable Node path such as `/opt/homebrew/bin/node` or `/usr/local/bin/node`, then fall back to `command -v node`.
- The Chrome native messaging manifest should point at `~/.iris/host-wrapper.sh`.
- `browser_status` or `~/.iris/browser-cli.cjs status` returning `broker: true` and `hostConnected: false` means the broker is up but has no healthy native-host connection.
- `node packages/core/bin/cli.js doctor` is the standard diagnostic entry point. `node packages/core/bin/cli.js reconnect` is the standard repair path.

## Optional Process Supervision

Launchd, systemd, or another supervisor can keep the broker alive on always-on machines. The supervisor should run only the broker. Chrome owns native-host lifetime.

Guidelines:

- Do not start multiple brokers for the same user and socket.
- Keep the broker command simple: `node ~/.iris/broker.cjs`.
- Prefer user-level services over root-level services.
- Do not supervise `native-host.cjs`; Chrome starts and stops it through native messaging.
- If using an MCP adapter in a long-lived agent harness, make sure orphaned stdio processes exit when stdin closes or when their parent process dies.

## Diagnostics

```bash
~/.iris/browser-cli.cjs status
node packages/core/bin/cli.js doctor
lsof -U | grep '.iris/broker.sock'
ps -axo pid,ppid,lstart,command | grep -E '[.]iris/(broker|native-host)|iris/packages/mcp/dist/server'
sed -n '1,30p' ~/.iris/host-wrapper.sh
tail -100 ~/.iris/broker.log
tail -100 ~/.iris/router.log
```

Chrome-side checks:

1. Open `chrome://extensions`.
2. Find Iris.
3. Confirm it is enabled.
4. Inspect the service worker for connection errors only after `iris doctor` and `iris reconnect`.
5. Reload the unpacked extension from `~/.iris/extension` only as the last resort after reconnect fails.

## Common Failure Modes

`Could not connect to local broker`

The broker is down, the socket is stale, or the adapter is using the wrong socket path. Check `IRIS_BROKER_SOCK`, then run `node packages/core/bin/cli.js doctor` and `node packages/core/bin/cli.js reconnect`.

`Chrome extension is not connected (native host offline)`

The broker is reachable, but Chrome/native messaging has no healthy host. Open the target Chrome profile and run `node packages/core/bin/cli.js reconnect`; the extension should reconnect within about 30 seconds. Manual extension reload is the last resort.

Duplicate `broker.cjs` processes

Older runtime versions or custom supervisors may have raced with lazy startup. Current broker startup probes the socket first and exits if another broker is live.

Versioned Node wrapper

Native messaging can silently break after Homebrew, NVM, or package-manager upgrades if a wrapper points to a removed Node binary. Run `node packages/core/bin/cli.js update` to rewrite the wrapper.

Orphan MCP servers with `PPID 1`

The calling harness died and left the stdio server behind. The MCP server now installs stdin and parent-process guards so fresh versions should exit cleanly.

## Deployment Checklist

1. Build source artifacts: `bun run build`.
2. Syntax-check runtime files: `bun run check:runtime`.
3. Update runtime: `node packages/core/bin/cli.js update`.
4. Reconnect runtime: `node packages/core/bin/cli.js reconnect`.
5. Restart any OpenCode or MCP client process that should load the new adapter.
6. Verify `~/.iris/browser-cli.cjs status`.
7. Reload the unpacked extension in `chrome://extensions` only if the hot reload and reconnect path did not activate the new service worker.
