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

  it("publishes the verified artifact before terminal in the real controller stream", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-acp-artifact-event-"));
    const readModels = new AcpEventReadModelRegistry();
    const controller = new AcpSessionController(
      new ActiveAgentRunRegistry(),
      createAcpConnection,
      readModels
    );

    await expect(
      controller.execute(run(root, "artifact-implementation"), { timeoutMs: 1_000 })
    ).resolves.toMatchObject({ kind: "block", exitCode: 0 });
    const snapshot = readModels.get(root)?.replay(0);
    const kinds = snapshot?.events.map((event) => event.body.kind) ?? [];
    expect(kinds).toContain("artifact");
    expect(kinds.indexOf("artifact")).toBeLessThan(kinds.indexOf("terminal"));
    expect(
      snapshot?.events.find((event) => event.body.kind === "artifact")
    ).toMatchObject({
      body: {
        kind: "artifact",
        artifact: { kind: "implementation", relativePath: "report.md" }
      }
    });
  });

  it("keeps a verified artifact event when later cleanup fails and marks partial success", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-acp-artifact-cleanup-"));
    const readModels = new AcpEventReadModelRegistry();
    const registry = new ActiveAgentRunRegistry();
    const controller = new AcpSessionController(
      registry,
      (options) => {
        const connection = createAcpConnection(options);
        return new Proxy(connection, {
          get(target, property) {
            if (property === "dispose") {
              return async () => {
                await target.dispose();
                throw new Error("cleanup failed after artifact verification");
              };
            }
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          }
        });
      },
      readModels
    );

    await expect(
      controller.execute(run(root, "artifact-implementation"), { timeoutMs: 1_000 })
    ).rejects.toThrow("Runner terminal cleanup did not complete cleanly");
    const events = readModels.get(root)?.replay(0).events ?? [];
    expect(events.map((event) => event.body.kind)).toEqual(
      expect.arrayContaining(["artifact", "diagnostic", "terminal"])
    );
    const artifactIndex = events.findIndex((event) => event.body.kind === "artifact");
    const terminalIndex = events.findIndex((event) => event.body.kind === "terminal");
    expect(artifactIndex).toBeGreaterThanOrEqual(0);
    expect(artifactIndex).toBeLessThan(terminalIndex);
    const metadata = await readFile(join(root, "metadata.json"), "utf8");
    expect(metadata).toContain('"status": "failed"');
    expect(metadata).toContain('"executionOutcome": "succeeded"');
    expect(metadata).toContain('"artifactReference"');
    expect(metadata).toContain("cleanup failed after artifact verification");
    expect(registry.size).toBe(0);
  });

  it("does not publish artifacts when execution fails before validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-acp-no-artifact-"));
    const readModels = new AcpEventReadModelRegistry();
    const controller = new AcpSessionController(
      new ActiveAgentRunRegistry(),
      createAcpConnection,
      readModels
    );

    await expect(
      controller.execute(run(root, "protocol-error"), { timeoutMs: 1_000 })
    ).rejects.toThrow();
    expect(readModels.get(root)?.replay(0).events.some(
      (event) => event.body.kind === "artifact"
    )).toBe(false);
    const metadata = await readFile(join(root, "metadata.json"), "utf8");
    expect(metadata).not.toContain('"executionOutcome": "succeeded"');
  });

  it("does not publish artifacts when execution is cancelled before validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-acp-cancel-no-artifact-"));
    const readModels = new AcpEventReadModelRegistry();
    const controller = new AcpSessionController(
      new ActiveAgentRunRegistry(),
      createAcpConnection,
      readModels
    );
    const abort = new AbortController();
    const execution = controller.execute(run(root, "long-prompt"), {
      timeoutMs: 1_000,
      signal: abort.signal
    });
    setTimeout(() => abort.abort(new Error("cancel before artifact validation")), 25);

    await expect(execution).rejects.toThrow("cancel before artifact validation");
    expect(readModels.get(root)?.replay(0).events.some(
      (event) => event.body.kind === "artifact"
    )).toBe(false);
    const metadata = await readFile(join(root, "metadata.json"), "utf8");
    expect(metadata).toContain('"status": "cancelled"');
    expect(metadata).not.toContain('"executionOutcome": "succeeded"');
  });
});
