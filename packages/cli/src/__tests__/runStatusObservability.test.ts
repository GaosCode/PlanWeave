import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  encodeNormalizedRunnerEvent,
  initManagedWorkspace,
  type InitWorkspaceResult,
  normalizedOutputBody,
  normalizedRunnerEventSchema,
  type NormalizedRunnerEvent,
  type TerminalOutcome
} from "@planweave-ai/runtime";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  createTaskCanvas,
  resolveTaskCanvasWorkspace
} from "../../../runtime/src/desktop/canvasApi.js";
import { renameProject } from "../../../runtime/src/desktop/projectApi.js";
import {
  cliWorkflowTimeoutMs,
  repoRoot,
  runCli,
  startManagedTestCommand
} from "./support/cliTestHarness.js";

async function initializeObservabilityProject(managedCanvas?: "default" | "secondary") {
  const directory = await mkdtemp(join(tmpdir(), "planweave-cli-observability-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const projectRoot = join(directory, "project");
  const userHome = join(directory, "home");
  if (!managedCanvas) await mkdir(projectRoot);
  await mkdir(userHome);
  const env = {
    ...process.env,
    HOME: userHome,
    USERPROFILE: userHome,
    PLANWEAVE_HOME: join(directory, "planweave-home"),
    PLANWEAVE_DESKTOP_SETTINGS_FILE: join(directory, "desktop-settings.json")
  };
  if (managedCanvas) {
    vi.stubEnv("PLANWEAVE_HOME", env.PLANWEAVE_HOME);
    vi.stubEnv("PLANWEAVE_DESKTOP_SETTINGS_FILE", env.PLANWEAVE_DESKTOP_SETTINGS_FILE);
    onTestFinished(() => vi.unstubAllEnvs());
  }
  const init = managedCanvas
    ? await initManagedWorkspace({
        name: "Before ACP history rename",
        planweaveHome: env.PLANWEAVE_HOME,
        projectGraph: true
      })
    : (JSON.parse(
        (await runCli(["--project-root", projectRoot, "init", "--json"], env)).stdout
      ) as InitWorkspaceResult);
  const projectArgs = ["--project-root", init.project.rootPath];
  let workspace = init.workspace;
  let canvasId = "default";
  if (managedCanvas === "secondary") {
    ({ canvasId } = await createTaskCanvas(init.project.rootPath, { name: "ACP history" }));
    workspace = await resolveTaskCanvasWorkspace(init.project.rootPath, canvasId);
  }
  await cp(join(repoRoot, "examples/basic-plan-package/package"), workspace.packageDir, {
    recursive: true,
    force: true
  });
  return { ...workspace, projectId: init.project.id, projectArgs, env, canvasId };
}

type ObservabilityProject = Awaited<ReturnType<typeof initializeObservabilityProject>>;
type RecordStatus = "running" | "completed" | "failed" | "timed_out" | "cancelled";

const startedAt = "2026-07-09T00:00:00.000Z";
const finishedAt = "2026-07-09T00:00:01.000Z";
const ref = "T-001#B-001";
const runId = "RUN-001";

async function writeAtomic(path: string, contents: string) {
  const pendingPath = `${path}.pending`;
  await writeFile(pendingPath, contents);
  await rename(pendingPath, path);
}

async function persistAcpRecord(
  project: ObservabilityProject,
  status: RecordStatus,
  feedbackId?: string
) {
  const identity = {
    projectId: project.projectId,
    canvasId: project.canvasId,
    taskId: "T-001",
    blockId: feedbackId ? "R-001" : "B-001",
    claimRef: feedbackId ? "T-001#R-001" : ref,
    runId,
    runOwner: "executor",
    executorRunId: runId,
    runSessionId: null,
    desktopRunId: null
  };
  const runner = { version: "planweave.runner/v1", runnerKind: "acp", agentId: "codex" };
  const runDir = feedbackId
    ? join(project.resultsDir, "feedback-runs", runId)
    : join(project.resultsDir, "T-001", "blocks", "B-001", "runs", runId);
  const metadataPath = join(runDir, "metadata.json");
  const eventsPath = join(runDir, "events.ndjson");
  await mkdir(runDir, { recursive: true });
  async function writeMetadata(status: RecordStatus, overrides: Record<string, unknown> = {}) {
    await writeAtomic(
      metadataPath,
      JSON.stringify({
        ...identity,
        ref: identity.claimRef,
        ...(feedbackId ? { feedbackId, sourceReviewBlockRef: identity.claimRef } : {}),
        runnerKind: runner.runnerKind,
        agentId: runner.agentId,
        startedAt,
        finishedAt: status === "running" ? null : finishedAt,
        status,
        ...overrides
      })
    );
  }
  await writeMetadata(status);
  return {
    runDir,
    metadataPath,
    eventsPath,
    writeMetadata,
    event: (
      sequence: number,
      body: NormalizedRunnerEvent["body"],
      overrides: Partial<typeof identity> = {}
    ) =>
      normalizedRunnerEventSchema.parse({
        version: "planweave.runner-event/v1",
        timestamp: body.kind === "terminal" ? finishedAt : startedAt,
        sequence,
        identity: { ...identity, ...overrides },
        runner,
        body
      })
  };
}

function terminalBody(state: TerminalOutcome["state"], reason: TerminalOutcome["reason"]) {
  return {
    kind: "terminal",
    outcome: {
      version: "planweave.runner/v1",
      state,
      reason,
      exitCode: 0,
      finishedAt,
      diagnostic: state === "succeeded" ? null : "Run did not complete successfully.",
      artifactValidated: state === "succeeded"
    }
  } as const;
}

type FollowProcess = ReturnType<typeof startManagedTestCommand>;

async function followRunStatus(
  project: Pick<ObservabilityProject, "projectArgs" | "env" | "canvasId">,
  whileFollowing?: (follow: FollowProcess) => Promise<void>
) {
  const follow = startManagedTestCommand({
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      join(repoRoot, "packages", "cli", "src", "index.ts"),
      ...project.projectArgs,
      "run-status",
      ...(project.canvasId === "default" ? [] : ["--canvas", project.canvasId]),
      "--follow",
      "--json"
    ],
    cwd: repoRoot,
    env: project.env
  });
  try {
    const [result] = await Promise.all([follow.completed, whileFollowing?.(follow)]);
    return result;
  } finally {
    if (follow.tree.isAlive()) {
      await follow.tree.terminate("run-status observation test cleanup");
    }
    await follow.completed.catch(() => undefined);
  }
}

function readFollowOutput(stdout: string): { snapshot: unknown; frames: unknown[] } {
  const snapshotEnd = stdout.indexOf("\n}\n");
  if (snapshotEnd < 0) throw new Error(`No complete run-status snapshot in stdout: ${stdout}`);
  const lines = stdout.slice(snapshotEnd + 3).split("\n");
  expect(lines.pop()).toBe("");
  return {
    snapshot: JSON.parse(stdout.slice(0, snapshotEnd + 2)),
    frames: lines.map((line) => JSON.parse(line))
  };
}

function eventFrame(event: NormalizedRunnerEvent) {
  return { kind: "runner_event", event };
}

async function waitForEvent(follow: FollowProcess, event: NormalizedRunnerEvent) {
  await vi.waitFor(
    () => {
      const stdout = follow.stdout();
      const completeLines = stdout.slice(0, stdout.lastIndexOf("\n") + 1);
      expect(readFollowOutput(completeLines).frames).toContainEqual(eventFrame(event));
    },
    { timeout: 15_000 }
  );
}

const inactiveInteraction = {
  kind: "runner_interaction",
  interaction: { persisted: true, active: false, stale: true, activeRequests: [] }
};

describe("run-status liveness and run-sessions events", () => {
  it(
    "includes aggregated heartbeat liveness fields in run-status --json",
    async () => {
      const { env, projectArgs, resultsDir } = await initializeObservabilityProject();

      const runDir = join(resultsDir, "T-001", "blocks", "B-001", "runs", "RUN-001");
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

      const status = JSON.parse(
        (await runCli([...projectArgs, "run-status", "--json"], env)).stdout
      ) as {
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
      const { env, projectArgs, resultsDir } = await initializeObservabilityProject();

      const runId = "DESKTOP-RUN-0100";
      const logPath = join(resultsDir, "auto-runs", runId, "events.ndjson");
      await mkdir(join(resultsDir, "auto-runs", runId), { recursive: true });
      await writeFile(
        logPath,
        `${[
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
        ].join("\n")}\n`,
        "utf8"
      );

      const json = JSON.parse(
        (await runCli([...projectArgs, "run-sessions", "events", runId, "--json"], env)).stdout
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

      const text = (await runCli([...projectArgs, "run-sessions", "events", runId], env)).stdout;
      expect(text).toContain("run: DESKTOP-RUN-0100");
      expect(text).toContain("run_started");
      expect(text).toContain("step_finish");
    },
    cliWorkflowTimeoutMs
  );
});

describe("local ACP run-status follow process", () => {
  const outcomes = [
    { state: "succeeded", reason: "completed", status: "completed", code: 0 },
    { state: "failed", reason: "failed", status: "failed", code: 1 },
    { state: "failed", reason: "timed_out", status: "timed_out", code: 1 },
    { state: "cancelled", reason: "cancelled", status: "cancelled", code: 130 }
  ] as const;

  it.each(outcomes)(
    "exits $code after replaying $reason from disk",
    async ({ state, reason, status, code }) => {
      const project = await initializeObservabilityProject();
      const record = await persistAcpRecord(project, status);
      const terminal = record.event(1, terminalBody(state, reason));
      await writeFile(record.eventsPath, encodeNormalizedRunnerEvent(terminal));

      const result = await followRunStatus(project);
      const { snapshot, frames } = readFollowOutput(result.stdout);
      expect(snapshot).toMatchObject({
        latestRuns: [{ runId, ref, runnerKind: "acp", finishedAt }]
      });
      expect(frames).toEqual([eventFrame(terminal), inactiveInteraction]);
      expect(result).toMatchObject({ code, signal: null, stderr: "" });
    },
    cliWorkflowTimeoutMs
  );

  it.each([
    { kind: "block", canvas: "default", feedbackId: undefined },
    { kind: "feedback", canvas: "secondary", feedbackId: "FE-001" }
  ] as const)(
    "replays completed $kind history after renaming its managed project",
    async ({ kind, canvas, feedbackId }) => {
      const project = await initializeObservabilityProject(canvas);
      const record = await persistAcpRecord(project, "completed", feedbackId);
      if (feedbackId) {
        await record.writeMetadata("completed", {
          projectId: undefined,
          canvasId: undefined,
          runSessionId: undefined
        });
      }
      const terminal = record.event(1, terminalBody("succeeded", "completed"));
      const events = encodeNormalizedRunnerEvent(terminal);
      await writeFile(record.eventsPath, events);
      const metadata = await readFile(record.metadataPath, "utf8");
      const before = await followRunStatus(project);
      expect(before).toMatchObject({ code: 0, signal: null, stderr: "" });
      expect(readFollowOutput(before.stdout).frames).toEqual([
        eventFrame(terminal),
        inactiveInteraction
      ]);

      const renamed = await renameProject(project.projectId, "After ACP history rename");
      expect(renamed.projectId).not.toBe(project.projectId);
      const moved = await resolveTaskCanvasWorkspace(renamed.workspaceRoot, project.canvasId);
      const metadataPath = join(
        moved.resultsDir,
        relative(project.resultsDir, record.metadataPath)
      );
      const eventsPath = join(moved.resultsDir, relative(project.resultsDir, record.eventsPath));
      expect(await readFile(metadataPath, "utf8")).toBe(metadata);
      expect(await readFile(eventsPath, "utf8")).toBe(events);

      const after = await followRunStatus({
        ...project,
        projectArgs: ["--project-root", renamed.workspaceRoot]
      });
      expect(after).toMatchObject({ code: 0, signal: null, stderr: "" });
      expect(readFollowOutput(after.stdout)).toMatchObject({
        snapshot: {
          latestRuns: [{ kind, ref: feedbackId ?? ref, runId, finishedAt, metadataPath }]
        },
        frames: [eventFrame(terminal), inactiveInteraction]
      });
    },
    cliWorkflowTimeoutMs
  );

  it(
    "follows a running record across successive appends and emits each event and diagnostic once",
    async () => {
      const project = await initializeObservabilityProject();
      const record = await persistAcpRecord(project, "running");
      const first = record.event(1, normalizedOutputBody("stdout", "first output"));
      const second = record.event(2, normalizedOutputBody("stdout", "second output"));
      const terminal = record.event(3, terminalBody("failed", "failed"));
      await writeFile(record.eventsPath, `${encodeNormalizedRunnerEvent(first)}{invalid}\n`);

      const result = await followRunStatus(project, async (follow) => {
        await waitForEvent(follow, first);
        await appendFile(record.eventsPath, encodeNormalizedRunnerEvent(second));
        await waitForEvent(follow, second);
        await appendFile(record.eventsPath, encodeNormalizedRunnerEvent(terminal));
        await record.writeMetadata("failed");
      });

      const { snapshot, frames } = readFollowOutput(result.stdout);
      expect(snapshot).toMatchObject({
        latestRuns: [{ runId, ref, runnerKind: "acp", finishedAt: null }]
      });
      expect(frames).toEqual([
        eventFrame(first),
        {
          kind: "runner_diagnostic",
          diagnostic: { code: "corrupt_line", line: 2, message: expect.any(String) }
        },
        inactiveInteraction,
        eventFrame(second),
        eventFrame(terminal)
      ]);
      expect(result).toMatchObject({ code: 1, signal: null, stderr: "" });
    },
    cliWorkflowTimeoutMs
  );

  it(
    "exits with an error when a running ACP record finishes without a terminal event",
    async () => {
      const project = await initializeObservabilityProject();
      const record = await persistAcpRecord(project, "running");
      const output = record.event(1, normalizedOutputBody("stdout", "working"));
      await writeFile(record.eventsPath, `${encodeNormalizedRunnerEvent(output)}{invalid}\n`);

      const result = await followRunStatus(project, async (follow) => {
        await waitForEvent(follow, output);
        await record.writeMetadata("failed");
        await vi.waitFor(() => expect(follow.child.exitCode).not.toBeNull(), { timeout: 5_000 });
      });

      expect(readFollowOutput(result.stdout)).toMatchObject({
        snapshot: { latestRuns: [{ runId, ref, finishedAt: null }] },
        frames: [
          eventFrame(output),
          {
            kind: "runner_diagnostic",
            diagnostic: { code: "corrupt_line", line: 2, message: expect.any(String) }
          },
          inactiveInteraction
        ]
      });
      expect(result).toMatchObject({ code: 1, signal: null });
      expect(result.stderr).toContain("has no unique terminal outcome");
    },
    cliWorkflowTimeoutMs
  );

  it(
    "rejects a foreign project and Canvas replacing the observed record and its log",
    async () => {
      const project = await initializeObservabilityProject();
      const record = await persistAcpRecord(project, "running");
      const output = record.event(1, normalizedOutputBody("stdout", "working"));
      const foreignIdentity = { projectId: "another-project", canvasId: "another-canvas" };
      const terminal = record.event(2, terminalBody("succeeded", "completed"), foreignIdentity);
      await writeFile(record.eventsPath, encodeNormalizedRunnerEvent(output));

      const result = await followRunStatus(project, async (follow) => {
        await waitForEvent(follow, output);
        await record.writeMetadata("completed", foreignIdentity);
        await writeAtomic(record.eventsPath, encodeNormalizedRunnerEvent(terminal));
      });

      expect(result).toMatchObject({ code: 1, signal: null });
      expect(result.stderr).toContain("identity");
      expect(readFollowOutput(result.stdout).frames).toEqual([
        eventFrame(output),
        inactiveInteraction
      ]);
    },
    cliWorkflowTimeoutMs
  );

  it(
    "pins the canonical run session even when legacy metadata omitted it",
    async () => {
      const project = await initializeObservabilityProject();
      const record = await persistAcpRecord(project, "running");
      await record.writeMetadata("running", { runSessionId: undefined });
      const output = record.event(1, normalizedOutputBody("stdout", "working"));
      const terminal = normalizedRunnerEventSchema.parse({
        ...record.event(2, terminalBody("succeeded", "completed")),
        identity: { ...output.identity, runSessionId: "SESSION-0002" }
      });
      await writeFile(record.eventsPath, encodeNormalizedRunnerEvent(output));

      const result = await followRunStatus(project, async (follow) => {
        await waitForEvent(follow, output);
        await writeAtomic(record.eventsPath, encodeNormalizedRunnerEvent(terminal));
      });

      expect(result).toMatchObject({ code: 1, signal: null });
      expect(result.stderr).toContain("identity");
      expect(readFollowOutput(result.stdout).frames).toEqual([
        eventFrame(output),
        inactiveInteraction
      ]);
    },
    cliWorkflowTimeoutMs
  );

  it(
    "rejects a different feedback ID under the same review ref and runner identity",
    async () => {
      const project = await initializeObservabilityProject();
      const record = await persistAcpRecord(project, "running", "FE-001");
      const output = record.event(1, normalizedOutputBody("stdout", "working on feedback"));
      const terminal = record.event(2, terminalBody("succeeded", "completed"));
      await writeFile(record.eventsPath, encodeNormalizedRunnerEvent(output));

      const result = await followRunStatus(project, async (follow) => {
        await waitForEvent(follow, output);
        await record.writeMetadata("completed", { feedbackId: "FE-002" });
        await appendFile(record.eventsPath, encodeNormalizedRunnerEvent(terminal));
      });

      expect(result).toMatchObject({ code: 1, signal: null });
      expect(result.stderr).toContain("identity");
      expect(readFollowOutput(result.stdout)).toMatchObject({
        snapshot: {
          latestRuns: [{ kind: "feedback", ref: "FE-001", sourceReviewBlockRef: "T-001#R-001" }]
        },
        frames: [eventFrame(output), inactiveInteraction]
      });
    },
    cliWorkflowTimeoutMs
  );

  it.skipIf(process.platform === "win32")(
    "exits 130 on SIGINT without writing a cancellation into the running record or state",
    async () => {
      const project = await initializeObservabilityProject();
      const record = await persistAcpRecord(project, "running");
      const output = record.event(1, normalizedOutputBody("stdout", "still running"));
      await writeFile(record.eventsPath, encodeNormalizedRunnerEvent(output));
      const readPersistedState = async () => ({
        metadata: await readFile(record.metadataPath, "utf8"),
        events: await readFile(record.eventsPath, "utf8"),
        state: await readFile(project.stateFile, "utf8"),
        files: (await readdir(record.runDir, { recursive: true })).sort()
      });
      const before = await readPersistedState();

      const result = await followRunStatus(project, async (follow) => {
        await waitForEvent(follow, output);
        expect(follow.child.kill("SIGINT")).toBe(true);
      });

      expect(readFollowOutput(result.stdout).frames).toEqual([
        eventFrame(output),
        inactiveInteraction
      ]);
      expect(result).toMatchObject({ code: 130, signal: null, stderr: "" });
      expect(await readPersistedState()).toEqual(before);
    },
    cliWorkflowTimeoutMs
  );
});
