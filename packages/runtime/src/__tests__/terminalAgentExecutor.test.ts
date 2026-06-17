import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeCodeExecAdapter, createPiExecAdapter, runAutoRunStep } from "../index.js";
import { readJsonFile } from "../json.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

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

describe("terminal agent executors", () => {
  it.each(terminalAgents)("runs $adapter in the project directory and submits stdout as the block report", async ({ name, adapter, createAdapter }) => {
    const manifest = basicManifest() as any;
    manifest.executors = {
      [name]: {
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
      }
    };
    manifest.execution.defaultExecutor = name;
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
    await expect(readFile(join(root, `${name}-cwd.txt`), "utf8")).resolves.toBe(init.workspace.rootPath);
    await expect(readFile(join(root, `${name}-planweave-home.txt`), "utf8")).resolves.toBe(init.workspace.planweaveHome);
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
    const manifest = basicManifest() as any;
    manifest.executors = {
      "fake-claude-review": {
        adapter: "claude-code-exec",
        command: "./claude",
        args: ["-p"]
      }
    };
    manifest.execution.defaultExecutor = "fake-claude-review";
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
      adapterResult: { kind: "review", adapter: "claude-code-exec", resultPath: expect.stringContaining("review-result.json") },
      submitResult: { ref: "T-001#R-001", verdict: "passed", status: "completed" }
    });
    await expect(readFile(join(root, "claude-review-prompt.md"), "utf8")).resolves.toContain("Auto Run Review Result File");
    await expect(readJsonFile(join(init.workspace.resultsDir, "T-001", "blocks", "R-001", "runs", "RUN-001", "review-result.json"))).resolves.toMatchObject({
      verdict: "passed",
      content: "review file passed"
    });
  });
});
