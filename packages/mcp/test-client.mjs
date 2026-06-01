import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "iris-mcp-test-client", version: "1.0.0" });

async function main() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["packages/mcp/dist/server.js"],
    env: { ...process.env },
  });

  await client.connect(transport);
  const tools = await client.listTools();
  console.log(JSON.stringify(tools, null, 2));
  await client.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
