# @mizner/iris-mcp

stdio MCP adapter for Iris.

The MCP server wraps the OpenCode adapter implementation so MCP clients get the same `browser_*` tool surface and routing behavior.

## Build And Run

```bash
bun run --cwd packages/mcp build
node packages/mcp/dist/server.js
```

Set `IRIS_BROKER_SOCK` only when the broker socket is not `~/.iris/broker.sock`.

## Example MCP Config

```json
{
  "mcpServers": {
    "iris": {
      "command": "node",
      "args": ["/absolute/path/to/iris/packages/mcp/dist/server.js"]
    }
  }
}
```

## Notes

- The server registers every OpenCode `browser_*` tool.
- Tool results include text content and structured content when possible.
- Process guards exit the server when stdin closes or the parent process disappears.

## Validation

```bash
bun run --cwd packages/mcp build
node packages/mcp/test-client.mjs
```
