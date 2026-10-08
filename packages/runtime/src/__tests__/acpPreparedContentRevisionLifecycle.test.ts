import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as json from "../json.js";
import type { AgentDefinition } from "../autoRun/agentRunner.js";
import { prepareAcpBlockRun } from "../autoRun/acpRunPreparation.js";
import { ExecutorAlreadyAdmittedError } from "../autoRun/executorShared.js";
import { capturePackageSnapshot } from "../package/packageSnapshot.js";
import { packageExecutionSnapshot } from "../package/packageExecutionSnapshot.js";
import {
  readImplementationRunMetadataFile,
  type ImplementationRunMetadata
} from "../taskManager/implementationRunMetadata.js";
import { claimNext } from "../taskManager/claimScheduler.js";
import { manifestTestBuilder } from "./manifestTestBuilder.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import { createMockAcpRunner, mockLaunch } from "./support/acpRunnerLifecycleFixture.js";

const originalHome = process.env.PLANWEAVE_HOME;
afterEach(() => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.PLANWEAVE_HOME;
  else process.env.PLANWEAVE_HOME = originalHome;
});

describe("ACP prepared captured content revision lifecycle", () => {
  it.each([
    true,
    false
  ])("preserves prepared identity across actual owner writes and admission (captured=%s)", async (captured) => {
    const profile = { adapter: "agent", agent: "codex", runner: { transport: "acp" } } as const;
    const { init } = await createTestWorkspace(
      manifestTestBuilder()
        .withExecutor("codex-acp", profile)
        .withDefaultExecutor("codex-acp")
        .build(),
      { trustPackageExecutors: false }
    );
    const workspace = init.workspace;
    const snapshot = await capturePackageSnapshot({ projectRoot: workspace });
    const executionSnapshot = captured
      ? packageExecutionSnapshot(workspace, snapshot.snapshot)
      : undefined;
    const claim = await claimNext({ projectRoot: workspace, executionSnapshot });
    if (claim.kind !== "block") throw new Error("expected implementation claim");
    const runRoot = join(workspace.resultsDir, "T-001", "blocks", "B-001", "runs");
    const metadataPath = join(runRoot, "RUN-001", "metadata.json");
    const persisted: ImplementationRunMetadata[] = [];
    const originalWrite = json.writeJsonFile;
    vi.spyOn(json, "writeJsonFile").mockImplementation(async (path, value) => {
      await originalWrite(path, value);
      if (path === metadataPath) {
        persisted.push(await readImplementationRunMetadataFile(metadataPath));
      }
    });
    const runner = createMockAcpRunner("artifact-implementation");
    const definition: AgentDefinition = {
      agent: "codex",
      builtinProfiles: {},
      cli: null,
      acp: {
        launch: mockLaunch("artifact-implementation"),
        capabilities: [],
        optionalCapabilities: [],
        limitations: []
      }
    };
    const input = {
      projectRoot: workspace,
      claim,
      executionSnapshot,
      prompt: "implement",
      executorName: "codex-acp",
      profile,
      profileSource: "builtin" as const
    };
    const beforeState = await readFile(workspace.stateFile, "utf8");
    const result = await runner.runBlock(input, definition);
    expect(result).toMatchObject({ kind: "block", exitCode: 0, runId: "RUN-001" });
    const admitted = persisted.find((metadata) => typeof metadata.executionAdmittedAt === "string");
    expect(admitted?.executionAdmittedAt).toEqual(expect.any(String));
    expect(persisted.some((metadata) => metadata.status === "running")).toBe(true);
    expect(persisted.at(-1)?.status).toBe("completed");
    for (const metadata of persisted) {
      expect(metadata.submissionAttemptId).toBe(claim.submissionAttemptId);
      if (metadata.status !== undefined) {
        expect(metadata.executionAdmittedAt).toBe(admitted?.executionAdmittedAt);
      }
      if (captured) {
        expect(
          metadata.preparedContentRevision,
          `persisted ${metadata.status ?? "prepared"} metadata must retain captured revision`
        ).toBe(snapshot.snapshot.sourceRevision);
      } else {
        expect(metadata).not.toHaveProperty("preparedContentRevision");
      }
    }
    const completedMetadata = await readFile(metadataPath, "utf8");
    await expect(prepareAcpBlockRun(input)).rejects.toBeInstanceOf(ExecutorAlreadyAdmittedError);
    await expect(runner.runBlock(input, definition)).rejects.toBeInstanceOf(
      ExecutorAlreadyAdmittedError
    );
    expect(await readFile(metadataPath, "utf8")).toBe(completedMetadata);
    expect(await readFile(workspace.stateFile, "utf8")).toBe(beforeState);
    expect((await readdir(runRoot)).filter((name) => name.startsWith("RUN-"))).toEqual(["RUN-001"]);
  });
});
