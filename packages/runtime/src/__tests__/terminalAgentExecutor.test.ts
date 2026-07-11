import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeCodeExecAdapter, createPiExecAdapter, runAutoRunStep } from "../index.js";
import { readJsonFile } from "../json.js";
import { claudeCodeAgentDefinition } from "../autoRun/claudeCodeIntegration.js";
import { cliRunner, createCliRunner } from "../autoRun/cliRunner.js";
import { ExecutorCancelledError } from "../autoRun/executorShared.js";
import { piAgentDefinition } from "../autoRun/piIntegration.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import { manifestTestBuilder } from "./manifestTestBuilder.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

const terminalAgents = [
  {
    name: "fake-claude",
    adapter: "claude-code-exec",
    createAdapter: createClaudeCodeExecAdapter
  },
  {
    name: "fake-pi",
    adapter: "pi-exec",
    createAdapter: createPiExecAdapter
  }
] as const;

const terminalFeedbackAgents = [
  {
    name: "fake-claude-feedback",
    adapter: "claude-code-exec",
    definition: claudeCodeAgentDefinition,
    profile: {
      adapter: "agent",
      agent: "claude-code",
      runner: { transport: "cli" },
      command: process.execPath,
      args: ["-e", "console.log('claude feedback report')"]
    }
  },
  {
    name: "fake-pi-feedback",
    adapter: "pi-exec",
    definition: piAgentDefinition,
    profile: {
      adapter: "agent",
      agent: "pi",
      runner: { transport: "cli" },
      command: process.execPath,
      args: ["-e", "console.log('pi feedback report')"]
    }
  }
] as const;

describe("terminal agent executors", () => {
  it("finalizes block and feedback metadata when terminal-agent execution is cancelled", async () => {
    const runner = createCliRunner({
      executeProcess: () => Promise.reject(new ExecutorCancelledError())
    });
    const profile = {
      adapter: "agent" as const,
      agent: "claude-code" as const,
      runner: { transport: "cli" as const },
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 60_000)"]
    };
    const blockWorkspace = await createTestWorkspace();
    const feedbackWorkspace = await createTestWorkspace();

    await expect(
      runner.runBlock(
        {
          projectRoot: blockWorkspace.init.workspace,
          claim: {
            kind: "block",
            ref: "T-001#B-001",
            taskId: "T-001",
            blockId: "B-001",
            blockType: "implementation",
            effectiveExecutor: "cancelled-terminal"
          },
          prompt: "Implement task",
          executorName: "cancelled-terminal",
          profile,
          runtime: { tmuxEnabled: false }
        },
        claudeCodeAgentDefinition
      )
    ).rejects.toBeInstanceOf(ExecutorCancelledError);
    await expect(
      runner.runFeedback(
        {
          projectRoot: feedbackWorkspace.init.workspace,
          workspace: feedbackWorkspace.init.workspace,
          claim: {
            kind: "feedback",
            feedbackId: "FE-001",
            sourceReviewBlockRef: "T-001#R-001",
            taskId: "T-001",
            content: "Address review feedback.",
            effectiveExecutor: "cancelled-terminal"
          },
          executorName: "cancelled-terminal",
          profile,
          runtime: { tmuxEnabled: false }
        },
        claudeCodeAgentDefinition
      )
    ).rejects.toBeInstanceOf(ExecutorCancelledError);

    const paths = [
      join(
        blockWorkspace.init.workspace.resultsDir,
        "T-001",
        "blocks",
        "B-001",
        "runs",
        "RUN-001",
        "metadata.json"
      ),
      join(feedbackWorkspace.init.workspace.resultsDir, "feedback-runs", "RUN-001", "metadata.json")
    ];
    await Promise.all(
      paths.map((path) =>
        expect(readJsonFile(path)).resolves.toMatchObject({
          finishedAt: expect.any(String),
          exitCode: 130,
          outcome: "cancelled",
          cancelled: true,
          stopped: true,
          failureReason: "Executor cancelled."
        })
      )
    );
  });

  it.each(
    terminalAgents
  )("runs $adapter in the project directory and submits stdout as the block report", async ({
    name,
    adapter,
    createAdapter
  }) => {
    const manifest = manifestTestBuilder()
      .withExecutor(name, {
        adapter,
        command: process.execPath,
        args: [
          "-e",
          [
            "const fs = require('node:fs');",
            "const path = require('node:path');",
            "let input='';",
            "process.stdin.on('data', c => input += c);",
            "process.stdin.on('end', () => {",
            `  fs.writeFileSync(path.join(process.cwd(), '${name}-cwd.txt'), process.cwd());`,
            `  fs.writeFileSync(path.join(process.cwd(), '${name}-planweave-home.txt'), process.env.PLANWEAVE_HOME ?? '');`,
            "  console.log('report:' + input.includes('Implement task'));",
            "});"
          ].join("")
        ]
      })
      .withDefaultExecutor(name)
      .build();
    const { root, init } = await createTestWorkspace(manifest);

    await expect(
      runAutoRunStep({
        projectRoot: init.workspace,
        executor: createAdapter({
          projectRoot: init.workspace,
          executorName: name,
          runtime: { tmuxEnabled: false }
        })
      })
    ).resolves.toMatchObject({
      kind: "submitted",
      claim: { kind: "block", ref: "T-001#B-001" },
      adapterResult: { kind: "block", adapter, agentSessionId: null },
      submitResult: { ref: "T-001#B-001", runId: "RUN-001", status: "completed" }
    });

    const runDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001");
    await expect(readFile(join(runDir, "report.md"), "utf8")).resolves.toContain("report:true");
    await expect(readFile(join(root, `${name}-cwd.txt`), "utf8")).resolves.toBe(
      init.workspace.rootPath
    );
    await expect(readFile(join(root, `${name}-planweave-home.txt`), "utf8")).resolves.toBe(
      init.workspace.planweaveHome
    );
    const metadata = await readJsonFile<Record<string, unknown>>(join(runDir, "metadata.json"));
    expect(metadata).toMatchObject({
      executor: name,
      adapter,
      projectRoot: init.workspace.rootPath,
      executionCwd: init.workspace.rootPath,
      agentSessionId: null,
      exitCode: 0
    });
    expect(metadata.tmuxSessionId).toBeUndefined();
  });

  it("reads review results from the injected JSON result file path", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("fake-claude-review", {
        adapter: "claude-code-exec",
        command: "./claude",
        args: ["-p"]
      })
      .withDefaultExecutor("fake-claude-review")
      .build();
    const { root, init } = await createTestWorkspace(manifest);
    await writeFile(
      join(root, "claude"),
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "let input='';",
        "process.stdin.on('data', c => input += c);",
        "process.stdin.on('end', () => {",
        "  fs.writeFileSync('claude-review-prompt.md', input);",
        "  fs.writeFileSync(process.env.PLANWEAVE_REVIEW_RESULT_PATH, JSON.stringify({",
        "    reviewBlockRef: process.env.PLANWEAVE_REVIEW_BLOCK_REF,",
        "    taskId: process.env.PLANWEAVE_TASK_ID,",
        "    verdict: 'passed',",
        "    content: 'review file passed'",
        "  }));",
        "  console.log('human readable review');",
        "});"
      ].join("\n"),
      "utf8"
    );
    await chmod(join(root, "claude"), 0o755);

    await runAutoRunStep({
      projectRoot: init.workspace,
      executor: {
        async runBlock() {
          const reportPath = join(root, "implementation.md");
          await writeFile(reportPath, "implemented\n", "utf8");
          return { kind: "block", reportPath };
        },
        async runFeedback() {
          throw new Error("feedback should not run");
        }
      }
    });
    const step = await runAutoRunStep({
      projectRoot: init.workspace,
      executor: createClaudeCodeExecAdapter({
        projectRoot: init.workspace,
        executorName: "fake-claude-review",
        runtime: { tmuxEnabled: false }
      })
    });

    expect(step).toMatchObject({
      kind: "submitted",
      claim: { kind: "block", ref: "T-001#R-001", blockType: "review" },
      adapterResult: {
        kind: "review",
        adapter: "claude-code-exec",
        resultPath: expect.stringContaining("review-result.json")
      },
      submitResult: { ref: "T-001#R-001", verdict: "passed", status: "completed" }
    });
    await expect(readFile(join(root, "claude-review-prompt.md"), "utf8")).resolves.toContain(
      "Auto Run Review Result File"
    );
    await expect(
      readJsonFile(
        join(
          init.workspace.resultsDir,
          "T-001",
          "blocks",
          "R-001",
          "runs",
          "RUN-001",
          "review-result.json"
        )
      )
    ).resolves.toMatchObject({
      verdict: "passed",
      content: "review file passed"
    });
  });

  it("fails closed when an executable adapter omits persisted artifact metadata", async () => {
    const { root } = await createTestWorkspace();
    const reportPath = join(root, "unverified-report.md");
    await writeFile(reportPath, "unverified\n");

    await expect(
      runAutoRunStep({
        projectRoot: root,
        executor: {
          runBlock: async () => ({
            kind: "block",
            reportPath,
            adapter: "codex-exec"
          }),
          runFeedback: async () => {
            throw new Error("feedback should not run");
          }
        }
      })
    ).resolves.toMatchObject({
      kind: "blocked",
      claim: { kind: "blocked", ref: "T-001#B-001" }
    });
  });

  it.each(
    terminalFeedbackAgents
  )("preserves $adapter identity through the live feedback route", async ({
    name,
    adapter,
    definition,
    profile
  }) => {
    const { init } = await createTestWorkspace();
    if (!definition.cli) {
      throw new Error(`Expected CLI dialect for '${definition.agent}'.`);
    }

    const result = await cliRunner.runFeedback(
      {
        projectRoot: init.workspace,
        workspace: init.workspace,
        claim: {
          kind: "feedback",
          feedbackId: "FE-001",
          sourceReviewBlockRef: "T-001#R-001",
          taskId: "T-001",
          content: "Address review feedback.",
          effectiveExecutor: name
        },
        executorName: name,
        profile,
        runtime: { tmuxEnabled: false }
      },
      definition
    );

    expect(result).toMatchObject({
      kind: "feedback",
      adapter,
      executor: name,
      reportPath: expect.stringContaining("report.md")
    });
    await expect(
      readJsonFile(join(init.workspace.resultsDir, "feedback-runs", "RUN-001", "metadata.json"))
    ).resolves.toMatchObject({
      feedbackId: "FE-001",
      executor: name,
      adapter
    });
  });
});
