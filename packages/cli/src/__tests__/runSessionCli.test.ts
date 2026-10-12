import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runCli,
  runCliExpectFailure,
  repoRoot,
  cliWorkflowTimeoutMs,
  type CreateCanvasWorkspaceJsonResult
} from "./support/cliTestHarness.js";

async function snapshotTree(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        snapshot[`${relativePath}/`] = "directory";
        await visit(path, relativePath);
      } else {
        snapshot[relativePath] = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
      }
    }
  }
  await visit(root, "");
  return snapshot;
}

function snapshotHash(snapshot: Record<string, string>): string {
  return createHash("sha256")
    .update(JSON.stringify(Object.entries(snapshot).sort()))
    .digest("hex");
}

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
    "prunes only the explicit canvas and keeps conflicting modes and previews read-only",
    async () => {
      const fixtureRoot = await mkdtemp(join(tmpdir(), "planweave-prune-cli-"));
      const home = join(fixtureRoot, "home");
      const sourceRoot = join(fixtureRoot, "source");
      await mkdir(sourceRoot);
      const env = { ...process.env, PLANWEAVE_HOME: home, PLANWEAVE_CANVAS_ID: "b" };
      const cli = (args: string[]) => runCli(["--project-root", sourceRoot, ...args], env);
      const failure = (args: string[]) =>
        runCliExpectFailure(["--project-root", sourceRoot, ...args], env);
      try {
        await cli(["init", "--json"]);
        const canvases: CreateCanvasWorkspaceJsonResult[] = [];
        for (const id of ["a", "b"]) {
          const canvas = JSON.parse(
            (await cli(["canvas", "create", "--id", id, "--title", id, "--json"])).stdout
          ) as CreateCanvasWorkspaceJsonResult;
          canvases.push(canvas);
          for (const [runId, month] of [
            ["RUN-001", "01"],
            ["RUN-002", "02"],
            ["RUN-003", "03"]
          ]) {
            const runDir = join(canvas.resultsDir, "T-001", "blocks", "B-001", "runs", runId);
            await mkdir(runDir, { recursive: true });
            await writeFile(join(runDir, "report.md"), `${id} ${runId}\n`);
            await writeFile(
              join(runDir, "metadata.json"),
              JSON.stringify({
                runId,
                submittedAt: `2026-${month}-01T00:00:00.000Z`
              })
            );
          }
          await writeFile(
            canvas.statePath,
            JSON.stringify({
              currentRefs: [],
              currentFeedbackId: null,
              currentReviewBlockRef: null,
              tasks: {},
              blocks: { "T-001#B-001": { status: "completed", lastRunId: "RUN-002" } },
              feedback: {}
            })
          );
          const sessionDir = join(canvas.resultsDir, "run-sessions", "SESSION-0001");
          await mkdir(sessionDir, { recursive: true });
          await writeFile(
            join(sessionDir, "session.json"),
            JSON.stringify({
              stateVersion: 0,
              sessionId: "SESSION-0001",
              kind: "run",
              trigger: "manual",
              projectRoot: sourceRoot,
              canvasId: id,
              scope: { kind: "project" },
              phase: "running",
              startedAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              finishedAt: null,
              reset: null,
              autoRun: null,
              latestRecordId: null,
              latestRecordPath: null,
              workspaceExecution: null,
              error: null
            })
          );
        }
        await cli(["canvas", "use", "b", "--json"]);
        const [a, b] = canvases;
        const before = await snapshotTree(home);
        const conflict = await failure([
          "run-sessions",
          "--canvas",
          "a",
          "prune",
          "--dry-run",
          "--force",
          "--reason",
          "test-owned cleanup",
          "--keep-last",
          "1",
          "--json"
        ]);
        expect(conflict.code).toBe(1);
        expect(conflict.stderr).toContain("--dry-run cannot be combined with --force");
        expect(conflict.stdout).toBe("");
        expect(await snapshotTree(home)).toEqual(before);

        for (const { args, canvas } of [
          {
            args: ["run-sessions", "--canvas", "a", "prune", "--keep-last", "1", "--json"],
            canvas: a
          },
          {
            args: ["run-sessions", "--canvas", "a", "--json", "prune", "--keep-last", "1"],
            canvas: a
          },
          {
            args: [
              "run-sessions",
              "prune",
              "--canvas",
              "a",
              "--dry-run",
              "--keep-last",
              "1",
              "--json"
            ],
            canvas: a
          },
          {
            args: [
              "run-sessions",
              "--canvas",
              "a",
              "prune",
              "--canvas",
              "b",
              "--keep-last",
              "1",
              "--json"
            ],
            canvas: b
          }
        ]) {
          const output = (await cli(args)).stdout;
          expect(output).toContain(
            join(canvas.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001")
          );
          const preview = JSON.parse(output);
          expect(preview.mode).toBe("dry-run");
          expect(preview.plan.items.map((item: { path: string }) => item.path)).toEqual([
            join(canvas.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001")
          ]);
          expect(preview.plan.totals).toMatchObject({ runs: 3, sessions: 1 });
          expect(await snapshotTree(home)).toEqual(before);
        }
        for (const [options, message] of [
          [["--force", "--keep-last", "1"], "requires --reason"],
          [["--force", "--reason", "test"], "requires at least one"],
          [["--keep-last", "-1"], "must be a non-negative integer"],
          [["--keep-last", "1.5"], "must be a non-negative integer"]
        ] as const) {
          const invalid = await failure(["run-sessions", "prune", "--canvas", "a", ...options]);
          expect(invalid.code).toBe(1);
          expect(invalid.stderr).toContain(message);
          expect(await snapshotTree(home)).toEqual(before);
        }
        const bBefore = await snapshotTree(b.canvasRoot);
        const aBefore = await snapshotTree(a.canvasRoot);
        const readOnlyHash = snapshotHash(await snapshotTree(home));
        const applied = JSON.parse(
          (
            await cli([
              "run-sessions",
              "--canvas",
              "a",
              "prune",
              "--force",
              "--reason",
              "  test-owned cleanup  ",
              "--keep-last",
              "1",
              "--json"
            ])
          ).stdout
        );
        expect(applied.mode).toBe("applied");
        expect(applied.applied.reason).toBe("test-owned cleanup");
        expect(applied.applied.deleted.map((item: { id: string }) => item.id)).toEqual(["RUN-001"]);
        expect(applied.applied.skipped).toEqual([]);
        expect(await snapshotTree(b.canvasRoot)).toEqual(bBefore);
        const removedPrefix = "results/T-001/blocks/B-001/runs/RUN-001/";
        const expectedA = Object.fromEntries(
          Object.entries(aBefore).filter(([path]) => !path.startsWith(removedPrefix))
        );
        const afterA = await snapshotTree(a.canvasRoot);
        const sequencePath = "results/run-sessions/.session-sequence.json";
        const sequenceBytes = await readFile(join(a.canvasRoot, sequencePath));
        expect(JSON.parse(sequenceBytes.toString("utf8"))).toEqual({
          version: 1,
          highestAllocated: 1
        });
        expectedA[sequencePath] = createHash("sha256").update(sequenceBytes).digest("hex");
        const indexPrefix = "results/T-001/blocks/B-001/runs/.planweave-task-workspace-run-index/";
        expect(
          Object.fromEntries(
            Object.entries(afterA).filter(([path]) => !path.startsWith(indexPrefix))
          )
        ).toEqual(expectedA);
        process.stdout.write(
          `prune fixture evidence ${JSON.stringify({
            fixtureRoot,
            conflictExitCode: conflict.code,
            readOnly: { before: snapshotHash(before), after: readOnlyHash },
            force: {
              exitCode: 0,
              deleted: applied.applied.deleted.map((item: { id: string }) => item.id),
              aBefore: snapshotHash(aBefore),
              aAfter: snapshotHash(afterA),
              bBefore: snapshotHash(bBefore),
              bAfter: snapshotHash(await snapshotTree(b.canvasRoot))
            }
          })}\n`
        );
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    },
    cliWorkflowTimeoutMs
  );

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
    const stdoutPath = join(runDir, "stdout.md");
    await waitForText(metadataPath, /"finishedAt": null/);
    await waitForText(stdoutPath, /.*/);
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
    await expect(readFile(stdoutPath, "utf8")).resolves.not.toContain("unexpected");
  }, 20_000);
});
