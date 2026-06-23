import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createTaskCanvas,
  listAutoRunEvents,
  resolveTaskCanvasWorkspace
} from "../desktop/index.js";
import type { ProjectWorkspace } from "../types.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import { manifestTestBuilder } from "./manifestTestBuilder.js";

function eventLogPath(workspace: ProjectWorkspace, runId: string): string {
  return join(workspace.resultsDir, "auto-runs", runId, "events.ndjson");
}

async function writeEventLog(workspace: ProjectWorkspace, runId: string, lines: string[]): Promise<string> {
  const path = eventLogPath(workspace, runId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
  return path;
}

describe("desktop auto run event log API", () => {
  it("returns ordered events from a valid ndjson log", async () => {
    const runId = "DESKTOP-RUN-0001";
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    const path = await writeEventLog(init.workspace, runId, [
      JSON.stringify({
        timestamp: "2026-06-23T00:00:00.000Z",
        runId,
        type: "run_started",
        phase: "running",
        stepCount: 0,
        currentRef: null,
        scope: { kind: "project" }
      }),
      JSON.stringify({
        timestamp: "2026-06-23T00:00:01.000Z",
        runId,
        type: "step_finish",
        phase: "paused",
        stepCount: 1,
        currentRef: "T-001#B-001",
        stepKind: "implementation"
      })
    ]);

    const log = await listAutoRunEvents(root, null, runId);

    expect(log).toEqual({
      runId,
      diagnostics: [],
      events: [
        {
          line: 1,
          timestamp: "2026-06-23T00:00:00.000Z",
          runId,
          type: "run_started",
          phase: "running",
          stepCount: 0,
          currentRef: null,
          data: { scope: { kind: "project" } }
        },
        {
          line: 2,
          timestamp: "2026-06-23T00:00:01.000Z",
          runId,
          type: "step_finish",
          phase: "paused",
          stepCount: 1,
          currentRef: "T-001#B-001",
          data: { stepKind: "implementation" }
        }
      ]
    });
    expect(log.events[0].data).not.toHaveProperty("timestamp");
    expect(log.events[0].data).not.toHaveProperty("runId");
    expect(log.events[0].data).not.toHaveProperty("type");
    expect(log.diagnostics.every((diagnostic) => diagnostic.path === path)).toBe(true);
  });

  it("keeps valid events around a bad JSON line and reports a diagnostic", async () => {
    const runId = "DESKTOP-RUN-0002";
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    const path = await writeEventLog(init.workspace, runId, [
      JSON.stringify({ timestamp: "2026-06-23T00:00:00.000Z", runId, type: "run_started" }),
      "{",
      JSON.stringify({ timestamp: "2026-06-23T00:00:02.000Z", runId, type: "run_stopped" })
    ]);

    const log = await listAutoRunEvents(root, null, runId);

    expect(log.events.map((event) => ({ line: event.line, type: event.type }))).toEqual([
      { line: 1, type: "run_started" },
      { line: 3, type: "run_stopped" }
    ]);
    expect(log.diagnostics).toEqual([
      {
        code: "auto_run_event_log_bad_line",
        message: expect.stringContaining("Line 2 is not valid JSON"),
        line: 2,
        path
      }
    ]);
  });

  it("diagnoses non-object lines, invalid known fields, and runId mismatches", async () => {
    const runId = "DESKTOP-RUN-0003";
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    const path = await writeEventLog(init.workspace, runId, [
      "[]",
      JSON.stringify({
        timestamp: 123,
        runId: 456,
        type: false,
        phase: "not-a-phase",
        stepCount: "1",
        currentRef: 789,
        extra: "kept"
      }),
      JSON.stringify({
        timestamp: "2026-06-23T00:00:03.000Z",
        runId: "DESKTOP-RUN-9999",
        type: "run_started",
        phase: "running",
        stepCount: 0,
        currentRef: null
      })
    ]);

    const log = await listAutoRunEvents(root, null, runId);

    expect(log.events).toEqual([
      {
        line: 2,
        timestamp: null,
        runId: null,
        type: null,
        data: { extra: "kept" }
      },
      {
        line: 3,
        timestamp: "2026-06-23T00:00:03.000Z",
        runId: "DESKTOP-RUN-9999",
        type: "run_started",
        phase: "running",
        stepCount: 0,
        currentRef: null,
        data: {}
      }
    ]);
    expect(log.diagnostics).toEqual([
      {
        code: "auto_run_event_log_bad_line",
        message: "Line 1 is not a JSON object.",
        line: 1,
        path
      },
      {
        code: "auto_run_event_log_bad_line",
        message: expect.stringContaining("timestamp must be a string"),
        line: 2,
        path
      },
      {
        code: "auto_run_event_log_bad_line",
        message: expect.stringContaining("does not match requested runId"),
        line: 3,
        path
      }
    ]);
    expect(log.diagnostics[1].message).toContain("phase must be a DesktopAutoRunPhase");
    expect(log.diagnostics[1].message).toContain("stepCount must be a finite number");
    expect(log.diagnostics[1].message).toContain("currentRef must be a string or null");
  });

  it("returns a missing diagnostic when the event log does not exist", async () => {
    const runId = "DESKTOP-RUN-0004";
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    const expectedPath = eventLogPath(init.workspace, runId);

    const log = await listAutoRunEvents(root, null, runId);

    expect(log).toEqual({
      runId,
      events: [],
      diagnostics: [
        {
          code: "auto_run_event_log_missing",
          message: `Auto Run event log '${expectedPath}' does not exist.`,
          path: expectedPath
        }
      ]
    });
  });

  it("rejects invalid run IDs before building the event log path", async () => {
    const unsafeRunId = "../DESKTOP-RUN-0001";
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    const escapedPath = join(init.workspace.resultsDir, "DESKTOP-RUN-0001", "events.ndjson");
    await mkdir(dirname(escapedPath), { recursive: true });
    await writeFile(
      escapedPath,
      `${JSON.stringify({ timestamp: "2026-06-23T00:00:00.000Z", runId: unsafeRunId, type: "escaped_event" })}\n`,
      "utf8"
    );

    const log = await listAutoRunEvents(root, null, unsafeRunId);

    expect(log).toEqual({
      runId: unsafeRunId,
      events: [],
      diagnostics: [
        {
          code: "auto_run_event_log_read_failed",
          message: expect.stringContaining("Invalid Auto Run runId '../DESKTOP-RUN-0001'"),
          path: join(init.workspace.resultsDir, "auto-runs")
        }
      ]
    });
  });

  it("returns a read_failed diagnostic for unreadable event log paths", async () => {
    const runId = "DESKTOP-RUN-0005";
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    const path = eventLogPath(init.workspace, runId);
    await mkdir(path, { recursive: true });

    const log = await listAutoRunEvents(root, null, runId);

    expect(log).toEqual({
      runId,
      events: [],
      diagnostics: [
        {
          code: "auto_run_event_log_read_failed",
          message: expect.stringContaining(`Failed to read Auto Run event log '${path}'`),
          path
        }
      ]
    });
  });

  it("uses the requested canvas workspace instead of scanning globally by runId", async () => {
    const runId = "DESKTOP-RUN-0006";
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    const canvas = await createTaskCanvas(root, { name: "Secondary" });
    const canvasWorkspace = await resolveTaskCanvasWorkspace(root, canvas.canvasId);
    await writeEventLog(init.workspace, runId, [
      JSON.stringify({ timestamp: "2026-06-23T00:00:00.000Z", runId, type: "default_run" })
    ]);
    await writeEventLog(canvasWorkspace, runId, [
      JSON.stringify({ timestamp: "2026-06-23T00:00:01.000Z", runId, type: "canvas_run" })
    ]);

    await expect(listAutoRunEvents(root, null, runId)).resolves.toMatchObject({
      events: [{ type: "default_run" }]
    });
    await expect(listAutoRunEvents(root, canvas.canvasId, runId)).resolves.toMatchObject({
      events: [{ type: "canvas_run" }]
    });
  });
});
