import { createHash } from "node:crypto";
import { mkdtemp, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MAX_CONTENT_BYTES, MAX_FILE_READ_BYTES } from "@planweave-ai/runtime/content-read-policy";
import { afterEach, describe, expect, it } from "vitest";
import { runtimeGateway } from "../toolRuntime.js";
import { registerPlanweaveTools } from "../toolRegistry.js";

let client: Client | undefined;
let server: McpServer | undefined;
afterEach(async () => {
  await client?.close();
  await server?.close();
  client = undefined;
  server = undefined;
});

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "planweave-mcp-content-"));
  process.env.PLANWEAVE_HOME = home;
  const imported = await runtimeGateway.importPlanPackage({
    name: "Content budget test",
    files: [
      {
        path: "manifest.json",
        encoding: "utf8",
        content: JSON.stringify({
          version: "plan-package/v1",
          project: { title: "Content budget", description: "" },
          execution: { parallel: { enabled: false, maxConcurrent: 1 } },
          review: { maxFeedbackCycles: 1, completionPolicy: "strict" },
          nodes: [
            {
              id: "T-001",
              type: "task",
              title: "Unicode",
              prompt: "task.md",
              acceptance: ["Content is readable."],
              blocks: [
                {
                  id: "B-001",
                  type: "implementation",
                  title: "Read",
                  prompt: "block.md",
                  depends_on: []
                }
              ]
            }
          ],
          edges: []
        })
      },
      { path: "task.md", encoding: "utf8", content: "😀😀😀中文" },
      { path: "block.md", encoding: "utf8", content: "# Block prompt\n" }
    ]
  });
  const projectId = imported.project.projectId;
  const packageDir = join(home, "projects", projectId, "canvases", "default", "package");
  server = new McpServer({ name: "content-runtime-test", version: "1" });
  registerPlanweaveTools(server);
  client = new Client({ name: "content-runtime-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, home, projectId, packageDir };
}

function hash(content: string) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

describe("MCP registered content tools with real Runtime files", () => {
  it("round-trips complete identity and code-point prefix through the registered tools", async () => {
    const { client, projectId, packageDir } = await setup();
    const file = await client.callTool({
      name: "read_package_file",
      arguments: { projectId, path: "task.md", maxBytes: 7 }
    });
    expect(file.isError).not.toBe(true);
    expect(file.structuredContent).toMatchObject({
      file: {
        content: "😀",
        truncated: true,
        contentRef: { hash: hash("😀😀😀中文"), sizeBytes: 18 }
      }
    });
    const source = await client.callTool({
      name: "read_prompt_source",
      arguments: { projectId, target: "task", taskId: "T-001", maxBytes: 7 }
    });
    expect(source.structuredContent).toMatchObject({
      prompt: { content: "😀", contentRef: { kind: "prompt_source", hash: hash("😀😀😀中文") } }
    });
    const list = await client.callTool({ name: "list_package_files", arguments: { projectId } });
    expect(list.structuredContent).toMatchObject({
      files: expect.arrayContaining([
        {
          path: "task.md",
          sizeBytes: 18,
          hash: hash("😀😀😀中文"),
          owner: { kind: "task", ref: "T-001" },
          preview: "😀😀😀中文",
          contentRef: {
            kind: "package_file",
            path: "task.md",
            hash: hash("😀😀😀中文"),
            sizeBytes: 18
          }
        }
      ])
    });
    await writeFile(join(packageDir, "default.txt"), "a".repeat(30_000));
    const defaultResult = await client.callTool({
      name: "read_package_file",
      arguments: { projectId, path: "default.txt" }
    });
    expect(defaultResult.structuredContent).toMatchObject({
      file: { content: "a".repeat(20_000), truncated: true }
    });
    const rendered = await client.callTool({
      name: "get_rendered_prompt",
      arguments: { projectId, ref: "T-001#B-001", maxBytes: 7 }
    });
    expect(rendered.isError).not.toBe(true);
    expect(rendered.structuredContent).toMatchObject({
      prompt: { truncated: true, contentRef: { kind: "rendered_prompt" } }
    });
  });

  it("publishes and enforces the output ceiling and sanitizes filesystem failures", async () => {
    const { client, projectId, packageDir, home } = await setup();
    const tools = await client.listTools();
    for (const name of ["read_package_file", "read_prompt_source", "get_rendered_prompt"]) {
      expect(tools.tools.find((tool) => tool.name === name)?.inputSchema.properties).toMatchObject({
        maxBytes: { maximum: MAX_CONTENT_BYTES, description: expect.stringContaining("20000") }
      });
    }
    const oversize = await client.callTool({
      name: "read_package_file",
      arguments: { projectId, path: "task.md", maxBytes: MAX_CONTENT_BYTES + 1 }
    });
    expect(oversize.isError).toBe(true);
    await expect(
      runtimeGateway.readPackageFile(projectId, undefined, "task.md", MAX_CONTENT_BYTES + 1)
    ).rejects.toMatchObject({ code: "content_max_bytes_invalid" });
    await symlink(home, join(packageDir, "outside"));
    for (const path of [
      "missing.txt",
      "../secret.txt",
      "outside/private.txt",
      join(home, "private.txt")
    ]) {
      const result = await client.callTool({
        name: "read_package_file",
        arguments: { projectId, path }
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain(home);
    }
    await writeFile(join(packageDir, "huge.txt"), "");
    await truncate(join(packageDir, "huge.txt"), MAX_FILE_READ_BYTES + 1);
    const huge = await client.callTool({
      name: "read_package_file",
      arguments: { projectId, path: "huge.txt" }
    });
    expect(huge.isError).toBe(true);
    expect(JSON.stringify(huge)).toContain("input budget");
    expect(JSON.stringify(huge)).not.toContain(home);
  });
});
