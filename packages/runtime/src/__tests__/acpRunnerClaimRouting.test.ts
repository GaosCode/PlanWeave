import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentDefinition } from "../autoRun/agentRunner.js";
import { recordBlockRunInIndex } from "../autoRun/blockRunIndex.js";
import { codexAgentDefinition } from "../autoRun/codexIntegration.js";
import { createAcpRunner } from "../autoRun/acpRunner.js";
import { createExecutorAdapter } from "../autoRun/executors.js";
import { executionWaveIdSchema } from "../autoRun/runnerContractSchemas.js";
import { getTaskWorkspace, listTaskWorkspaceRuns } from "../desktop/taskWorkspaceApi.js";
import { readJsonFile } from "../json.js";
import { runAutoRunStep } from "../taskManager/autoRunStep.js";
import { getExecutionStatus } from "../taskManager/executionStatus.js";
import { trustCommand } from "../taskManager/hookTrustStore.js";
import { claimNext } from "../taskManager/index.js";
import { manifestTestBuilder } from "./manifestTestBuilder.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import { fixture, mockLaunch } from "./support/acpRunnerLifecycleFixture.js";

describe("AcpRunner claim routing", () => {
  const profile = { adapter: "agent", agent: "codex", runner: { transport: "acp" } } as const;
  function definition(scenario: string): AgentDefinition {
    return {
      agent: "codex",
      builtinProfiles: {},
      cli: null,
      acp: {
        launch: mockLaunch(scenario),
        capabilities: [],
        optionalCapabilities: [],
        limitations: []
      }
    };
  }

  it("requires exact trust for a package override before creating a run record", async () => {
    const { init } = await createTestWorkspace();
    const runner = createAcpRunner();
    const agentDefinition = definition("artifact-implementation");
    const input = {
      projectRoot: init.workspace,
      claim: {
        kind: "block",
        ref: "T-001#B-001",
        taskId: "T-001",
        blockId: "B-001",
        blockType: "implementation",
        effectiveExecutor: "codex-acp"
      },
      prompt: "implement",
      executorName: "codex-acp",
      profile,
      profileSource: "package"
    } as const;
    const before = await readdir(init.workspace.resultsDir, { recursive: true });

    await expect(runner.runBlock(input, agentDefinition)).rejects.toThrow("not trusted");
    expect(await readdir(init.workspace.resultsDir, { recursive: true })).toEqual(before);

    const launch = mockLaunch("artifact-implementation");
    await trustCommand(init.workspace, launch.command, [...launch.args]);
    await expect(runner.runBlock(input, agentDefinition)).resolves.toMatchObject({
      kind: "block"
    });
  });

  it("routes implementation, review, and feedback claims through distinct sessions", async () => {
    const { init } = await createTestWorkspace();
    const runner = createAcpRunner();
    for (const scenario of ["artifact-implementation", "artifact-review", "artifact-feedback"]) {
      const launch = mockLaunch(scenario);
      await trustCommand(init.workspace, launch.command, [...launch.args]);
    }
    const executionWaveId = executionWaveIdSchema.parse(
      "WAVE-123e4567-e89b-42d3-a456-426614174000"
    );
    const implementation = await runner.runBlock(
      {
        projectRoot: init.workspace,
        claim: {
          kind: "block",
          ref: "T-001#B-001",
          taskId: "T-001",
          blockId: "B-001",
          blockType: "implementation",
          effectiveExecutor: "codex-acp"
        },
        prompt: "implement",
        executorName: "codex-acp",
        profile,
        executionWaveId
      },
      definition("artifact-implementation")
    );
    const review = await runner.runBlock(
      {
        projectRoot: init.workspace,
        claim: {
          kind: "block",
          ref: "T-001#R-001",
          taskId: "T-001",
          blockId: "R-001",
          blockType: "review",
          effectiveExecutor: "codex-acp"
        },
        prompt: "review",
        executorName: "codex-acp",
        profile
      },
      definition("artifact-review")
    );
    const feedback = await runner.runFeedback(
      {
        projectRoot: init.workspace,
        workspace: init.workspace,
        claim: {
          kind: "feedback",
          feedbackId: "FE-001",
          sourceReviewBlockRef: "T-001#R-001",
          taskId: "T-001",
          content: "fix",
          effectiveExecutor: "codex-acp"
        },
        executorName: "codex-acp",
        profile
      },
      definition("artifact-feedback")
    );

    expect(implementation).toMatchObject({ kind: "block", agentSessionId: "mock-session-1" });
    expect(review).toMatchObject({ kind: "review", agentSessionId: "mock-session-1" });
    expect(feedback).toMatchObject({ kind: "feedback", agentSessionId: "mock-session-1" });
    expect(new Set([implementation.runId, review.runId])).toEqual(new Set(["RUN-001"]));
    if (implementation.kind !== "block") throw new Error("Expected implementation result.");
    await expect(
      readFile(join(dirname(implementation.reportPath), "prompt.md"), "utf8")
    ).resolves.toBe("implement");
    await expect(
      readJsonFile<Record<string, unknown>>(
        join(dirname(implementation.reportPath), "metadata.json")
      )
    ).resolves.toMatchObject({ executionWaveId });
    if (review.kind !== "review" || feedback.kind !== "feedback") {
      throw new Error("Expected review and feedback results.");
    }
    await expect(
      readJsonFile<Record<string, unknown>>(join(dirname(review.resultPath), "metadata.json"))
    ).resolves.not.toHaveProperty("executionWaveId");
    await expect(
      readJsonFile<Record<string, unknown>>(join(dirname(feedback.reportPath), "metadata.json"))
    ).resolves.not.toHaveProperty("executionWaveId");
  });

  it("propagates cancellation through createExecutorAdapter and restores TaskManager claim state", async () => {
    const { init } = await createTestWorkspace();
    const previousLaunch = codexAgentDefinition.acp.launch;
    codexAgentDefinition.acp.launch = mockLaunch("delayed");
    await trustCommand(init.workspace, process.execPath, [fixture, "delayed"]);
    const abort = new AbortController();
    try {
      const step = runAutoRunStep({
        projectRoot: init.workspace,
        executor: createExecutorAdapter({
          projectRoot: init.workspace,
          executorName: "codex-acp",
          runtime: {
            signal: abort.signal,
            timeoutMs: 500,
            desktopRunId: "DESKTOP-RUN-0001",
            runSessionId: "SESSION-0001"
          }
        })
      });
      setTimeout(() => abort.abort(new Error("end-to-end cancelled")), 10);
      await expect(step).rejects.toMatchObject({ name: "AbortError" });
      const status = await getExecutionStatus({ projectRoot: init.workspace });
      expect(status.blocks.find((block) => block.ref === "T-001#B-001")?.status).toBe("ready");
    } finally {
      codexAgentDefinition.acp.launch = previousLaunch;
    }
  });

  it("publishes an active ACP block run before execution settles", async () => {
    const { root, init } = await createTestWorkspace();
    await claimNext({ projectRoot: init.workspace });
    let releaseIndex!: () => void;
    const indexRelease = new Promise<void>((resolve) => {
      releaseIndex = resolve;
    });
    let announceIndex!: () => void;
    const indexPublished = new Promise<void>((resolve) => {
      announceIndex = resolve;
    });
    let firstRecord = true;
    const runner = createAcpRunner({
      recordBlockRun: async (runRoot, runId, options) => {
        await recordBlockRunInIndex(runRoot, runId, options);
        if (!firstRecord) return;
        firstRecord = false;
        announceIndex();
        await indexRelease;
      }
    });
    const execution = runner.runBlock(
      {
        projectRoot: init.workspace,
        claim: {
          kind: "block",
          ref: "T-001#B-001",
          taskId: "T-001",
          blockId: "B-001",
          blockType: "implementation",
          effectiveExecutor: "codex-acp"
        },
        prompt: "implement",
        executorName: "codex-acp",
        profile,
        profileSource: "builtin"
      },
      definition("artifact-implementation")
    );
    let settled = false;
    void execution.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    await indexPublished;
    const workspace = await getTaskWorkspace({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001"
    });
    const runs = await listTaskWorkspaceRuns({
      projectRoot: root,
      canvasId: "default",
      taskId: "T-001"
    });
    expect(settled).toBe(false);
    const liveRun = runs.items.find((item) => item.run.duration.finishedAt === null);
    if (!liveRun) throw new Error("Expected the indexed ACP run to remain unfinished.");
    expect(workspace.activeRecordIds).toContain(liveRun.run.record.recordId);
    expect(liveRun).toMatchObject({
      active: true,
      run: { metadata: { runnerKind: "acp" } }
    });

    releaseIndex();
    await expect(execution).resolves.toMatchObject({ kind: "block", runnerKind: "acp" });
  });

  it("submits a validated ACP final artifact through the TaskManager pipeline", async () => {
    const { init } = await createTestWorkspace();
    const previousLaunch = codexAgentDefinition.acp.launch;
    codexAgentDefinition.acp.launch = mockLaunch("artifact-implementation");
    await trustCommand(init.workspace, process.execPath, [fixture, "artifact-implementation"]);
    try {
      await expect(
        runAutoRunStep({
          projectRoot: init.workspace,
          executorName: "codex-acp"
        })
      ).resolves.toMatchObject({
        kind: "submitted",
        adapterResult: { kind: "block", runnerKind: "acp" },
        submitResult: { ref: "T-001#B-001", status: "completed" }
      });
    } finally {
      codexAgentDefinition.acp.launch = previousLaunch;
    }
  });

  it("persists a scheduler-provided wave id through the profiled ACP adapter", async () => {
    const { init } = await createTestWorkspace(
      manifestTestBuilder().withDefaultExecutor("codex-acp").build()
    );
    const previousLaunch = codexAgentDefinition.acp.launch;
    codexAgentDefinition.acp.launch = mockLaunch("artifact-implementation");
    await trustCommand(init.workspace, process.execPath, [fixture, "artifact-implementation"]);
    try {
      const executionWaveId = executionWaveIdSchema.parse(
        "WAVE-123e4567-e89b-42d3-a456-426614174001"
      );
      const adapter = createExecutorAdapter({
        projectRoot: init.workspace,
        executorName: "codex-acp"
      });
      await expect(
        adapter.runBlock({
          claim: {
            kind: "block",
            ref: "T-001#B-001",
            taskId: "T-001",
            blockId: "B-001",
            blockType: "implementation",
            effectiveExecutor: "codex-acp"
          },
          prompt: "implement",
          executionWaveId
        })
      ).resolves.toMatchObject({ kind: "block" });
      const metadata = await readJsonFile<Record<string, unknown>>(
        join(
          init.workspace.resultsDir,
          "T-001",
          "blocks",
          "B-001",
          "runs",
          "RUN-001",
          "metadata.json"
        )
      );

      expect(metadata.executionWaveId).toBe(executionWaveId);
    } finally {
      codexAgentDefinition.acp.launch = previousLaunch;
    }
  });
});
