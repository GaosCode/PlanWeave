import { chmod, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getAutoRunStatus,
  getExecutionStatus,
  initManagedWorkspace,
  linkProjectSourceRoot,
  trustCommand
} from "../index.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { createTestWorkspace, writePromptFiles } from "./promptTestHelpers.js";
import { manifestTestBuilder } from "./manifestTestBuilder.js";
import { createContractCodexExecAdapter, runContractAutoRunStep } from "./autoRunTestBuilders.js";

describe("Auto Run codex executor", () => {
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

    const step = await runContractAutoRunStep({
      projectRoot: root,
      executor: createContractCodexExecAdapter({
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
    await expect(
      readFile(
        join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001", "stdout.md"),
        "utf8"
      )
    ).resolves.toContain("report:true");
    await expect(readFile(join(root, "executor-cwd.txt"), "utf8")).resolves.toBe(
      init.workspace.rootPath
    );
    await expect(
      readJsonFile(
        join(
          init.workspace.resultsDir,
          "T-001",
          "blocks",
          "B-001",
          "runs",
          "RUN-001",
          "metadata.json"
        )
      )
    ).resolves.toMatchObject({
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
    const fakeCodexArgs = [
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
    ];
    const manifest = manifestTestBuilder()
      .withExecutor("fake-codex", {
        adapter: "codex-exec",
        command: process.execPath,
        args: fakeCodexArgs
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
    await trustCommand(init.workspace.rootPath, process.execPath, fakeCodexArgs);

    const step = await runContractAutoRunStep({
      projectRoot: init.workspace.rootPath,
      executor: createContractCodexExecAdapter({
        projectRoot: init.workspace.rootPath,
        executorName: "fake-codex"
      })
    });

    expect(step).toMatchObject({
      kind: "submitted",
      claim: { kind: "block", ref: "T-001#B-001" },
      submitResult: { ref: "T-001#B-001", runId: "RUN-001", status: "completed" }
    });
    await expect(readFile(join(sourceRoot, "executor-cwd.txt"), "utf8")).resolves.toBe(
      resolvedSourceRoot
    );
    await expect(
      readJsonFile(
        join(
          init.workspace.resultsDir,
          "T-001",
          "blocks",
          "B-001",
          "runs",
          "RUN-001",
          "metadata.json"
        )
      )
    ).resolves.toMatchObject({
      projectRoot: resolvedWorkspaceRoot,
      executionCwd: resolvedSourceRoot
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

    const step = await runContractAutoRunStep({
      projectRoot: root,
      executor: createContractCodexExecAdapter({
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
    await expect(
      readJsonFile(
        join(
          init.workspace.resultsDir,
          "T-001",
          "blocks",
          "B-001",
          "runs",
          "RUN-001",
          "metadata.json"
        )
      )
    ).resolves.toMatchObject({
      executor: "failing-codex",
      adapter: "codex-exec",
      exitCode: 7
    });
    await expect(
      readFile(
        join(
          init.workspace.resultsDir,
          "T-001",
          "blocks",
          "B-001",
          "runs",
          "RUN-001",
          "stderr.log"
        ),
        "utf8"
      )
    ).resolves.toContain("codex failed");
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

    const step = await runContractAutoRunStep({
      projectRoot: root,
      executor: createContractCodexExecAdapter({
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
    await expect(
      readJsonFile(
        join(
          init.workspace.resultsDir,
          "T-001",
          "blocks",
          "B-001",
          "runs",
          "RUN-001",
          "metadata.json"
        )
      )
    ).resolves.toMatchObject({
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
    const fakeCodexArgs = ["exec", "-"];
    const manifest = manifestTestBuilder()
      .withExecutor("fake-codex", {
        adapter: "codex-exec",
        command: fakeCodex,
        args: fakeCodexArgs
      })
      .withDefaultExecutor("fake-codex")
      .build();
    await writeFile(init.workspace.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await trustCommand(root, fakeCodex, fakeCodexArgs);

    const step = await runContractAutoRunStep({
      projectRoot: root,
      executor: createContractCodexExecAdapter({
        projectRoot: root,
        executorName: "fake-codex",
        runtime: { tmuxEnabled: false }
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
    expect(metadata.codexSessionId).toBe("SESSION-123");
    expect(metadata.agentSessionId).toBe("SESSION-123");
    expect(metadata.resumed).toBe(true);
    await expect(
      readFile(
        join(
          init.workspace.resultsDir,
          "T-001",
          "blocks",
          "B-001",
          "runs",
          "RUN-001",
          "stderr.log"
        ),
        "utf8"
      )
    ).resolves.toContain("first attempt failed");
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
    await runContractAutoRunStep({
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
    const step = await runContractAutoRunStep({
      projectRoot: root,
      executor: createContractCodexExecAdapter({
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
      verdict: "passed"
    });
  });
});
