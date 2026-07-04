import { setTimeout as delay } from "node:timers/promises";
import { access, chmod, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOpencodeExecAdapter, getExecutionStatus, runAutoRunStep } from "../index.js";
import { readJsonFile } from "../json.js";
import { formatOpencodeErrorOutput, parseOpencodeJsonOutput } from "../autoRun/opencodeOutput.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import { manifestTestBuilder } from "./manifestTestBuilder.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitForMetadataSession(metadataPath: string, expectedSessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
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
  it("does not treat ordinary JSON message fields as OpenCode errors", () => {
    const ordinaryEvent = JSON.stringify({
      type: "message",
      name: "Progress",
      message: "Still working.",
      ref: "note_123"
    });

    expect(parseOpencodeJsonOutput(`${ordinaryEvent}\n`)).toMatchObject({
      parsedAny: true,
      error: null
    });
    expect(formatOpencodeErrorOutput(ordinaryEvent, "")).toBeNull();
    expect(formatOpencodeErrorOutput("", ordinaryEvent)).toBeNull();
  });

  it("formats terminal Error-prefixed OpenCode JSON blocks", () => {
    const payload = JSON.stringify(
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

    expect(formatOpencodeErrorOutput("", `\u001b[91m\u001b[1mError: \u001b[0m${payload}`)).toBe(
      "OpenCode error UnknownError: Unexpected server error. Check server logs for details. (ref: err_1e659774)"
    );
  });

  it("parses OpenCode JSON events into a session id and run report", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("fake-opencode-json", {
        adapter: "opencode-exec",
        command: "./opencode",
        args: ["run", "--format", "json", "--dangerously-skip-permissions", "-"]
      })
      .withDefaultExecutor("fake-opencode-json")
      .build();
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
      projectRoot: init.workspace,
      executor: createOpencodeExecAdapter({
        projectRoot: init.workspace,
        executorName: "fake-opencode-json",
        runtime: { tmuxEnabled: false }
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
    const metadata = await readJsonFile<Record<string, unknown>>(join(runDir, "metadata.json"));
    expect(metadata).toMatchObject({
      agentSessionId: "ses_json_123",
      opencodeSessionId: "ses_json_123"
    });
    expect(metadata.tmuxSessionId).toBeUndefined();
  });

  it("keeps direct OpenCode runs readable and reads review JSON from the result file", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("fake-opencode-review", {
        adapter: "opencode-exec",
        command: "./opencode",
        args: ["run", "--dangerously-skip-permissions", "-"]
      })
      .withDefaultExecutor("fake-opencode-review")
      .build();
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
      executor: createOpencodeExecAdapter({
        projectRoot: init.workspace,
        executorName: "fake-opencode-review",
        runtime: { tmuxEnabled: false }
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
    const manifest = manifestTestBuilder()
      .withDefaultExecutor("fake-opencode-error")
      .withExecutor("needs-review", {
        adapter: "local-review",
        command: process.execPath,
        args: [
          "-e",
          "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => console.log(JSON.stringify({ reviewBlockRef: 'T-001#R-001', taskId: 'T-001', verdict: 'needs_changes', content: 'fix it' })));"
        ]
      })
      .withExecutor("fake-opencode-error", {
        adapter: "opencode-exec",
        command: "./opencode",
        args: ["run", "--dangerously-skip-permissions", "-"]
      })
      .withBlock("T-001", "R-001", (block) => ({ ...block, executor: "needs-review" }))
      .build();
    const { root, init } = await createTestWorkspace(manifest);
    await writeFile(
      join(root, "opencode"),
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const countPath = 'opencode-count.txt';",
        "const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, 'utf8')) : 0;",
        "fs.writeFileSync(countPath, String(count + 1));",
        "if (count === 0) {",
        "  console.log('implemented by opencode');",
        "  process.exit(0);",
        "}",
        "console.log(JSON.stringify({ type: 'step_start', sessionID: 'ses_error_123' }));",
        "console.log(JSON.stringify({ type: 'error', sessionID: 'ses_error_123', error: { name: 'UnknownError', data: { message: 'unknown certificate verification error' } } }));"
      ].join("\n"),
      "utf8"
    );
    await chmod(join(root, "opencode"), 0o755);

    await runAutoRunStep({ projectRoot: init.workspace, tmuxEnabled: false });
    await runAutoRunStep({ projectRoot: init.workspace, tmuxEnabled: false });
    const feedbackStep = await runAutoRunStep({ projectRoot: init.workspace, tmuxEnabled: false });

    expect(feedbackStep).toMatchObject({
      kind: "blocked",
      claim: { kind: "blocked", reason: expect.stringContaining("unknown certificate verification error") }
    });
    await expect(getExecutionStatus({ projectRoot: init.workspace })).resolves.toMatchObject({
      currentFeedbackId: "FE-001"
    });
  }, 20_000);
});
