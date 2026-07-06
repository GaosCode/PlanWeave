import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getAutoRunStatus } from "../index.js";
import { readJsonFile } from "../json.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import { manifestTestBuilder } from "./manifestTestBuilder.js";
import { createContractOpencodeExecAdapter, runContractAutoRunStep } from "./autoRunTestBuilders.js";

describe("Auto Run OpenCode executor", () => {
  it("opencode-exec adapter records OpenCode runs without Codex resume/session handling", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("fake-opencode", {
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
      })
      .withDefaultExecutor("fake-opencode")
      .build();
    const { root, init } = await createTestWorkspace(manifest);

    const step = await runContractAutoRunStep({
      projectRoot: root,
      executor: createContractOpencodeExecAdapter({
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

    const step = await runContractAutoRunStep({
      projectRoot: root,
      executor: createContractOpencodeExecAdapter({
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
});
