import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCliRunner } from "../autoRun/cliRunner.js";
import { executeCliProcess, type CliProcessExecutor } from "../autoRun/cliProcess.js";
import type { AgentDefinition } from "../autoRun/agentRunner.js";
import { codexAgentDefinition } from "../autoRun/codexIntegration.js";
import { runAutoRunStep } from "../index.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

const processLimits = {
  timeoutMs: 5_000,
  maxStdoutBytes: 10_000,
  maxStderrBytes: 10_000
} as const;

describe("CliRunner process ownership", () => {
  it("owns one-shot stdin, stdout, stderr, heartbeat, and disabled tmux orchestration", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-cli-runner-"));
    const stdoutPath = join(runDir, "stdout.md");
    const stderrPath = join(runDir, "stderr.log");

    const result = await executeCliProcess({
      command: process.execPath,
      args: [
        "-e",
        [
          "let input = '';",
          "process.stdin.on('data', chunk => input += chunk);",
          "process.stdin.on('end', () => {",
          "  process.stdout.write('stdout:' + input);",
          "  process.stderr.write('stderr:' + process.env.PLANWEAVE_TEST_VALUE);",
          "});"
        ].join("\n")
      ],
      cwd: runDir,
      stdin: "prompt-body",
      env: { PLANWEAVE_TEST_VALUE: "env-value" },
      stdoutPath,
      stderrPath,
      limits: processLimits,
      tmux: { runDir, runId: "RUN-001", kind: "block", enabled: false }
    });

    expect(result).toMatchObject({
      stdout: "stdout:prompt-body",
      stderr: "stderr:env-value",
      exitCode: 0,
      timedOut: false,
      tmux: null
    });
    await expect(readFile(stdoutPath, "utf8")).resolves.toBe("stdout:prompt-body");
    await expect(readFile(stderrPath, "utf8")).resolves.toBe("stderr:env-value");
    await expect(readFile(join(runDir, "heartbeat.json"), "utf8")).resolves.toContain(
      '"status": "finished"'
    );
  });

  it("injects a replaceable process executor into the focused CLI definition", async () => {
    let observedStdin = "";
    const executeProcess: CliProcessExecutor = async (request) => {
      observedStdin = request.stdin;
      return {
        stdout: "replacement stdout",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        tmux: null
      };
    };
    const runner = createCliRunner({ executeProcess });
    const definition: AgentDefinition = {
      agent: "codex",
      builtinProfiles: {},
      cli: {
        integration: "codex-exec",
        async runBlock(input, context) {
          const executionRoot =
            typeof input.projectRoot === "string" ? input.projectRoot : input.projectRoot.rootPath;
          const result = await context.executeProcess({
            command: input.profile.command,
            args: input.profile.args,
            cwd: executionRoot,
            stdin: input.prompt,
            stdoutPath: join(executionRoot, "stdout.md"),
            stderrPath: join(executionRoot, "stderr.log"),
            limits: processLimits,
            tmux: {
              runDir: executionRoot,
              runId: "RUN-001",
              kind: "block",
              enabled: input.runtime?.tmuxEnabled
            }
          });
          return { kind: "block", reportPath: "report.md", stdout: result.stdout };
        },
        async runFeedback() {
          throw new Error("feedback should not run");
        }
      },
      acp: { launch: null, capabilities: [] }
    };
    const root = await mkdtemp(join(tmpdir(), "planweave-cli-runner-contract-"));

    const result = await runner.runBlock(
      {
        projectRoot: root,
        claim: {
          kind: "block",
          ref: "T-001#B-001",
          taskId: "T-001",
          blockId: "B-001",
          blockType: "implementation",
          effectiveExecutor: "codex"
        },
        prompt: "replaceable prompt",
        executorName: "codex",
        profile: {
          adapter: "agent",
          agent: "codex",
          runner: { transport: "cli", tmuxEnabled: false },
          command: "codex",
          args: ["exec", "-"]
        }
      },
      definition
    );

    expect(observedStdin).toBe("replaceable prompt");
    expect(result).toMatchObject({ kind: "block", stdout: "replacement stdout" });
  });

  it("keeps a replaceable CliRunner usable at the TaskManager executor seam", async () => {
    const { init } = await createTestWorkspace();
    const executeProcess: CliProcessExecutor = async (request) => {
      await request.onTmuxReady?.(null);
      await Promise.all([
        writeFile(request.stdoutPath, "runner-owned report", "utf8"),
        writeFile(request.stderrPath, "", "utf8")
      ]);
      return {
        stdout: "runner-owned report",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        tmux: null
      };
    };
    const runner = createCliRunner({ executeProcess });
    const profile = {
      adapter: "agent",
      agent: "codex",
      runner: { transport: "cli", tmuxEnabled: false },
      command: "replacement-codex",
      args: ["exec", "-"]
    } as const;

    const step = await runAutoRunStep({
      projectRoot: init.workspace,
      executor: {
        runBlock({ claim, prompt }) {
          return runner.runBlock(
            {
              projectRoot: init.workspace,
              claim,
              prompt,
              executorName: "replacement-codex",
              profile
            },
            codexAgentDefinition
          );
        },
        async runFeedback() {
          throw new Error("feedback should not run");
        }
      }
    });

    expect(step).toMatchObject({
      kind: "submitted",
      adapterResult: {
        kind: "block",
        adapter: "codex-exec",
        stdout: "runner-owned report"
      },
      submitResult: { ref: "T-001#B-001", status: "completed" }
    });
  });
});
