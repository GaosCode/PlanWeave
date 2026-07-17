import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import { registerPlanweaveTools } from "../toolRegistry.js";

let client: Client | undefined;
let server: McpServer | undefined;

afterEach(async () => {
  await client?.close();
  await server?.close();
  client = undefined;
  server = undefined;
});

async function connectRegistry(): Promise<Client> {
  server = new McpServer({ name: "planweave-registry-test", version: "0.0.0" });
  registerPlanweaveTools(server);
  client = new Client({ name: "planweave-registry-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("PlanWeave MCP tool registry", () => {
  it.each([
    ["update_block_planning", { sharedResources: ["api"], parallelSafe: true }],
    ["update_block_planning", { sharedResources: ["api"], parallelLocks: ["legacy"] }],
    [
      "bulk_update_blocks",
      {
        updates: [{ blockRef: "T-001#B-001", sharedResources: ["api"], locks: ["legacy"] }]
      }
    ],
    [
      "bulk_update_parallel_policy",
      {
        blocks: [{ blockRef: "T-001#B-001", sharedResources: ["api"], exclusive: true }]
      }
    ]
  ] as const)("rejects removed fields at the registered %s boundary", async (name, args) => {
    const registryClient = await connectRegistry();

    const result = await registryClient.callTool({
      name,
      arguments: { projectId: "project-1", ...args }
    });

    expect(result).toMatchObject({ isError: true });
    const errorText = result.content
      .map((content) => (content.type === "text" ? content.text : ""))
      .join("\n");
    expect(errorText).toContain("MCP error -32602");
    expect(errorText).toContain("Unrecognized key");
  });

  it("publishes strict input schemas for registered tools", async () => {
    const registryClient = await connectRegistry();
    const tools = await registryClient.listTools();

    for (const name of [
      "update_block_planning",
      "bulk_update_blocks",
      "bulk_update_parallel_policy"
    ]) {
      expect(tools.tools.find((tool) => tool.name === name)?.inputSchema).toMatchObject({
        additionalProperties: false
      });
    }
  });
});
