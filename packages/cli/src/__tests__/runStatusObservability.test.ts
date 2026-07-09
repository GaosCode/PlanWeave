import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { cp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { cliWorkflowTimeoutMs, repoRoot, runCli } from "./support/cliTestHarness.js";

describe("run-status liveness and run-sessions events", () => {
  it(
    "includes aggregated heartbeat liveness fields in run-status --json",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
      const env = { ...process.env, PLANWEAVE_HOME: home };
      const init = JSON.parse((await runCli(["init", "--json"], env)).stdout) as {
        workspace: { resultsDir: string; packageDir: string };
      };
      await cp(join(repoRoot, "examples/basic-plan-package/package"), init.workspace.packageDir, {
        recursive: true,
        force: true
      });

      const runDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001");
      await mkdir(runDir, { recursive: true });
      await writeFile(
        join(runDir, "metadata.json"),
        JSON.stringify({
          runId: "RUN-001",
          ref: "T-001#B-001",
          executor: "codex",
          adapter: "codex-exec",
          startedAt: "2026-07-09T00:00:00.000Z",
          finishedAt: null
        }),
        "utf8"
      );
      await writeFile(join(runDir, "stdout.md"), "still working\n", "utf8");
      await writeFile(
        join(runDir, "heartbeat.json"),
        JSON.stringify({
          status: "running",
          pid: 4242,
          lastHeartbeatAt: "2026-07-09T00:00:05.000Z"
        }),
        "utf8"
      );

      const status = JSON.parse((await runCli(["run-status", "--json"], env)).stdout) as {
        latestRuns: Array<{
          ref: string;
          runId: string;
          executor: string | null;
          heartbeatStatus: string | null;
          heartbeatPid: number | null;
          lastActivityAt: string | null;
          lastHeartbeatAt: string | null;
        }>;
      };

      const run = status.latestRuns.find(
        (item) => item.ref === "T-001#B-001" && item.runId === "RUN-001"
      );
      expect(run).toMatchObject({
        executor: "codex",
        heartbeatStatus: "running",
        heartbeatPid: 4242,
        lastHeartbeatAt: "2026-07-09T00:00:05.000Z"
      });
      expect(run?.lastActivityAt).toBeTruthy();
    },
    cliWorkflowTimeoutMs
  );

  it(
    "dumps run-sessions events snapshot without --follow",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
      const env = { ...process.env, PLANWEAVE_HOME: home };
      const init = JSON.parse((await runCli(["init", "--json"], env)).stdout) as {
        workspace: { resultsDir: string; packageDir: string };
      };
      await cp(join(repoRoot, "examples/basic-plan-package/package"), init.workspace.packageDir, {
        recursive: true,
        force: true
      });

      const runId = "DESKTOP-RUN-0100";
      const logPath = join(init.workspace.resultsDir, "auto-runs", runId, "events.ndjson");
      await mkdir(join(init.workspace.resultsDir, "auto-runs", runId), { recursive: true });
      await writeFile(
        logPath,
        [
          JSON.stringify({
            timestamp: "2026-07-09T00:00:00.000Z",
            runId,
            type: "run_started",
            phase: "running",
            stepCount: 0,
            currentRef: null
          }),
          JSON.stringify({
            timestamp: "2026-07-09T00:00:01.000Z",
            runId,
            type: "step_finish",
            phase: "paused",
            stepCount: 1,
            currentRef: "T-001#B-001"
          })
        ].join("\n") + "\n",
        "utf8"
      );

      const json = JSON.parse(
        (await runCli(["run-sessions", "events", runId, "--json"], env)).stdout
      ) as {
        runId: string;
        events: Array<{ type: string | null; line: number }>;
        diagnostics: unknown[];
      };
      expect(json).toMatchObject({
        runId,
        diagnostics: [],
        events: [
          { line: 1, type: "run_started" },
          { line: 2, type: "step_finish" }
        ]
      });

      const text = (await runCli(["run-sessions", "events", runId], env)).stdout;
      expect(text).toContain("run: DESKTOP-RUN-0100");
      expect(text).toContain("run_started");
      expect(text).toContain("step_finish");
    },
    cliWorkflowTimeoutMs
  );
});
