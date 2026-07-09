import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestWorkspace } from "./promptTestHelpers.js";
import { manifestTestBuilder } from "./manifestTestBuilder.js";
import { writeJsonFile } from "../json.js";
import { tailAutoRunEvents } from "../desktop/index.js";
import type { ProjectWorkspace } from "../types.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

function eventLogPath(workspace: ProjectWorkspace, runId: string): string {
  return join(workspace.resultsDir, "auto-runs", runId, "events.ndjson");
}

function statePath(workspace: ProjectWorkspace, runId: string): string {
  return join(workspace.resultsDir, "auto-runs", runId, "state.json");
}

async function writeInitialLog(
  workspace: ProjectWorkspace,
  runId: string,
  lines: string[]
): Promise<string> {
  const path = eventLogPath(workspace, runId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8");
  return path;
}

function eventLine(
  runId: string,
  type: string,
  phase: string,
  extra: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    timestamp: "2026-07-09T00:00:00.000Z",
    runId,
    type,
    phase,
    stepCount: 0,
    currentRef: "T-001#B-001",
    ...extra
  });
}

describe("tailAutoRunEvents", () => {
  it("streams appended events in order and ends on terminal phase", async () => {
    const runId = "DESKTOP-RUN-9001";
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    const path = await writeInitialLog(init.workspace, runId, [
      eventLine(runId, "run_started", "running")
    ]);

    const abort = new AbortController();
    const collected: Array<{ kind: string; type?: string | null; phase?: string }> = [];
    const tailPromise = (async () => {
      for await (const item of tailAutoRunEvents(root, null, runId, {
        signal: abort.signal,
        pollIntervalMs: 50
      })) {
        if (item.kind === "event") {
          collected.push({ kind: "event", type: item.event.type, phase: item.event.phase });
        } else if (item.kind === "terminal") {
          collected.push({ kind: "terminal", phase: item.phase });
        } else {
          collected.push({ kind: "parse_error" });
        }
      }
    })();

    await new Promise((resolve) => setTimeout(resolve, 80));
    await appendFile(
      path,
      `${eventLine(runId, "step_finish", "running", { stepCount: 1 })}\n`,
      "utf8"
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    await appendFile(path, `${eventLine(runId, "run_completed", "completed")}\n`, "utf8");

    await tailPromise;

    expect(collected).toEqual([
      { kind: "event", type: "run_started", phase: "running" },
      { kind: "event", type: "step_finish", phase: "running" },
      { kind: "event", type: "run_completed", phase: "completed" },
      { kind: "terminal", phase: "completed" }
    ]);
  });

  it("yields explicit parse_error items for invalid lines", async () => {
    const runId = "DESKTOP-RUN-9002";
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    await writeInitialLog(init.workspace, runId, [
      eventLine(runId, "run_started", "running"),
      "{",
      eventLine(runId, "run_completed", "completed")
    ]);

    const items: Array<{ kind: string; message?: string }> = [];
    for await (const item of tailAutoRunEvents(root, null, runId, { pollIntervalMs: 50 })) {
      if (item.kind === "parse_error") {
        items.push({ kind: "parse_error", message: item.message });
      } else if (item.kind === "event") {
        items.push({ kind: "event" });
      } else {
        items.push({ kind: "terminal" });
      }
    }

    expect(items.filter((item) => item.kind === "event")).toHaveLength(2);
    expect(
      items.some((item) => item.kind === "parse_error" && item.message?.includes("not valid JSON"))
    ).toBe(true);
    expect(items.at(-1)).toEqual({ kind: "terminal" });
  });

  it("ends when persisted state is terminal even without a terminal event", async () => {
    const runId = "DESKTOP-RUN-9003";
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    await writeInitialLog(init.workspace, runId, [eventLine(runId, "run_started", "running")]);
    await writeJsonFile(statePath(init.workspace, runId), {
      runId,
      projectRoot: root,
      canvasId: null,
      scope: { kind: "project" },
      phase: "failed",
      stepCount: 1,
      stepLimit: 50,
      currentRef: "T-001#B-001",
      currentExecutor: "codex",
      elapsedMs: 10,
      latestOutputSummary: null,
      latestRecordId: null,
      latestRecordPath: null,
      explanation: {
        phase: "failed",
        currentRef: "T-001#B-001",
        currentExecutor: "codex",
        latestRecordId: null,
        latestRecordPath: null,
        latestOutputSummary: null,
        error: "boom",
        nextAction: {
          kind: "resolve_error",
          message: "fix",
          command: null,
          targetPath: null,
          ref: "T-001#B-001"
        }
      },
      statePath: statePath(init.workspace, runId),
      eventLogPath: eventLogPath(init.workspace, runId),
      options: { tmuxEnabled: true },
      error: "boom",
      startedAt: "2026-07-09T00:00:00.000Z",
      updatedAt: "2026-07-09T00:00:01.000Z"
    });

    const items: string[] = [];
    for await (const item of tailAutoRunEvents(root, null, runId, { pollIntervalMs: 50 })) {
      items.push(item.kind === "terminal" ? `terminal:${item.phase}` : item.kind);
    }

    expect(items).toEqual(["event", "terminal:failed"]);
  });

  it("stops without leaking when aborted", async () => {
    const runId = "DESKTOP-RUN-9004";
    const { root, init } = await createTestWorkspace(manifestTestBuilder().build());
    await writeInitialLog(init.workspace, runId, [eventLine(runId, "run_started", "running")]);

    const abort = new AbortController();
    const items: string[] = [];
    const tailPromise = (async () => {
      for await (const item of tailAutoRunEvents(root, null, runId, {
        signal: abort.signal,
        pollIntervalMs: 50
      })) {
        items.push(item.kind);
      }
    })();

    await new Promise((resolve) => setTimeout(resolve, 80));
    abort.abort();
    await tailPromise;

    expect(items).toContain("event");
    expect(items.some((kind) => kind === "terminal")).toBe(false);
  });
});
