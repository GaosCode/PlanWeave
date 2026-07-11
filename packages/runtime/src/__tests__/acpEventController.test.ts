import { appendFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createAcpConnection } from "../autoRun/acpConnection.js";
import { AcpEventReadModelRegistry } from "../autoRun/acpEventReadModel.js";
import { AcpEventStore } from "../autoRun/acpEventStore.js";
import { AcpSessionController, type AcpSessionRun } from "../autoRun/acpSessionController.js";
import { ActiveAgentRunRegistry } from "../autoRun/activeAgentRunRegistry.js";

const fixture = fileURLToPath(new URL("./support/acpMockAgent.mjs", import.meta.url));

function run(root: string, scenario: string): AcpSessionRun {
  return {
    kind: "implementation",
    identity: { scope: root, executorRunId: "RUN-001", claimRef: "T-001#B-001" },
    runDir: root, metadataPath: join(root, "metadata.json"), prompt: scenario, cwd: root,
    launch: { command: process.execPath, args: [fixture, scenario] },
    executorName: "mock-acp", agentId: "codex", taskId: "T-001",
    metadataIdentity: { blockId: "B-001" }, projectId: "project-1", canvasId: "default"
  };
}

describe("ACP event controller durability and producers", () => {
  it("drains delayed raw writes and fails the run before success metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-acp-raw-barrier-"));
    const readModels = new AcpEventReadModelRegistry((options) => new AcpEventStore({
      ...options,
      appendText: async (path, data, encoding) => {
        if (String(path).endsWith("protocol.ndjson")) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          throw new Error("delayed raw persistence failed");
        }
        await appendFile(path, data, encoding);
      }
    }));
    const controller = new AcpSessionController(new ActiveAgentRunRegistry(), createAcpConnection, readModels);
    const promise = controller.execute(run(root, "artifact-implementation"), { timeoutMs: 500 });
    await expect(promise).rejects.toThrow("delayed raw persistence failed");
    const metadata = await readFile(join(root, "metadata.json"), "utf8");
    expect(metadata).toContain('"status": "failed"');
    expect(metadata).not.toContain('"status": "completed"');
  });

  it("persists permission and preview elicitation history as non-actionable", async () => {
    for (const scenario of ["permission", "elicitation"]) {
      const root = await mkdtemp(join(tmpdir(), `planweave-acp-${scenario}-`));
      const controller = new AcpSessionController(new ActiveAgentRunRegistry(), createAcpConnection, new AcpEventReadModelRegistry());
      await expect(controller.execute(run(root, scenario), { timeoutMs: 500 })).rejects.toThrow("Final artifact marker was not found");
      const events = await readFile(join(root, "events.ndjson"), "utf8");
      expect(events).toContain('"kind":"interaction"');
      expect(events).toContain('"actionable":false');
      expect(events).toContain(`"kind":"${scenario === "permission" ? "permission" : "elicitation"}"`);
    }
  });

  it("persists output returned through the official terminalOutput client callback", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-acp-terminal-output-"));
    const controller = new AcpSessionController(new ActiveAgentRunRegistry(), createAcpConnection, new AcpEventReadModelRegistry());
    const input = run(root, "terminal-output");
    input.terminalOutputHandler = () => ({ output: "terminal bytes", truncated: false });
    await expect(controller.execute(input, { timeoutMs: 500 })).resolves.toMatchObject({ kind: "block" });
    const events = await readFile(join(root, "events.ndjson"), "utf8");
    expect(events).toContain('"kind":"terminal_output"');
    expect(events).toContain("terminal bytes");
  });
});
