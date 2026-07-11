import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli, repoRoot, cliWorkflowTimeoutMs } from "./support/cliTestHarness.js";

async function waitForText(path: string, pattern: RegExp): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      if (pattern.test(await readFile(path, "utf8"))) return;
    } catch {
      // The selected runner has not created its record yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${pattern} in ${path}.`);
}

describe("STEP-1 CLI contract: run sessions", () => {
  it(
    "reports explainable Auto Run status in JSON and text output",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
      const env = { ...process.env, PLANWEAVE_HOME: home };
      const init = JSON.parse((await runCli(["init", "--json"], env)).stdout);
      await cp(join(repoRoot, "examples/basic-plan-package/package"), init.workspace.packageDir, {
        recursive: true,
        force: true
      });

      const initial = JSON.parse((await runCli(["run-status", "--json"], env)).stdout) as {
        explanation: {
          phase: string;
          nextAction: { kind: string; command: string | null; message: string };
        };
      };
      expect(initial.explanation).toMatchObject({
        phase: "idle",
        nextAction: {
          kind: "start",
          command: null,
          message: "Continue Auto Run; claimable work is ready: T-001#B-001."
        }
      });

      await runCli(["run", "--once", "--executor", "manual"], env);
      const status = JSON.parse((await runCli(["run-status", "--json"], env)).stdout) as {
        explanation: {
          phase: string;
          currentRef: string | null;
          currentExecutor: string | null;
          latestRecordId: string | null;
          latestRecordPath: string | null;
          nextAction: { kind: string; message: string };
        };
        latestRuns: Array<{
          tmuxSessionName: string | null;
          tmuxAttachCommand: string | null;
          tmuxReadOnlyAttachCommand: string | null;
        }>;
      };
      expect(status.explanation).toMatchObject({
        phase: "manual",
        currentRef: "T-001#B-001",
        currentExecutor: "manual",
        latestRecordId: "T-001#B-001::RUN-001",
        latestRecordPath: expect.stringContaining("metadata.json"),
        nextAction: {
          kind: "submit_manual_result",
          message: "Complete the manual step, then submit the result."
        }
      });
      expect(status.latestRuns[0]).toMatchObject({
        tmuxSessionName: null,
        tmuxAttachCommand: null,
        tmuxReadOnlyAttachCommand: null
      });

      const text = (await runCli(["run-status"], env)).stdout;
      expect(text).toContain("latest record: T-001#B-001::RUN-001");
      expect(text).toContain("next action: Complete the manual step, then submit the result.");
    },
    cliWorkflowTimeoutMs
  );

  it("creates CLI run and reset sessions that can be queried", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const env = { ...process.env, PLANWEAVE_HOME: home };
    const init = JSON.parse((await runCli(["init", "--json"], env)).stdout);
    await cp(join(repoRoot, "examples/basic-plan-package/package"), init.workspace.packageDir, {
      recursive: true,
      force: true
    });

    const run = JSON.parse(
      (
        await runCli(
          [
            "run",
            "--once",
            "--executor",
            "manual",
            "--scope",
            "block",
            "--block",
            "T-001#B-001",
            "--json"
          ],
          env
        )
      ).stdout
    ) as {
      session: {
        sessionId: string;
        kind: string;
        phase: string;
        latestRecordId: string | null;
        scope: { kind: string; blockRef?: string };
      };
      steps: Array<{ kind: string }>;
      ok: boolean;
      terminalReason: string;
    };
    expect(run).toMatchObject({
      session: {
        sessionId: "SESSION-0001",
        kind: "run",
        phase: "manual",
        scope: { kind: "block", blockRef: "T-001#B-001" },
        latestRecordId: "T-001#B-001::RUN-001"
      },
      steps: [{ kind: "manual" }],
      ok: true,
      terminalReason: "manual"
    });

    const reset = JSON.parse(
      (await runCli(["reset", "--force", "--reason", "  rerun acceptance  ", "--json"], env)).stdout
    ) as {
      sessionId: string;
      statePath: string;
      reason: string | null;
      forced: boolean;
      session: { sessionId: string; kind: string; phase: string; reset: { reason: string | null } };
    };
    expect(reset).toMatchObject({
      sessionId: "SESSION-0002",
      reason: "rerun acceptance",
      forced: true,
      session: {
        sessionId: "SESSION-0002",
        kind: "reset",
        phase: "completed",
        reset: { reason: "rerun acceptance" }
      }
    });
    expect(reset.statePath).toContain("canvases/default/state.json");

    const taskRun = JSON.parse(
      (
        await runCli(
          ["run", "--once", "--executor", "manual", "--scope", "task", "--task", "T-001", "--json"],
          env
        )
      ).stdout
    ) as {
      session: {
        sessionId: string;
        kind: string;
        phase: string;
        latestRecordId: string | null;
        scope: { kind: string; taskId?: string };
      };
      steps: Array<{ kind: string }>;
      ok: boolean;
      terminalReason: string;
    };
    expect(taskRun).toMatchObject({
      session: {
        sessionId: "SESSION-0003",
        kind: "run",
        phase: "manual",
        scope: { kind: "task", taskId: "T-001" },
        latestRecordId: "T-001#B-001::RUN-002"
      },
      steps: [{ kind: "manual" }],
      ok: true,
      terminalReason: "manual"
    });

    const sessions = JSON.parse((await runCli(["run-sessions", "--json"], env)).stdout) as {
      sessions: Array<{ sessionId: string; kind: string }>;
      diagnostics: unknown[];
    };
    expect(sessions.diagnostics).toEqual([]);
    expect(sessions.sessions.map((session) => session.sessionId)).toEqual([
      "SESSION-0003",
      "SESSION-0002",
      "SESSION-0001"
    ]);
    expect(sessions.sessions.map((session) => session.kind)).toEqual(["run", "reset", "run"]);

    const detail = JSON.parse(
      (await runCli(["run-session", "SESSION-0001", "--json"], env)).stdout
    ) as {
      session: { sessionId: string; kind: string };
      events: Array<{ type: string }>;
      diagnostics: unknown[];
    };
    expect(detail).toMatchObject({
      session: { sessionId: "SESSION-0001", kind: "run" },
      diagnostics: []
    });
    expect(detail.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["session_started", "step_finish", "session_manual"])
    );
  }, 20_000);

  it("forwards SIGINT through AbortSignal to the selected CLI runner child", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const env = { ...process.env, PLANWEAVE_HOME: home };
    const init = JSON.parse((await runCli(["init", "--json"], env)).stdout) as {
      workspace: { packageDir: string; resultsDir: string };
    };
    await cp(join(repoRoot, "examples/basic-plan-package/package"), init.workspace.packageDir, {
      recursive: true,
      force: true
    });
    const manifestPath = join(init.workspace.packageDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    const execution = manifest.execution as Record<string, unknown>;
    execution.defaultExecutor = "slow-cli";
    manifest.executors = {
      "slow-cli": {
        adapter: "codex-exec",
        command: process.execPath,
        args: ["-e", "process.stdin.resume(); setTimeout(() => console.log('unexpected'), 60000)"]
      }
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await runCli(["trust", "executor", "slow-cli", "--json"], env);

    const child = spawn(
      join(repoRoot, "node_modules", ".bin", "tsx"),
      [join(repoRoot, "packages", "cli", "src", "index.ts"), "run", "--once", "--json"],
      { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));

    const runDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001");
    const metadataPath = join(runDir, "metadata.json");
    await waitForText(metadataPath, /"finishedAt": null/);
    child.kill("SIGINT");
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });

    expect(exitCode).toBe(1);
    expect(stderr).toBe("");
    const result = JSON.parse(stdout) as {
      session: { phase: string; autoRun: { stopReason: string } };
      terminalReason: string;
    };
    expect(result).toMatchObject({
      session: { phase: "stopped", autoRun: { stopReason: "cancelled" } },
      terminalReason: "cancelled"
    });
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      finishedAt: expect.any(String),
      exitCode: 130,
      outcome: "cancelled",
      cancelled: true,
      stopped: true,
      timedOut: false,
      failureReason: "Executor cancelled.",
      tmuxSessionName: expect.any(String)
    });
    await expect(readFile(join(runDir, "stdout.md"), "utf8")).resolves.not.toContain("unexpected");
  }, 20_000);
});
