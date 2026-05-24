import { setTimeout as delay } from "node:timers/promises";
import { access, chmod, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createOpencodeExecAdapter, getExecutionStatus, runAutoRunStep } from "../index.js";
import { readJsonFile } from "../json.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitForMetadataSession(metadataPath: string, expectedSessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await pathExists(metadataPath)) {
      const metadata = await readJsonFile(metadataPath);
      if ((metadata as { agentSessionId?: string }).agentSessionId === expectedSessionId) {
        return;
      }
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for metadata session ${expectedSessionId}`);
}

describe("OpenCode executor", () => {
  it("parses OpenCode JSON events into a session id and run report", async () => {
    const manifest = basicManifest() as any;
    manifest.executors = {
      "fake-opencode-json": {
        adapter: "opencode-exec",
        command: "./opencode",
        args: ["run", "--format", "json", "--dangerously-skip-permissions", "-"]
      }
    };
    manifest.execution.defaultExecutor = "fake-opencode-json";
    const { root, init } = await createTestWorkspace(manifest);
    await writeFile(
      join(root, "opencode"),
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const argv = process.argv.slice(2);",
        "fs.writeFileSync('opencode-argv.json', JSON.stringify(argv));",
        "const prompt = argv.at(-1) || '';",
        "console.log(JSON.stringify({ type: 'step_start', sessionID: 'ses_json_123' }));",
        "setTimeout(() => {",
        "  console.log(JSON.stringify({ type: 'tool_use', sessionID: 'ses_json_123', part: { type: 'tool', tool: 'write', title: 'demo.md', state: { status: 'completed', output: 'Wrote file successfully.' } } }));",
        "  console.log(JSON.stringify({ type: 'text', sessionID: 'ses_json_123', part: { type: 'text', text: 'json report:' + prompt.includes('Implement task') } }));",
        "}, 500);"
      ].join("\n"),
      "utf8"
    );
    await chmod(join(root, "opencode"), 0o755);

    let stepSettled = false;
    const stepPromise = runAutoRunStep({
      projectRoot: root,
      executor: createOpencodeExecAdapter({
        projectRoot: root,
        executorName: "fake-opencode-json"
      })
    }).finally(() => {
      stepSettled = true;
    });

    const runDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001");
    let step: Awaited<typeof stepPromise>;
    try {
      await waitForMetadataSession(join(runDir, "metadata.json"), "ses_json_123");
      expect(stepSettled).toBe(false);
      step = await stepPromise;
    } catch (error) {
      await stepPromise.catch(() => undefined);
      throw error;
    }
    const expectedRoot = await realpath(root);
    expect(step).toMatchObject({
      kind: "submitted",
      claim: { kind: "block", ref: "T-001#B-001" },
      adapterResult: { kind: "block", adapter: "opencode-exec", agentSessionId: "ses_json_123" }
    });
    await expect(readJsonFile(join(root, "opencode-argv.json"))).resolves.toEqual([
      "run",
      "--dir",
      expectedRoot,
      "--format",
      "json",
      "--dangerously-skip-permissions",
      expect.stringContaining("Implement task")
    ]);
    await expect(readFile(join(runDir, "events.ndjson"), "utf8")).resolves.toContain('"sessionID":"ses_json_123"');
    await expect(readFile(join(runDir, "report.md"), "utf8")).resolves.toBe("json report:true");
    await expect(readJsonFile(join(runDir, "metadata.json"))).resolves.toMatchObject({
      agentSessionId: "ses_json_123",
      opencodeSessionId: "ses_json_123"
    });
  });

  it("keeps direct OpenCode runs readable and reads review JSON from the result file", async () => {
    const manifest = basicManifest() as any;
    manifest.executors = {
      "fake-opencode-review": {
        adapter: "opencode-exec",
        command: "./opencode",
        args: ["run", "--dangerously-skip-permissions", "-"]
      }
    };
    manifest.execution.defaultExecutor = "fake-opencode-review";
    const { root, init } = await createTestWorkspace(manifest);
    await writeFile(
      join(root, "opencode"),
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const argv = process.argv.slice(2);",
        "fs.writeFileSync('opencode-review-argv.json', JSON.stringify(argv));",
        "fs.writeFileSync(process.env.PLANWEAVE_REVIEW_RESULT_PATH, JSON.stringify({",
        "  reviewBlockRef: process.env.PLANWEAVE_REVIEW_BLOCK_REF,",
        "  taskId: process.env.PLANWEAVE_TASK_ID,",
        "  verdict: 'passed',",
        "  content: 'review file passed'",
        "}));",
        "console.log('所有验收标准均已满足。');"
      ].join("\n"),
      "utf8"
    );
    await chmod(join(root, "opencode"), 0o755);

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
      executor: createOpencodeExecAdapter({
        projectRoot: root,
        executorName: "fake-opencode-review"
      })
    });

    expect(step).toMatchObject({
      kind: "submitted",
      claim: { kind: "block", ref: "T-001#R-001", blockType: "review" },
      adapterResult: { kind: "review", resultPath: expect.stringContaining("review-result.json") },
      submitResult: { ref: "T-001#R-001", verdict: "passed", status: "completed" }
    });
    const expectedRoot = await realpath(root);
    await expect(readJsonFile(join(root, "opencode-review-argv.json"))).resolves.toEqual([
      "run",
      "--dir",
      expectedRoot,
      "--dangerously-skip-permissions",
      expect.stringContaining("Auto Run Review Result File")
    ]);
    await expect(readFile(join(init.workspace.resultsDir, "T-001", "blocks", "R-001", "runs", "RUN-001", "stdout.md"), "utf8")).resolves.toContain(
      "所有验收标准均已满足"
    );
    await expect(readJsonFile(join(init.workspace.resultsDir, "T-001", "blocks", "R-001", "runs", "RUN-001", "review-result.json"))).resolves.toMatchObject({
      verdict: "passed",
      content: "review file passed"
    });
  });

  it("treats OpenCode JSON error events as executor failures", async () => {
    const manifest = basicManifest() as any;
    manifest.execution.defaultExecutor = "fake-opencode-error";
    manifest.executors = {
      "fake-block": {
        adapter: "codex-exec",
        command: process.execPath,
        args: [
          "-e",
          "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => console.log('ok:' + input.includes('task')));"
        ]
      },
      "needs-review": {
        adapter: "local-review",
        command: process.execPath,
        args: [
          "-e",
          "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => console.log(JSON.stringify({ reviewBlockRef: 'T-001#R-001', taskId: 'T-001', verdict: 'needs_changes', content: 'fix it' })));"
        ]
      },
      "fake-opencode-error": {
        adapter: "opencode-exec",
        command: "./opencode",
        args: ["run", "--dangerously-skip-permissions", "-"]
      }
    };
    const task = manifest.nodes.find((node: any) => node.id === "T-001");
    for (const block of task.blocks) {
      block.executor = block.type === "review" ? "needs-review" : "fake-block";
    }
    const { root } = await createTestWorkspace(manifest);
    await writeFile(
      join(root, "opencode"),
      [
        "#!/usr/bin/env node",
        "console.log(JSON.stringify({ type: 'step_start', sessionID: 'ses_error_123' }));",
        "console.log(JSON.stringify({ type: 'error', sessionID: 'ses_error_123', error: { name: 'UnknownError', data: { message: 'unknown certificate verification error' } } }));"
      ].join("\n"),
      "utf8"
    );
    await chmod(join(root, "opencode"), 0o755);

    await runAutoRunStep({ projectRoot: root });
    await runAutoRunStep({ projectRoot: root });
    await runAutoRunStep({ projectRoot: root });
    const feedbackStep = await runAutoRunStep({ projectRoot: root });

    expect(feedbackStep).toMatchObject({
      kind: "blocked",
      claim: { kind: "blocked", reason: expect.stringContaining("unknown certificate verification error") }
    });
    await expect(getExecutionStatus({ projectRoot: root })).resolves.toMatchObject({
      currentFeedbackId: "FE-001"
    });
  });
});
