import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ExecutorCancelledError,
  executorHeartbeatPath,
  execWithStreaming
} from "../autoRun/executorShared.js";
import {
  createCodexExecAdapter,
  createOpencodeExecAdapter,
  listWslDistributions,
  prepareExecutionHostInvocation,
  runAutoRunStep
} from "../index.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import { manifestTestBuilder } from "./manifestTestBuilder.js";

const WSL_DISTRIBUTION = "Ubuntu";
const WSL_LAUNCH_TIMEOUT_MS = 30_000;
const WSL_LIFECYCLE_TIMEOUT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(
  path: string,
  label: string,
  timeoutMs = WSL_LIFECYCLE_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch {
      // The WSL process has not written this readiness marker yet.
    }
    await sleep(25);
  }
  throw new Error(`Timed out waiting for WSL ${label} marker: ${path}`);
}

async function waitForFileWhileRunning(
  path: string,
  label: string,
  running: Promise<unknown>,
  timeoutMs: number
): Promise<void> {
  return Promise.race([
    waitForFile(path, label, timeoutMs),
    running.then(
      () => {
        throw new Error(`WSL process exited before writing the ${label} marker.`);
      },
      (error: unknown) => {
        throw error;
      }
    )
  ]);
}

describe("executor environment", () => {
  const requireWslTests = process.env.PLANWEAVE_REQUIRE_WSL_TESTS === "1";

  it.runIf(process.platform === "win32")(
    "does not import a sentinel Windows credential named by WSLENV",
    async ({ skip }) => {
      const distributions = await listWslDistributions({ platform: "win32" });
      const distribution = "Ubuntu";
      if (!distributions.available || !distributions.distributions.includes(distribution)) {
        const reason = distributions.unavailableReason
          ? `Ubuntu WSL distribution is required: ${distributions.unavailableReason}`
          : "Ubuntu WSL distribution is required.";
        if (requireWslTests) {
          throw new Error(reason);
        }
        skip(reason);
      }

      const prepared = await prepareExecutionHostInvocation({
        host: { kind: "wsl", distribution },
        command: "sh",
        args: [
          "-c",
          'if [ "${PLANWEAVE_WSL_SECRET_SENTINEL+x}" = x ]; then exit 91; fi; if [ "$WSL_DISTRO_NAME" != "Ubuntu" ]; then exit 92; fi; printf "%s:clean" "$WSL_DISTRO_NAME"'
        ],
        cwd: process.cwd(),
        env: {
          ...process.env,
          WSLENV: "PLANWEAVE_WSL_SECRET_SENTINEL/u",
          PLANWEAVE_WSL_SECRET_SENTINEL: "must-not-cross-host"
        },
        platform: "win32"
      });

      await expect(
        new Promise<string>((resolve, reject) => {
          execFile(
            prepared.command,
            prepared.args,
            {
              encoding: "utf8",
              env: prepared.spawnEnvironment,
              timeout: 30_000,
              windowsHide: true
            },
            (error, stdout) => {
              if (error) {
                reject(error);
                return;
              }
              resolve(String(stdout));
            }
          );
        })
      ).resolves.toBe("Ubuntu:clean");
    },
    120_000
  );

  it.runIf(process.platform === "win32")(
    "cancels a WSL execution and finalizes executor lifecycle",
    async ({ skip }) => {
      const distributions = await listWslDistributions({ platform: "win32" });
      if (!distributions.available || !distributions.distributions.includes(WSL_DISTRIBUTION)) {
        const reason = distributions.unavailableReason
          ? `${WSL_DISTRIBUTION} WSL distribution is required: ${distributions.unavailableReason}`
          : `${WSL_DISTRIBUTION} WSL distribution is required.`;
        if (requireWslTests) {
          throw new Error(reason);
        }
        skip(reason);
      }

      const runDir = await mkdtemp(join(homedir(), ".planweave-wsl-lifecycle-"));
      const stdoutPath = join(runDir, "stdout.log");
      const abort = new AbortController();
      let running: ReturnType<typeof execWithStreaming> | undefined;

      try {
        running = execWithStreaming({
          command: "sh",
          args: ["-c", "trap '' TERM; while :; do sleep 1; done"],
          cwd: runDir,
          stdin: "",
          host: { kind: "wsl", distribution: WSL_DISTRIBUTION },
          stdoutPath,
          stderrPath: join(runDir, "stderr.log"),
          timeoutMs: 60_000,
          maxStdoutBytes: 1024,
          maxStderrBytes: 1024,
          signal: abort.signal
        });

        await waitForFileWhileRunning(
          executorHeartbeatPath(stdoutPath),
          "executor launch",
          running,
          WSL_LAUNCH_TIMEOUT_MS
        );
        await sleep(2_000);

        abort.abort(new Error("test cancellation"));
        await expect(running).rejects.toBeInstanceOf(ExecutorCancelledError);
        await expect(
          readFile(executorHeartbeatPath(stdoutPath), "utf8").then(
            (content) => JSON.parse(content) as Record<string, unknown>
          )
        ).resolves.toMatchObject({
          status: "failed",
          timedOut: false,
          finishedAt: expect.any(String),
          error: "Executor cancelled."
        });
      } finally {
        abort.abort();
        try {
          await running?.catch((error: unknown) => {
            if (!(error instanceof ExecutorCancelledError)) {
              throw error;
            }
          });
        } finally {
          await rm(runDir, { recursive: true, force: true });
        }
      }
    },
    120_000
  );

  it("runs codex-exec in the project directory with the PlanWeave data home", async () => {
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
            "  fs.writeFileSync(path.join(process.cwd(), 'codex-cwd.txt'), process.cwd());",
            "  fs.writeFileSync(path.join(process.cwd(), 'codex-planweave-home.txt'), process.env.PLANWEAVE_HOME ?? '');",
            "  console.log('report:' + input.includes('Implement task'));",
            "});"
          ].join("")
        ]
      })
      .withDefaultExecutor("fake-codex")
      .build();
    const { root, init } = await createTestWorkspace(manifest);
    const previousHome = process.env.PLANWEAVE_HOME;
    process.env.PLANWEAVE_HOME = join(root, "polluted-planweave-home");

    try {
      await expect(
        runAutoRunStep({
          projectRoot: init.workspace,
          executor: createCodexExecAdapter({
            projectRoot: init.workspace,
            executorName: "fake-codex"
          })
        })
      ).resolves.toMatchObject({
        kind: "submitted",
        claim: { kind: "block", ref: "T-001#B-001" },
        submitResult: { ref: "T-001#B-001", runId: "RUN-001", status: "completed" }
      });
    } finally {
      process.env.PLANWEAVE_HOME = previousHome;
    }

    await expect(readFile(join(root, "codex-cwd.txt"), "utf8")).resolves.toBe(
      init.workspace.rootPath
    );
    await expect(readFile(join(root, "codex-planweave-home.txt"), "utf8")).resolves.toBe(
      init.workspace.planweaveHome
    );
  });

  it("runs opencode-exec in the project directory with the PlanWeave data home", async () => {
    const manifest = manifestTestBuilder()
      .withExecutor("fake-opencode", {
        adapter: "opencode-exec",
        command: process.execPath,
        args: [
          "-e",
          [
            "const fs = require('node:fs');",
            "const path = require('node:path');",
            "let input='';",
            "process.stdin.on('data', c => input += c);",
            "process.stdin.on('end', () => {",
            "  fs.writeFileSync(path.join(process.cwd(), 'opencode-cwd.txt'), process.cwd());",
            "  fs.writeFileSync(path.join(process.cwd(), 'opencode-planweave-home.txt'), process.env.PLANWEAVE_HOME ?? '');",
            "  console.error('  Continue  opencode -s ses_env_123');",
            "  console.log('opencode report:' + input.includes('Implement task'));",
            "});"
          ].join("")
        ]
      })
      .withDefaultExecutor("fake-opencode")
      .build();
    const { root, init } = await createTestWorkspace(manifest);
    const previousHome = process.env.PLANWEAVE_HOME;
    process.env.PLANWEAVE_HOME = join(root, "polluted-planweave-home");

    try {
      await expect(
        runAutoRunStep({
          projectRoot: init.workspace,
          executor: createOpencodeExecAdapter({
            projectRoot: init.workspace,
            executorName: "fake-opencode"
          })
        })
      ).resolves.toMatchObject({
        kind: "submitted",
        claim: { kind: "block", ref: "T-001#B-001" },
        submitResult: { ref: "T-001#B-001", runId: "RUN-001", status: "completed" }
      });
    } finally {
      process.env.PLANWEAVE_HOME = previousHome;
    }

    await expect(readFile(join(root, "opencode-cwd.txt"), "utf8")).resolves.toBe(
      init.workspace.rootPath
    );
    await expect(readFile(join(root, "opencode-planweave-home.txt"), "utf8")).resolves.toBe(
      init.workspace.planweaveHome
    );
  });
});
