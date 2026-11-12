import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeNormalizedRunnerEvent,
  normalizedOutputBody,
  normalizedRunnerEventSchema,
  type AcpRunnerRecordFollowReader,
  type TerminalOutcome
} from "@planweave-ai/runtime";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createAcpRunnerRecordFollowReader } from "../../../runtime/src/autoRun/runnerRecordReadModel.js";
import {
  registerRunStatusCommand,
  RunnerFollowDeduplicator,
  selectRunStatusFollowTarget
} from "../commands/runStatus.js";
import { formatCliError, workspaceExecutionExitCode } from "../errors.js";

const runtime = vi.hoisted(() => ({
  getAutoRunStatus: vi.fn(),
  getLatestAutoRunSummary: vi.fn(async () => null),
  readSelectedAcpRecord: vi.fn<AcpRunnerRecordFollowReader>()
}));

vi.mock("@planweave-ai/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@planweave-ai/runtime")>()),
  getAutoRunStatus: runtime.getAutoRunStatus,
  getLatestAutoRunSummary: runtime.getLatestAutoRunSummary
}));

vi.mock("../projectRoot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../projectRoot.js")>()),
  resolveCliProjectRoot: vi.fn(async () => "/projects/demo")
}));

const timestamp = "2026-07-11T00:00:00.000Z";
const identity = {
  projectId: "demo",
  canvasId: "default",
  taskId: "T-001",
  blockId: "B-001",
  claimRef: "T-001#B-001",
  runId: "RUN-001",
  runOwner: "executor",
  executorRunId: "RUN-001",
  runSessionId: null,
  desktopRunId: null
};

async function runnerRecord(finishedAt: string | null = null) {
  const directory = await mkdtemp(join(tmpdir(), "planweave-follow-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const metadataPath = join(directory, "metadata.json");
  const eventsPath = join(directory, "events.ndjson");
  const metadata = { ...identity, runnerKind: "acp", agentId: "codex", finishedAt };
  const run = {
    kind: "block" as const,
    ref: identity.claimRef,
    taskId: identity.taskId,
    blockId: identity.blockId,
    agentId: metadata.agentId,
    metadataPath,
    runId: identity.runId,
    runnerKind: metadata.runnerKind,
    startedAt: timestamp,
    finishedAt
  };
  await writeFile(metadataPath, JSON.stringify(metadata));
  const status = {
    explanation: {
      latestRecordId: "T-001#B-001::RUN-001",
      latestRecordPath: metadataPath
    },
    latestRuns: [run]
  };
  const readRecord = createAcpRunnerRecordFollowReader({
    run,
    metadata
  });
  runtime.readSelectedAcpRecord.mockImplementation(readRecord);
  runtime.getAutoRunStatus.mockImplementation(
    async ({
      onSelectedAcpRecord
    }: {
      onSelectedAcpRecord?: (read: AcpRunnerRecordFollowReader) => void;
    }) => {
      onSelectedAcpRecord?.(runtime.readSelectedAcpRecord);
      return status;
    }
  );
  return { metadataPath, eventsPath, status, readRecord };
}

function runnerEvent(sequence: number, body: unknown, eventIdentity = identity) {
  return normalizedRunnerEventSchema.parse({
    version: "planweave.runner-event/v1",
    sequence,
    timestamp,
    identity: eventIdentity,
    runner: { version: "planweave.runner/v1", runnerKind: "acp", agentId: "codex" },
    body
  });
}

function terminalEvent(
  state: TerminalOutcome["state"],
  reason?: TerminalOutcome["reason"],
  sequence = 1
) {
  return runnerEvent(sequence, {
    kind: "terminal",
    outcome: {
      version: "planweave.runner/v1",
      state,
      ...(reason === undefined ? {} : { reason }),
      exitCode: 0,
      finishedAt: timestamp,
      diagnostic: state === "succeeded" ? null : "Required artifact was not produced.",
      artifactValidated: state === "succeeded"
    }
  });
}

function runStatus(...args: string[]) {
  const program = new Command();
  registerRunStatusCommand(program);
  return program.parseAsync(["run-status", "--json", ...args], { from: "user" });
}

function captureJson() {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  return () => log.mock.calls.map(([line]) => JSON.parse(line));
}

const inactiveInteraction = {
  kind: "runner_interaction",
  interaction: { persisted: true, active: false, stale: true, activeRequests: [] }
};

describe("local ACP run-status --follow", () => {
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    process.exitCode = undefined;
    runtime.readSelectedAcpRecord.mockReset();
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  const outcomes: Array<{
    state: TerminalOutcome["state"];
    reason?: TerminalOutcome["reason"];
    exitCode: number;
  }> = [
    { state: "succeeded", reason: "completed", exitCode: 0 },
    { state: "failed", reason: "failed", exitCode: 1 },
    { state: "failed", reason: "timed_out", exitCode: 1 },
    { state: "cancelled", reason: "cancelled", exitCode: 130 },
    { state: "failed", exitCode: 1 }
  ];

  it.each(
    outcomes
  )("returns $exitCode for $state ($reason) even when the provider exited 0", async ({
    state,
    reason,
    exitCode
  }) => {
    const { eventsPath, status } = await runnerRecord(timestamp);
    const terminal = terminalEvent(state, reason);
    await writeFile(eventsPath, encodeNormalizedRunnerEvent(terminal));
    const stdout = captureJson();
    const listeners = process.listeners("SIGINT");

    await runStatus("--follow");

    expect(stdout()).toEqual([
      status,
      { kind: "runner_event", event: terminal },
      inactiveInteraction
    ]);
    expect(process.exitCode).toBe(exitCode);
    expect(process.listeners("SIGINT")).toEqual(listeners);
  });

  it("keeps snapshot-only reads successful for a failed ACP run", async () => {
    const { eventsPath, status } = await runnerRecord(timestamp);
    await writeFile(eventsPath, encodeNormalizedRunnerEvent(terminalEvent("failed")));
    const stdout = captureJson();

    await runStatus();

    expect(stdout()).toEqual([status]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(runtime.readSelectedAcpRecord).not.toHaveBeenCalled();
  });

  it("replays the running prefix once and reports nonfatal diagnostics before reaching a terminal outcome", async () => {
    const { eventsPath, readRecord } = await runnerRecord();
    const output = runnerEvent(1, normalizedOutputBody("stdout", "working"));
    const terminal = terminalEvent("failed", "timed_out", 2);
    await writeFile(eventsPath, `${encodeNormalizedRunnerEvent(output)}{invalid}\n`);
    runtime.readSelectedAcpRecord.mockImplementationOnce(async () => {
      const running = await readRecord();
      await appendFile(eventsPath, encodeNormalizedRunnerEvent(terminal));
      return running;
    });
    const stdout = captureJson();

    await runStatus("--follow");

    expect(stdout().slice(1)).toEqual([
      { kind: "runner_event", event: output },
      {
        kind: "runner_diagnostic",
        diagnostic: expect.objectContaining({ code: "corrupt_line", line: 2 })
      },
      inactiveInteraction,
      { kind: "runner_event", event: terminal }
    ]);
    expect(process.exitCode).toBe(1);
  });

  it("uses the complete model if the terminal event was already emitted", async () => {
    const { eventsPath, readRecord } = await runnerRecord();
    const terminal = terminalEvent("failed");
    await writeFile(eventsPath, encodeNormalizedRunnerEvent(terminal));
    const complete = await readRecord();
    runtime.readSelectedAcpRecord.mockResolvedValueOnce({
      ...complete,
      model: { ...complete.model, terminal: false }
    });
    const stdout = captureJson();

    await runStatus("--follow");

    expect(stdout().slice(1)).toEqual([
      { kind: "runner_event", event: terminal },
      inactiveInteraction
    ]);
    expect(process.exitCode).toBe(1);
  });

  it("exits 130 when SIGINT arrives before the pending terminal read completes", async () => {
    const { eventsPath, readRecord, status } = await runnerRecord();
    await writeFile(eventsPath, encodeNormalizedRunnerEvent(terminalEvent("succeeded")));
    const complete = await readRecord();
    const listeners = process.listeners("SIGINT");
    const stdout = captureJson();
    runtime.readSelectedAcpRecord.mockImplementationOnce(async () => {
      await Promise.resolve();
      process.emit("SIGINT");
      return complete;
    });

    await runStatus("--follow");

    expect(stdout()).toEqual([status]);
    expect(process.exitCode).toBe(130);
    expect(process.listeners("SIGINT")).toEqual(listeners);
  });

  it.each([
    "finished metadata",
    "terminal read model"
  ])("reports a missing outcome from %s", async (source) => {
    const { eventsPath, readRecord } = await runnerRecord(
      source === "finished metadata" ? timestamp : null
    );
    await writeFile(eventsPath, encodeNormalizedRunnerEvent(terminalEvent("succeeded")));
    const complete = await readRecord();
    if (source === "finished metadata") {
      await writeFile(
        eventsPath,
        `${encodeNormalizedRunnerEvent(runnerEvent(1, normalizedOutputBody("stdout", "working")))}{invalid}\n`
      );
    } else {
      runtime.readSelectedAcpRecord.mockResolvedValueOnce({
        ...complete,
        model: { ...complete.model, events: [] }
      });
    }
    captureJson();

    await expect(runStatus("--follow")).rejects.toThrow("has no unique terminal outcome");
  });

  it.each([
    { source: "a foreign event", replaceMetadata: false, expected: "selected record" },
    { source: "a replaced record", replaceMetadata: true, expected: "selected ACP record" }
  ])("fails via the CLI error channel for $source from another claim", async ({
    replaceMetadata,
    expected
  }) => {
    const { metadataPath, eventsPath, status } = await runnerRecord();
    const foreignIdentity = {
      ...identity,
      taskId: "T-002",
      claimRef: "T-002#B-001"
    };
    if (replaceMetadata) {
      await writeFile(metadataPath, JSON.stringify({ ...foreignIdentity, runnerKind: "acp" }));
    }
    const terminal = runnerEvent(1, terminalEvent("succeeded").body, foreignIdentity);
    await writeFile(eventsPath, encodeNormalizedRunnerEvent(terminal));
    const stdout = captureJson();
    const listeners = process.listeners("SIGINT");

    const error: unknown = await runStatus("--follow").catch((reason: unknown) => reason);

    expect(formatCliError(error)).toContain(
      `Error: Runner event identity does not match ${expected}`
    );
    expect(workspaceExecutionExitCode(error)).toBe(1);
    expect(stdout()).toEqual([status]);
    expect(process.listeners("SIGINT")).toEqual(listeners);
  });

  it("propagates a metadata read error and removes the observer's SIGINT listener", async () => {
    const { metadataPath } = await runnerRecord();
    await writeFile(metadataPath, "{");
    captureJson();
    const listeners = process.listeners("SIGINT");

    await expect(runStatus("--follow")).rejects.toBeInstanceOf(SyntaxError);

    expect(process.listeners("SIGINT")).toEqual(listeners);
  });
});

describe("run-status follow selection", () => {
  it("selects a newer exact CLI ACP record over a stale Desktop summary", () => {
    expect(
      selectRunStatusFollowTarget(
        {
          explanation: {
            latestRecordId: "T-001#R-001::RUN-002",
            latestRecordPath: "/results/review/RUN-002/metadata.json"
          },
          latestRuns: [
            {
              metadataPath: "/results/implementation/RUN-001/metadata.json",
              runnerKind: "acp",
              startedAt: "2026-07-11T00:00:00.000Z",
              finishedAt: "2026-07-11T00:00:01.000Z"
            },
            {
              metadataPath: "/results/review/RUN-002/metadata.json",
              runnerKind: "acp",
              startedAt: "2026-07-11T00:00:03.000Z",
              finishedAt: "2026-07-11T00:00:04.000Z"
            }
          ]
        },
        {
          runId: "DESKTOP-RUN-0001",
          updatedAt: "2026-07-11T00:00:02.000Z",
          latestRecordId: "T-001#B-001::RUN-001"
        }
      )
    ).toEqual({
      kind: "runner_record",
      timestamp: Date.parse("2026-07-11T00:00:04.000Z"),
      identity: "T-001#R-001::RUN-002"
    });
  });

  it("does not depend on latestRuns order when resolving the exact explanation path", () => {
    const target = selectRunStatusFollowTarget(
      {
        explanation: { latestRecordId: "new", latestRecordPath: "/new/metadata.json" },
        latestRuns: [
          {
            metadataPath: "/old/metadata.json",
            runnerKind: "acp",
            startedAt: "2026-07-11T00:00:00.000Z",
            finishedAt: null
          },
          {
            metadataPath: "/new/metadata.json",
            runnerKind: "acp",
            startedAt: "2026-07-11T00:00:02.000Z",
            finishedAt: null
          }
        ]
      },
      null
    );
    expect(target).toMatchObject({
      kind: "runner_record",
      timestamp: Date.parse("2026-07-11T00:00:02.000Z")
    });
  });

  it("emits stable diagnostics and interaction state only once across polls", () => {
    const deduplicator = new RunnerFollowDeduplicator();
    const stateA = {
      events: [],
      diagnostics: [{ code: "truncated_tail" as const, line: 7, message: "partial event" }],
      interaction: { persisted: true, active: true, stale: false }
    };
    const stateB = {
      ...stateA,
      interaction: { persisted: true, active: false, stale: true }
    };
    expect(deduplicator.take(stateA)).toEqual(stateA);
    expect(deduplicator.take(stateA)).toEqual({ events: [], diagnostics: [], interaction: null });
    expect(deduplicator.take(stateB)).toEqual({
      events: [],
      diagnostics: [],
      interaction: stateB.interaction
    });
    expect(deduplicator.take(stateA)).toEqual({
      events: [],
      diagnostics: [],
      interaction: stateA.interaction
    });
  });
});
