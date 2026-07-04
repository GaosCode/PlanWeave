import { access, chmod, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createCodexExecAdapter,
  createManualExecutorAdapter,
  createLocalReviewAdapter,
  createOpencodeExecAdapter,
  getAutoRunStatus,
  getExecutionStatus,
  initManagedWorkspace,
  linkProjectSourceRoot,
  listExecutorProfiles,
  resolveTaskCanvasWorkspace,
  runAutoRunStep,
  submitBlockResult,
  submitReviewResult
} from "../index.js";
import { createAutoRunExplanation } from "../taskManager/autoRun.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { canonicalProjectCanvasNode, writeProjectGraph } from "../projectGraph/index.js";
import { consumeAutoRunClaim } from "../autoRun/contract.js";
import type { AutoRunExecutorAdapter } from "../autoRun/contract.js";
import { basicManifest, createTestWorkspace, writePromptFiles, writeReport, writeReviewResult } from "./promptTestHelpers.js";
import { manifestSchema } from "../schema/manifest.js";
import { manifestTestBuilder } from "./manifestTestBuilder.js";

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

async function createFormalManualCanvasWorkspace() {
  const { root, init } = await createTestWorkspace();
  const packageDir = join(init.workspace.workspaceRoot, "manual-canvas", "package");
  const manifest = basicManifest();
  await writeJsonFile(join(packageDir, "manifest.json"), manifest);
  await writePromptFiles(packageDir, manifest);
  await writeProjectGraph(init.workspace, {
    version: "plan-project/v1",
    canvases: [
      canonicalProjectCanvasNode({ id: "default", title: "Runtime" }),
      {
        id: "manual-canvas",
        type: "canvas",
        title: "Manual Canvas",
        packageDir: "manual-canvas/package",
        stateFile: "manual-canvas/state.json",
        resultsDir: "manual-canvas/results"
      }
    ],
    edges: [],
    crossTaskEdges: []
  });
  return { root, workspace: await resolveTaskCanvasWorkspace(root, "manual-canvas") };
}

describe("Auto Run contract", () => {
  it("derives a block ref for failed nextAction from the latest record id when current ref is absent", () => {
    const explanation = createAutoRunExplanation({
      phase: "failed",
      currentRef: null,
      currentExecutor: "fake-codex",
      latestRecordId: "T-001#B-001::RUN-001",
      latestRecordPath: "/tmp/metadata.json",
      latestOutputSummary: "executor failed",
      error: "executor failed"
    });

    expect(explanation.nextAction).toMatchObject({
      kind: "inspect_record",
      ref: "T-001#B-001",
      targetPath: "/tmp/metadata.json"
    });
  });

  it("routes Claim Result branches to an executor adapter without duplicating Task Manager state decisions", async () => {
    await expect(
      consumeAutoRunClaim(
        { kind: "block", ref: "T-001#B-001", taskId: "T-001", blockId: "B-001", blockType: "implementation", effectiveExecutor: "default" },
        adapter()
      )
    ).resolves.toEqual({
      kind: "submit_result",
      ref: "T-001#B-001",
      reportPath: "T-001#B-001.md"
    });
    await expect(
      consumeAutoRunClaim(
        { kind: "feedback", feedbackId: "FE-001", sourceReviewBlockRef: "T-001#R-001", taskId: "T-001", content: "fix", effectiveExecutor: "default" },
        adapter()
      )
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
        "claude-code": {
          adapter: "claude-code-exec",
          command: "claude",
          args: ["-p"]
        },
        pi: {
          adapter: "pi-exec",
          command: "pi",
          args: ["-p"]
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
    expect(parsed.executors["claude-code"].adapter).toBe("claude-code-exec");
    expect(parsed.executors.pi.adapter).toBe("pi-exec");
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

  it("exposes tmux metadata in Auto Run status latest run summaries", async () => {
    const { root, init } = await createTestWorkspace();
    await runAutoRunStep({
      projectRoot: root,
      executor: createManualExecutorAdapter({
        projectRoot: root,
        executorName: "manual"
      })
    });

    const metadataPath = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001", "metadata.json");
    const metadata = await readJsonFile<Record<string, unknown>>(metadataPath);
    await writeJsonFile(metadataPath, {
      ...metadata,
      tmuxSessionName: "planweave-T-001-B-001-RUN-001-123abcd",
      tmuxAttachCommand: "tmux attach-session -t planweave-T-001-B-001-RUN-001-123abcd",
      tmuxReadOnlyAttachCommand: "tmux attach-session -r -t planweave-T-001-B-001-RUN-001-123abcd"
    });

    await expect(getAutoRunStatus({ projectRoot: root })).resolves.toMatchObject({
      latestRuns: [
        expect.objectContaining({
          ref: "T-001#B-001",
          tmuxSessionName: "planweave-T-001-B-001-RUN-001-123abcd",
          tmuxAttachCommand: "tmux attach-session -t planweave-T-001-B-001-RUN-001-123abcd",
          tmuxReadOnlyAttachCommand: "tmux attach-session -r -t planweave-T-001-B-001-RUN-001-123abcd"
        })
      ]
    });
  });

  it("manual adapter scopes next commands for formal project graph canvases with arbitrary package paths", async () => {
    const { root, workspace } = await createFormalManualCanvasWorkspace();
    const executor = createManualExecutorAdapter({
      projectRoot: workspace,
      executorName: "manual"
    });

    const implementationStep = await runAutoRunStep({
      projectRoot: workspace,
      executor
    });

    expect(implementationStep).toMatchObject({
      kind: "manual",
      adapterResult: {
        nextCommand: "planweave submit-result --canvas manual-canvas T-001#B-001 --report <report.md>"
      }
    });
    await submitBlockResult({ projectRoot: workspace, ref: "T-001#B-001", reportPath: await writeReport(root, "b.md") });
    await runAutoRunStep({
      projectRoot: workspace,
      executor
    });
    await submitReviewResult({
      projectRoot: workspace,
      ref: "T-001#R-001",
      resultPath: await writeReviewResult(root, "needs_changes", "Fix formal canvas work.")
    });

    const feedbackStep = await runAutoRunStep({
      projectRoot: workspace,
      executor
    });

    expect(feedbackStep).toMatchObject({
      kind: "manual",
      adapterResult: {
        nextCommand: "planweave submit-feedback --canvas manual-canvas --report <report.md>"
      }
    });
    await expect(getAutoRunStatus({ projectRoot: workspace })).resolves.toMatchObject({
      current: {
        refs: [],
        feedbackId: "FE-001",
        reviewBlockRef: "T-001#R-001"
      },
      explanation: {
        phase: "manual",
        currentRef: "FE-001",
        currentExecutor: "manual",
        latestRecordId: "FE-001::RUN-001",
        latestRecordPath: expect.stringContaining(join("feedback-runs", "RUN-001", "metadata.json")),
        latestOutputSummary: "planweave submit-feedback --canvas manual-canvas --report <report.md>",
        nextAction: {
          kind: "submit_manual_result",
          command: "planweave submit-feedback --canvas manual-canvas --report <report.md>",
          ref: "FE-001"
        }
      },
      latestRuns: expect.arrayContaining([
        expect.objectContaining({
          kind: "feedback",
          ref: "FE-001",
          feedbackId: "FE-001",
          sourceReviewBlockRef: "T-001#R-001",
          taskId: "T-001",
          runId: "RUN-001",
          executor: "manual",
          adapter: "manual",
          status: "in_progress",
          promptPath: expect.stringContaining(join("feedback-runs", "RUN-001", "feedback.md")),
          metadataPath: expect.stringContaining(join("feedback-runs", "RUN-001", "metadata.json"))
        })
      ])
    });
  });

  it("codex-exec adapter runs the configured command and submits the generated block report", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("fake-codex", {
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
      })
      .withDefaultExecutor("fake-codex")
      .build();
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

  it("codex-exec adapter runs managed projects in the bound source root", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("fake-codex", {
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
            "  console.log('report:' + input.includes('Implement task'));",
            "});"
          ].join("")
        ]
      })
      .withDefaultExecutor("fake-codex")
      .build();
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const sourceRoot = await mkdtemp(join(tmpdir(), "planweave-source-"));
    const resolvedSourceRoot = await realpath(sourceRoot);
    process.env.PLANWEAVE_HOME = home;
    const init = await initManagedWorkspace({ name: "Managed Auto Run" });
    const resolvedWorkspaceRoot = await realpath(init.workspace.rootPath);
    await linkProjectSourceRoot(init.workspace.id, sourceRoot);
    await writeJsonFile(init.workspace.manifestFile, manifest);
    await writePromptFiles(init.workspace.packageDir, manifest);

    const step = await runAutoRunStep({
      projectRoot: init.workspace.rootPath,
      executor: createCodexExecAdapter({
        projectRoot: init.workspace.rootPath,
        executorName: "fake-codex"
      })
    });

    expect(step).toMatchObject({
      kind: "submitted",
      claim: { kind: "block", ref: "T-001#B-001" },
      submitResult: { ref: "T-001#B-001", runId: "RUN-001", status: "completed" }
    });
    await expect(readFile(join(sourceRoot, "executor-cwd.txt"), "utf8")).resolves.toBe(resolvedSourceRoot);
    await expect(readJsonFile(join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001", "metadata.json"))).resolves.toMatchObject({
      projectRoot: resolvedWorkspaceRoot,
      executionCwd: resolvedSourceRoot
    });
  });

  it("opencode-exec adapter records OpenCode runs without Codex resume/session handling", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("fake-opencode", {
        adapter: "opencode-exec",
        command: process.execPath,
        args: [
          "-e",
          [
            "const fs = require('node:fs');",
            "const input = fs.readFileSync(0, 'utf8');",
            "  console.error('  Session   New session - 2026-05-23T01:49:25.978Z');",
            "  console.error('  Continue  opencode -s ses_1ad7a1fa5ffeDAcFVbSB6Z2z9j');",
            "  console.log('opencode report:' + input.includes('Implement task'));",
          ].join("")
        ]
      })
      .withDefaultExecutor("fake-opencode")
      .build();
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

  it("opencode-exec adapter exposes structured OpenCode stderr failures", async () => {
    const opencodeErrorPayload = JSON.stringify(
      {
        name: "UnknownError",
        data: {
          message: "Unexpected server error. Check server logs for details.",
          ref: "err_1e659774"
        }
      },
      null,
      2
    );
    const manifest = manifestTestBuilder()
      .withExecutor("failing-opencode", {
        adapter: "opencode-exec",
        command: process.execPath,
        args: [
          "-e",
          [
            "process.stdin.resume();",
            `process.stderr.write('\\u001b[91m\\u001b[1mError: \\u001b[0m' + ${JSON.stringify(opencodeErrorPayload + "\n")});`,
            "process.exit(1);"
          ].join("")
        ]
      })
      .withDefaultExecutor("failing-opencode")
      .build();
    const { root, init } = await createTestWorkspace(manifest);
    const expected =
      "Executor 'failing-opencode' failed: OpenCode error UnknownError: Unexpected server error. Check server logs for details. (ref: err_1e659774)";

    const step = await runAutoRunStep({
      projectRoot: root,
      executor: createOpencodeExecAdapter({
        projectRoot: root,
        executorName: "failing-opencode"
      })
    });

    expect(step).toMatchObject({
      kind: "blocked",
      claim: {
        kind: "blocked",
        ref: "T-001#B-001",
        reason: expect.stringContaining(expected)
      }
    });
    await expect(readJsonFile(join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001", "metadata.json"))).resolves.toMatchObject({
      executor: "failing-opencode",
      adapter: "opencode-exec",
      exitCode: 1,
      failureReason: expected
    });
    await expect(getAutoRunStatus({ projectRoot: root })).resolves.toMatchObject({
      explanation: {
        phase: "blocked",
        currentExecutor: "failing-opencode",
        latestOutputSummary: expected,
        error: expected
      },
      latestRuns: [
        expect.objectContaining({
          ref: "T-001#B-001",
          status: "blocked",
          stderrSummary: expect.stringContaining("UnknownError"),
          failureReason: expected
        })
      ]
    });
  });

  it("blocks the current block when the configured executor exits unsuccessfully", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("failing-codex", {
        adapter: "codex-exec",
        command: process.execPath,
        args: ["-e", "process.stdin.resume(); console.error('codex failed'); process.exit(7);"]
      })
      .withDefaultExecutor("failing-codex")
      .build();
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
      explanation: {
        phase: "blocked",
        currentRef: null,
        currentExecutor: "failing-codex",
        latestRecordId: "T-001#B-001::RUN-001",
        latestRecordPath: expect.stringContaining("metadata.json"),
        latestOutputSummary: expect.stringContaining("codex failed"),
        error: expect.stringContaining("codex failed"),
        nextAction: {
          kind: "inspect_record",
          message: "Inspect the latest run record, then resolve the blocker before retrying.",
          targetPath: expect.stringContaining("metadata.json"),
          ref: "T-001#B-001"
        }
      },
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
    const manifest = manifestTestBuilder()
      .withExecutor("slow-codex", {
        adapter: "codex-exec",
        command: process.execPath,
        args: ["-e", "setTimeout(() => console.log('late report'), 1000);"],
        timeoutMs: 25
      })
      .withDefaultExecutor("slow-codex")
      .build();
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
    const manifest = manifestTestBuilder()
      .withExecutor("fake-codex", {
        adapter: "codex-exec",
        command: process.execPath,
        args: ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", "--"],
        sandbox: "workspace-write"
      })
      .withDefaultExecutor("fake-codex")
      .build();
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
    const manifest = manifestTestBuilder()
      .withExecutor("fake-codex", {
        adapter: "codex-exec",
        command: fakeCodex,
        args: ["exec", "-"]
      })
      .withDefaultExecutor("fake-codex")
      .build();
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
    const manifest = manifestTestBuilder()
      .withExecutor("fake-reviewer", {
        adapter: "codex-exec",
        command: process.execPath,
        args: ["-e", `console.log(${JSON.stringify(reviewJson)})`]
      })
      .withDefaultExecutor("fake-reviewer")
      .build();
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
    const manifest = manifestTestBuilder()
      .withExecutor("fake-local-review", {
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
      })
      .withDefaultExecutor("fake-local-review")
      .build();
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
    const manifest = manifestTestBuilder()
      .withExecutor("project-codex", {
        adapter: "codex-exec",
        command: "codex",
        args: ["exec", "-"]
      })
      .build();
    const { root } = await createTestWorkspace(manifest);

    await expect(listExecutorProfiles({ projectRoot: root })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "manual", adapter: "manual", source: "builtin" }),
        expect.objectContaining({ name: "codex", adapter: "codex-exec", source: "builtin" }),
        expect.objectContaining({ name: "codex-auto", adapter: "codex-exec", source: "builtin" }),
        expect.objectContaining({ name: "opencode", adapter: "opencode-exec", source: "builtin" }),
        expect.objectContaining({ name: "claude-code", adapter: "claude-code-exec", source: "builtin" }),
        expect.objectContaining({ name: "claude-code-auto", adapter: "claude-code-exec", source: "builtin" }),
        expect.objectContaining({ name: "pi", adapter: "pi-exec", source: "builtin" }),
        expect.objectContaining({ name: "pi-auto", adapter: "pi-exec", source: "builtin" }),
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
      kind: "submitted",
      claim: { kind: "block", ref: "T-001#R-001", blockType: "review" },
      submitResult: { verdict: "passed", status: "completed" }
    });
  });

  it("reports runner status with executor, stdio summaries, state changes, and failure reason", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("fake-codex", {
        adapter: "codex-exec",
        command: process.execPath,
        args: [
          "-e",
          "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { console.error('stderr detail'); console.log('stdout report for ' + input.split('\\n')[0]); });"
        ]
      })
      .withExecutor("fake-local-review", {
        adapter: "local-review",
        command: process.execPath,
        args: [
          "-e",
          [
            "const result = {",
            "  reviewBlockRef: process.env.PLANWEAVE_REVIEW_BLOCK_REF,",
            "  taskId: process.env.PLANWEAVE_TASK_ID,",
            "  verdict: 'passed',",
            "  content: 'review passed after implementation'",
            "};",
            "console.log(JSON.stringify(result));"
          ].join("")
        ]
      })
      .withDefaultExecutor("fake-codex")
      .withBlock("T-001", "B-001", (block) => ({ ...block, executor: "fake-codex" }))
      .withBlock("T-001", "R-001", (block) => ({ ...block, executor: "fake-local-review" }))
      .build();
    const { root } = await createTestWorkspace(manifest);

    await runAutoRunStep({ projectRoot: root });

    const implementationStatus = await getAutoRunStatus({ projectRoot: root });
    expect(implementationStatus).toMatchObject({
      current: {
        refs: [],
        feedbackId: null,
        reviewBlockRef: null
      },
      explanation: {
        phase: "idle",
        currentRef: null,
        currentExecutor: "fake-codex",
        latestRecordId: "T-001#B-001::RUN-001",
        latestRecordPath: expect.stringContaining("metadata.json"),
        latestOutputSummary: expect.stringContaining("stderr detail"),
        error: null,
        nextAction: {
          kind: "start",
          command: null,
          ref: "T-001#R-001",
          message: "Continue Auto Run; claimable work is ready: T-001#R-001."
        }
      },
      latestRuns: [
        {
          ref: "T-001#B-001",
          executor: "fake-codex",
          adapter: "codex-exec",
          status: "completed",
          startedAt: expect.any(String),
          finishedAt: expect.any(String),
          stdoutSummary: expect.stringContaining("stdout report"),
          stderrSummary: expect.stringContaining("stderr detail"),
          failureReason: null
        }
      ]
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    await runAutoRunStep({ projectRoot: root });

    const reviewStatus = await getAutoRunStatus({ projectRoot: root });
    expect(reviewStatus.latestRuns.map((run) => run.ref)).toEqual(["T-001#B-001", "T-001#R-001"]);
    expect(reviewStatus).toMatchObject({
      explanation: {
        phase: "completed",
        currentRef: null,
        currentExecutor: "fake-local-review",
        latestRecordId: "T-001#R-001::RUN-001",
        latestRecordPath: expect.stringContaining(join("T-001", "blocks", "R-001", "runs", "RUN-001", "metadata.json")),
        latestOutputSummary: expect.stringContaining("reviewBlockRef"),
        error: null,
        nextAction: {
          kind: "review_status",
          message: "Review the final status and latest run record."
        }
      }
    });
  });

  it("keeps the latest explanation record on an automatically submitted feedback run", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("fake-codex", {
        adapter: "codex-exec",
        command: process.execPath,
        args: [
          "-e",
          "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { console.log('feedback report for ' + input.split('\\n')[0]); });"
        ]
      })
      .withExecutor("needs-review", {
        adapter: "local-review",
        command: process.execPath,
        args: [
          "-e",
          [
            "const result = {",
            "  reviewBlockRef: process.env.PLANWEAVE_REVIEW_BLOCK_REF,",
            "  taskId: process.env.PLANWEAVE_TASK_ID,",
            "  verdict: 'needs_changes',",
            "  content: 'fix the implementation'",
            "};",
            "console.log(JSON.stringify(result));"
          ].join("")
        ]
      })
      .withDefaultExecutor("fake-codex")
      .withBlock("T-001", "B-001", (block) => ({ ...block, executor: "fake-codex" }))
      .withBlock("T-001", "R-001", (block) => ({ ...block, executor: "needs-review" }))
      .build();
    const { root } = await createTestWorkspace(manifest);

    await runAutoRunStep({ projectRoot: root });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await runAutoRunStep({ projectRoot: root });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await runAutoRunStep({ projectRoot: root });

    const status = await getAutoRunStatus({ projectRoot: root });
    expect(status.latestRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "feedback",
          ref: "FE-001",
          feedbackId: "FE-001",
          sourceReviewBlockRef: "T-001#R-001",
          status: "resolved",
          metadataPath: expect.stringContaining(join("feedback-runs", "RUN-001", "metadata.json"))
        })
      ])
    );
    expect(status).toMatchObject({
      current: {
        refs: ["T-001#R-001"],
        feedbackId: null,
        reviewBlockRef: "T-001#R-001"
      },
      explanation: {
        phase: "idle",
        currentRef: "T-001#R-001",
        currentExecutor: "fake-codex",
        latestRecordId: "FE-001::RUN-001",
        latestRecordPath: expect.stringContaining(join("feedback-runs", "RUN-001", "metadata.json")),
        latestOutputSummary: expect.stringContaining("feedback report"),
        nextAction: {
          kind: "start",
          ref: "T-001#R-001"
        }
      }
    });
    expect(status.explanation.nextAction.kind).not.toBe("wait");
  });
});
