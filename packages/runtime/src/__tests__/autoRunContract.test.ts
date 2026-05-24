import { access, chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createCodexExecAdapter,
  createManualExecutorAdapter,
  createLocalReviewAdapter,
  createOpencodeExecAdapter,
  getAutoRunStatus,
  getExecutionStatus,
  listExecutorProfiles,
  runAutoRunStep
} from "../index.js";
import { readJsonFile } from "../json.js";
import { consumeAutoRunClaim } from "../autoRun/contract.js";
import type { AutoRunExecutorAdapter } from "../autoRun/contract.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";
import { manifestSchema } from "../schema/manifest.js";

function adapter(): AutoRunExecutorAdapter {
  return {
    executeBlock: async (claim) => ({
      kind: claim.blockType === "review" ? "review_result" : "block_report",
      ref: claim.ref,
      artifactPath: `${claim.ref}.md`
    }),
    handleFeedback: async (claim) => ({
      kind: "feedback_report",
      artifactPath: `${claim.content}.md`
    })
  };
}

describe("Auto Run contract", () => {
  it("routes Claim Result branches to an executor adapter without duplicating Task Manager state decisions", async () => {
    await expect(
      consumeAutoRunClaim(
        { kind: "block", ref: "T-001#B-001", taskId: "T-001", blockId: "B-001", blockType: "implementation" },
        adapter()
      )
    ).resolves.toEqual({
      kind: "submit_result",
      ref: "T-001#B-001",
      reportPath: "T-001#B-001.md"
    });
    await expect(
      consumeAutoRunClaim({ kind: "feedback", content: "fix" }, adapter())
    ).resolves.toEqual({
      kind: "submit_feedback",
      reportPath: "fix.md"
    });
    await expect(consumeAutoRunClaim({ kind: "none", reason: "done" }, adapter())).resolves.toEqual({
      kind: "stop",
      reason: "done"
    });
    await expect(consumeAutoRunClaim({ kind: "blocked", ref: "T-001#R-001", reason: "hook failed" }, adapter())).resolves.toEqual({
      kind: "blocked",
      ref: "T-001#R-001",
      reason: "hook failed"
    });
  });

  it("accepts executor profiles and task/block executor inheritance in Plan Package manifests", () => {
    const parsed = manifestSchema.parse({
      version: "plan-package/v1",
      project: {
        title: "Executor profile package",
        description: "Exercises Auto Run executor profile schema."
      },
      execution: {
        defaultExecutor: "codex-auto",
        parallel: {
          enabled: false,
          maxConcurrent: 1
        }
      },
      executors: {
        "codex-auto": {
          adapter: "codex-exec",
          command: "codex",
          args: ["exec", "-"],
          sandbox: "workspace-write"
        },
        manual: {
          adapter: "manual"
        },
        opencode: {
          adapter: "opencode-exec",
          command: "opencode",
          args: ["run", "-"]
        },
        "local-review": {
          adapter: "local-review",
          command: "node",
          args: ["review.js"]
        }
      },
      review: {
        maxFeedbackCycles: 1,
        completionPolicy: "strict"
      },
      nodes: [
        {
          id: "T-001",
          type: "task",
          title: "Executor task",
          prompt: "nodes/T-001/prompt.md",
          executor: "codex-auto",
          acceptance: ["Executor profiles are selectable."],
          blocks: [
            {
              id: "B-001",
              type: "implementation",
              title: "Implementation",
              prompt: "nodes/T-001/blocks/B-001.prompt.md",
              depends_on: [],
              executor: "manual",
              parallel: {
                safe: false,
                locks: []
              }
            }
          ]
        }
      ],
      edges: []
    });

    expect(parsed.execution.defaultExecutor).toBe("codex-auto");
    expect(parsed.executors.manual.adapter).toBe("manual");
    expect(parsed.executors.opencode.adapter).toBe("opencode-exec");
    expect(parsed.executors["local-review"].adapter).toBe("local-review");
    const task = parsed.nodes[0];
    expect(task.type).toBe("task");
    expect(task.executor).toBe("codex-auto");
    expect(task.blocks[0].executor).toBe("manual");
  });

  it("manual adapter claims a block, writes the rendered prompt artifact, and waits for manual submission", async () => {
    const { root, init } = await createTestWorkspace();
    const step = await runAutoRunStep({
      projectRoot: root,
      executor: createManualExecutorAdapter({
        projectRoot: root,
        executorName: "manual"
      })
    });

    expect(step).toMatchObject({
      kind: "manual",
      claim: { kind: "block", ref: "T-001#B-001" },
      adapterResult: { kind: "manual", executor: "manual" }
    });
    if (step.kind !== "manual") {
      throw new Error("expected manual step");
    }
    await expect(access(step.adapterResult.promptPath)).resolves.toBeUndefined();
    await expect(readFile(step.adapterResult.promptPath, "utf8")).resolves.toContain("# T-001#B-001: Implement task");
    await expect(readJsonFile(join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001", "metadata.json"))).resolves.toMatchObject({
      runId: "RUN-001",
      ref: "T-001#B-001",
      executor: "manual",
      adapter: "manual",
      exitCode: null
    });
  });

  it("codex-exec adapter runs the configured command and submits the generated block report", async () => {
    const manifest = basicManifest() as any;
    manifest.executors = {
      "fake-codex": {
        adapter: "codex-exec",
        command: process.execPath,
        args: [
          "-e",
          [
            "const fs = require('node:fs');",
            "const path = require('node:path');",
            "let input='';",
            "process.stdin.on('data', c => input += c);",
            "process.stdin.on('end', () => {",
            "  fs.writeFileSync(path.join(process.cwd(), 'executor-cwd.txt'), process.cwd());",
            "  console.error('memory says thread_id=019e4ab3-ddfe-7c20-a2e0-86919e1a62ab but this is not a Codex resume session');",
            "  console.error('│  Session:                     019e52a6-030c-71c1-9146-712651be1d65                      │');",
            "  console.log('report:' + input.includes('Implement task'));",
            "});"
          ].join("")
        ]
      }
    };
    manifest.execution.defaultExecutor = "fake-codex";
    const { root, init } = await createTestWorkspace(manifest);

    const step = await runAutoRunStep({
      projectRoot: root,
      executor: createCodexExecAdapter({
        projectRoot: root,
        executorName: "fake-codex"
      })
    });

    expect(step).toMatchObject({
      kind: "submitted",
      claim: { kind: "block", ref: "T-001#B-001" },
      adapterResult: { kind: "block", reportPath: expect.stringContaining("report.md") },
      submitResult: { ref: "T-001#B-001", runId: "RUN-001", status: "completed" }
    });
    await expect(readFile(join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001", "stdout.md"), "utf8")).resolves.toContain("report:true");
    await expect(readFile(join(root, "executor-cwd.txt"), "utf8")).resolves.toBe(init.workspace.rootPath);
    await expect(readJsonFile(join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001", "metadata.json"))).resolves.toMatchObject({
      executor: "fake-codex",
      adapter: "codex-exec",
      projectRoot: init.workspace.rootPath,
      executionCwd: init.workspace.rootPath,
      codexSessionId: "019e52a6-030c-71c1-9146-712651be1d65",
      agentSessionId: "019e52a6-030c-71c1-9146-712651be1d65",
      exitCode: 0
    });
  });

  it("opencode-exec adapter records OpenCode runs without Codex resume/session handling", async () => {
    const manifest = basicManifest() as any;
    manifest.executors = {
      "fake-opencode": {
        adapter: "opencode-exec",
        command: process.execPath,
        args: [
          "-e",
          [
            "let input='';",
            "process.stdin.on('data', c => input += c);",
            "process.stdin.on('end', () => {",
            "  console.error('  Session   New session - 2026-05-23T01:49:25.978Z');",
            "  console.error('  Continue  opencode -s ses_1ad7a1fa5ffeDAcFVbSB6Z2z9j');",
            "  console.log('opencode report:' + input.includes('Implement task'));",
            "});"
          ].join("")
        ]
      }
    };
    manifest.execution.defaultExecutor = "fake-opencode";
    const { root, init } = await createTestWorkspace(manifest);

    const step = await runAutoRunStep({
      projectRoot: root,
      executor: createOpencodeExecAdapter({
        projectRoot: root,
        executorName: "fake-opencode"
      })
    });

    expect(step).toMatchObject({
      kind: "submitted",
      claim: { kind: "block", ref: "T-001#B-001" },
      adapterResult: { kind: "block", adapter: "opencode-exec", agentSessionId: "ses_1ad7a1fa5ffeDAcFVbSB6Z2z9j" },
      submitResult: { ref: "T-001#B-001", runId: "RUN-001", status: "completed" }
    });
    await expect(readJsonFile(join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001", "metadata.json"))).resolves.toMatchObject({
      executor: "fake-opencode",
      adapter: "opencode-exec",
      projectRoot: init.workspace.rootPath,
      executionCwd: init.workspace.rootPath,
      agentSessionId: "ses_1ad7a1fa5ffeDAcFVbSB6Z2z9j",
      opencodeSessionId: "ses_1ad7a1fa5ffeDAcFVbSB6Z2z9j",
      resumed: false,
      exitCode: 0
    });
  });

  it("blocks the current block when the configured executor exits unsuccessfully", async () => {
    const manifest = basicManifest() as any;
    manifest.executors = {
      "failing-codex": {
        adapter: "codex-exec",
        command: process.execPath,
        args: ["-e", "process.stdin.resume(); console.error('codex failed'); process.exit(7);"]
      }
    };
    manifest.execution.defaultExecutor = "failing-codex";
    const { root, init } = await createTestWorkspace(manifest);

    const step = await runAutoRunStep({
      projectRoot: root,
      executor: createCodexExecAdapter({
        projectRoot: root,
        executorName: "failing-codex"
      })
    });

    expect(step).toMatchObject({
      kind: "blocked",
      claim: {
        kind: "blocked",
        ref: "T-001#B-001",
        reason: expect.stringContaining("codex failed")
      }
    });
    await expect(readJsonFile(join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001", "metadata.json"))).resolves.toMatchObject({
      executor: "failing-codex",
      adapter: "codex-exec",
      exitCode: 7
    });
    await expect(readFile(join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001", "stderr.log"), "utf8")).resolves.toContain(
      "codex failed"
    );
    await expect(getExecutionStatus({ projectRoot: root })).resolves.toMatchObject({
      blocks: expect.arrayContaining([
        expect.objectContaining({
          ref: "T-001#B-001",
          status: "blocked",
          reason: expect.stringContaining("codex failed")
        })
      ])
    });
    await expect(getAutoRunStatus({ projectRoot: root })).resolves.toMatchObject({
      latestRuns: [
        expect.objectContaining({
          ref: "T-001#B-001",
          status: "blocked",
          stderrSummary: expect.stringContaining("codex failed"),
          failureReason: expect.stringContaining("codex failed")
        })
      ]
    });
  });

  it("times out a codex-exec block run and exposes the blocked failure reason", async () => {
    const manifest = basicManifest() as any;
    manifest.executors = {
      "slow-codex": {
        adapter: "codex-exec",
        command: process.execPath,
        args: ["-e", "setTimeout(() => console.log('late report'), 1000);"],
        timeoutMs: 25
      }
    };
    manifest.execution.defaultExecutor = "slow-codex";
    const { root, init } = await createTestWorkspace(manifest);

    const step = await runAutoRunStep({
      projectRoot: root,
      executor: createCodexExecAdapter({
        projectRoot: root,
        executorName: "slow-codex"
      })
    });

    expect(step).toMatchObject({
      kind: "blocked",
      claim: {
        kind: "blocked",
        ref: "T-001#B-001",
        reason: expect.stringContaining("timed out")
      }
    });
    await expect(readJsonFile(join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001", "metadata.json"))).resolves.toMatchObject({
      executor: "slow-codex",
      adapter: "codex-exec",
      exitCode: 124,
      timeoutMs: 25,
      timedOut: true
    });
    await expect(getAutoRunStatus({ projectRoot: root })).resolves.toMatchObject({
      latestRuns: [
        expect.objectContaining({
          ref: "T-001#B-001",
          status: "blocked",
          failureReason: expect.stringContaining("timed out")
        })
      ]
    });
  });

  it("passes executor profile sandbox to codex-exec command arguments", async () => {
    const manifest = basicManifest() as any;
    manifest.executors = {
      "fake-codex": {
        adapter: "codex-exec",
        command: process.execPath,
        args: ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", "--"],
        sandbox: "workspace-write"
      }
    };
    manifest.execution.defaultExecutor = "fake-codex";
    const { root } = await createTestWorkspace(manifest);

    const step = await runAutoRunStep({
      projectRoot: root,
      executor: createCodexExecAdapter({
        projectRoot: root,
        executorName: "fake-codex"
      })
    });

    expect(step).toMatchObject({
      kind: "submitted",
      adapterResult: {
        kind: "block",
        stdout: expect.stringContaining("--sandbox")
      }
    });
    expect(step.kind === "submitted" && step.adapterResult.kind === "block" ? step.adapterResult.stdout : "").toContain("workspace-write");
  });

  it("resumes a failed codex-exec block run when a session id is available", async () => {
    const { root, init } = await createTestWorkspace();
    const fakeCodex = join(root, "fake-codex.mjs");
    await writeFile(
      fakeCodex,
      [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        "if (args.includes('resume')) {",
        "  console.log('resumed report from ' + args[args.indexOf('resume') + 1]);",
        "  process.exit(0);",
        "}",
        "console.log(JSON.stringify({ type: 'session.updated', session: { id: 'SESSION-123' } }));",
        "console.error('first attempt failed');",
        "process.exit(1);"
      ].join("\n"),
      "utf8"
    );
    await chmod(fakeCodex, 0o755);
    const manifest = basicManifest() as any;
    manifest.executors = {
      "fake-codex": {
        adapter: "codex-exec",
        command: fakeCodex,
        args: ["exec", "-"]
      }
    };
    manifest.execution.defaultExecutor = "fake-codex";
    await writeFile(init.workspace.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const step = await runAutoRunStep({
      projectRoot: root,
      executor: createCodexExecAdapter({
        projectRoot: root,
        executorName: "fake-codex"
      })
    });

    expect(step).toMatchObject({
      kind: "submitted",
      adapterResult: {
        kind: "block",
        stdout: expect.stringContaining("resumed report from SESSION-123")
      },
      submitResult: {
        ref: "T-001#B-001",
        status: "completed"
      }
    });
    const metadata = await readJsonFile<Record<string, unknown>>(
      join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001", "metadata.json")
    );
    expect(metadata.codexSessionId).toBe("SESSION-123");
    expect(metadata.agentSessionId).toBe("SESSION-123");
    expect(metadata.resumed).toBe(true);
    await expect(readFile(join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001", "stderr.log"), "utf8")).resolves.toContain(
      "first attempt failed"
    );
  });

  it("codex-exec adapter stores review stdout as review-result.json for submit-review", async () => {
    const reviewJson = JSON.stringify({
      reviewBlockRef: "T-001#R-001",
      taskId: "T-001",
      verdict: "passed",
      content: "passed by fake codex"
    });
    const manifest = basicManifest() as any;
    manifest.executors = {
      "fake-reviewer": {
        adapter: "codex-exec",
        command: process.execPath,
        args: ["-e", `console.log(${JSON.stringify(reviewJson)})`]
      }
    };
    manifest.execution.defaultExecutor = "fake-reviewer";
    const { root, init } = await createTestWorkspace(manifest);
    await runAutoRunStep({
      projectRoot: root,
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
    await runAutoRunStep({
      projectRoot: root,
      executor: {
        async runBlock() {
          const reportPath = join(root, "check.md");
          await writeFile(reportPath, "checked\n", "utf8");
          return { kind: "block", reportPath };
        },
        async runFeedback() {
          throw new Error("feedback should not run");
        }
      }
    });

    const step = await runAutoRunStep({
      projectRoot: root,
      executor: createCodexExecAdapter({
        projectRoot: root,
        executorName: "fake-reviewer"
      })
    });

    expect(step).toMatchObject({
      kind: "submitted",
      claim: { kind: "block", ref: "T-001#R-001", blockType: "review" },
      adapterResult: { kind: "review", resultPath: expect.stringContaining("review-result.json") },
      submitResult: { ref: "T-001#R-001", verdict: "passed", status: "completed" }
    });
    await expect(readJsonFile(join(init.workspace.resultsDir, "T-001", "blocks", "R-001", "runs", "RUN-001", "review-result.json"))).resolves.toMatchObject({
      verdict: "passed"
    });
  });

  it("local-review adapter submits review JSON without creating an agent session", async () => {
    const manifest = basicManifest() as any;
    manifest.executors = {
      "fake-local-review": {
        adapter: "local-review",
        command: process.execPath,
        args: [
          "-e",
          [
            "const result = {",
            "  reviewBlockRef: process.env.PLANWEAVE_REVIEW_BLOCK_REF,",
            "  taskId: process.env.PLANWEAVE_TASK_ID,",
            "  verdict: process.env.PLANWEAVE_BLOCK_ID === 'R-001' ? 'passed' : 'needs_changes',",
            "  content: 'passed by local review'",
            "};",
            "console.log(JSON.stringify(result));"
          ].join("")
        ]
      }
    };
    manifest.execution.defaultExecutor = "fake-local-review";
    const { root, init } = await createTestWorkspace(manifest);
    await runAutoRunStep({
      projectRoot: root,
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
    await runAutoRunStep({
      projectRoot: root,
      executor: {
        async runBlock() {
          const reportPath = join(root, "check.md");
          await writeFile(reportPath, "checked\n", "utf8");
          return { kind: "block", reportPath };
        },
        async runFeedback() {
          throw new Error("feedback should not run");
        }
      }
    });

    const step = await runAutoRunStep({
      projectRoot: root,
      executor: createLocalReviewAdapter({
        projectRoot: root,
        executorName: "fake-local-review"
      })
    });

    expect(step).toMatchObject({
      kind: "submitted",
      claim: { kind: "block", ref: "T-001#R-001", blockType: "review" },
      adapterResult: { kind: "review", adapter: "local-review", agentSessionId: null },
      submitResult: { ref: "T-001#R-001", verdict: "passed", status: "completed" }
    });
    await expect(readJsonFile(join(init.workspace.resultsDir, "T-001", "blocks", "R-001", "runs", "RUN-001", "metadata.json"))).resolves.toMatchObject({
      executor: "fake-local-review",
      adapter: "local-review",
      agentSessionId: null,
      codexSessionId: null,
      exitCode: 0
    });
  });

  it("lists built-in and package-defined executor profiles", async () => {
    const manifest = basicManifest() as any;
    manifest.executors = {
      "project-codex": {
        adapter: "codex-exec",
        command: "codex",
        args: ["exec", "-"]
      }
    };
    const { root } = await createTestWorkspace(manifest);

    await expect(listExecutorProfiles({ projectRoot: root })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "manual", adapter: "manual", source: "builtin" }),
        expect.objectContaining({ name: "codex-auto", adapter: "codex-exec", source: "builtin" }),
        expect.objectContaining({ name: "project-codex", adapter: "codex-exec", source: "package" })
      ])
    );
  });

  it("dispatches and submits every block in a parallel batch", async () => {
    const { root } = await createTestWorkspace(basicManifest({ parallel: true, maxConcurrent: 2, includeSecondTask: true }));
    const step = await runAutoRunStep({
      projectRoot: root,
      parallel: true,
      executor: {
        async runBlock({ claim }) {
          const reportPath = join(root, `${claim.taskId}-${claim.blockId}.md`);
          await writeFile(reportPath, `${claim.ref} completed\n`, "utf8");
          return { kind: "block", reportPath };
        },
        async runFeedback() {
          throw new Error("feedback should not run in a parallel batch");
        }
      }
    });

    expect(step).toMatchObject({
      kind: "batch_submitted",
      claim: { kind: "batch", refs: ["T-001#B-001", "T-002#B-001"] },
      steps: [
        { kind: "submitted", submitResult: { ref: "T-001#B-001", status: "completed" } },
        { kind: "submitted", submitResult: { ref: "T-002#B-001", status: "completed" } }
      ]
    });
    const status = await getExecutionStatus({ projectRoot: root });
    expect(status.blocks.find((block) => block.ref === "T-001#B-001")?.status).toBe("completed");
    expect(status.blocks.find((block) => block.ref === "T-002#B-001")?.status).toBe("completed");
  });

  it("falls back to sequential claims for reviews when parallel batches are exhausted", async () => {
    const { root } = await createTestWorkspace(basicManifest({ parallel: true, maxConcurrent: 2, includeSecondTask: true }));
    const executor = {
      async runBlock({ claim }) {
        if (claim.blockType === "review") {
          const resultPath = join(root, `${claim.taskId}-${claim.blockId}.json`);
          await writeFile(resultPath, JSON.stringify({ reviewBlockRef: claim.ref, taskId: claim.taskId, verdict: "passed", content: "ok" }), "utf8");
          return { kind: "review" as const, resultPath };
        }
        const reportPath = join(root, `${claim.taskId}-${claim.blockId}.md`);
        await writeFile(reportPath, `${claim.ref} completed\n`, "utf8");
        return { kind: "block" as const, reportPath };
      },
      async runFeedback() {
        throw new Error("feedback should not run");
      }
    };

    await expect(runAutoRunStep({ projectRoot: root, parallel: true, executor })).resolves.toMatchObject({
      kind: "batch_submitted",
      claim: { refs: ["T-001#B-001", "T-002#B-001"] }
    });
    await expect(runAutoRunStep({ projectRoot: root, parallel: true, executor })).resolves.toMatchObject({
      kind: "batch_submitted",
      claim: { refs: ["T-001#C-001"] }
    });
    await expect(runAutoRunStep({ projectRoot: root, parallel: true, executor })).resolves.toMatchObject({
      kind: "submitted",
      claim: { kind: "block", ref: "T-001#R-001", blockType: "review" },
      submitResult: { verdict: "passed", status: "completed" }
    });
  });

  it("reports runner status with executor, stdio summaries, state changes, and failure reason", async () => {
    const manifest = basicManifest() as any;
    manifest.executors = {
      "fake-codex": {
        adapter: "codex-exec",
        command: process.execPath,
        args: [
          "-e",
          "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { console.error('stderr detail'); console.log('stdout report for ' + input.split('\\n')[0]); });"
        ]
      }
    };
    manifest.execution.defaultExecutor = "fake-codex";
    const { root } = await createTestWorkspace(manifest);

    await runAutoRunStep({ projectRoot: root });

    await expect(getAutoRunStatus({ projectRoot: root })).resolves.toMatchObject({
      current: {
        refs: [],
        feedbackId: null,
        reviewBlockRef: null
      },
      latestRuns: [
        {
          ref: "T-001#B-001",
          executor: "fake-codex",
          adapter: "codex-exec",
          status: "completed",
          stdoutSummary: expect.stringContaining("stdout report"),
          stderrSummary: expect.stringContaining("stderr detail"),
          failureReason: null
        }
      ]
    });
  });
});
