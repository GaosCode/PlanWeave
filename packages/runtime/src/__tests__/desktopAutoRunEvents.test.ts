import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initWorkspace } from "../initWorkspace.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAutoRunState,
  startAutoRun,
  stopAutoRun,
  subscribeAutoRunEvents
} from "../desktop/index.js";
import type { DesktopAutoRunEvent } from "../desktop/index.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

const startedRunIds = new Set<string>();

afterEach(async () => {
  await Promise.all([...startedRunIds].map((runId) => stopAutoRun(runId).catch(() => undefined)));
  startedRunIds.clear();
  delete process.env.PLANWEAVE_HOME;
});

async function waitForRun(
  runId: string,
  predicate: (state: Awaited<ReturnType<typeof getAutoRunState>>) => boolean
) {
  let state = await getAutoRunState(runId);
  for (let attempt = 0; attempt < 500 && !predicate(state); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    state = await getAutoRunState(runId);
  }
  return state;
}

async function waitForRunEvent(
  events: DesktopAutoRunEvent[],
  runId: string,
  eventType: string
): Promise<DesktopAutoRunEvent[]> {
  let runEvents = events.filter((event) => event.runId === runId);
  for (
    let attempt = 0;
    attempt < 500 && !runEvents.some((event) => event.eventType === eventType);
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    runEvents = events.filter((event) => event.runId === runId);
  }
  return runEvents;
}

describe("desktop auto run events", () => {
  it("keeps the captured Home and project registration identity while its loop settles after a Home switch", async () => {
    const { root, home: homeA, init: initA } = await createTestWorkspace(basicManifest());
    const homeB = await mkdtemp(join(tmpdir(), "planweave-event-home-b-"));
    const initB = await initWorkspace({ projectRoot: root, planweaveHome: homeB });
    const events: DesktopAutoRunEvent[] = [];
    const unsubscribe = subscribeAutoRunEvents((event) => {
      events.push(event);
      if (event.eventType === "run_started") process.env.PLANWEAVE_HOME = homeB;
    });
    try {
      const startedA = await startAutoRun(root, "default", { kind: "project" }, 0);
      startedRunIds.add(startedA.runId);
      await waitForRun(startedA.runId, (state) => state.phase === "paused");
      const eventsA = await waitForRunEvent(events, startedA.runId, "step_limit_reached");
      expect(eventsA.map((event) => event.eventType)).toEqual([
        "run_started",
        "step_limit_reached"
      ]);
      expect(eventsA).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: "step_limit_reached",
            projectRoot: root,
            canvasId: "default",
            workspaceRoot: dirname(initA.workspace.projectFile),
            planweaveHome: homeA
          })
        ])
      );
      expect(eventsA.every((event) => event.planweaveHome === homeA)).toBe(true);
      const startedB = await startAutoRun(root, "default", { kind: "project" }, 0);
      startedRunIds.add(startedB.runId);
      const eventsB = await waitForRunEvent(events, startedB.runId, "step_limit_reached");
      expect(eventsB).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: "run_started",
            projectRoot: root,
            canvasId: "default",
            workspaceRoot: dirname(initB.workspace.projectFile),
            planweaveHome: homeB
          })
        ])
      );
      expect(initB.workspace.workspaceRoot).not.toBe(initA.workspace.workspaceRoot);
      await expect(getAutoRunState(startedA.runId)).resolves.toMatchObject({ phase: "paused" });
    } finally {
      unsubscribe();
    }
  });

  it("emits cloned events after start and phase changes", async () => {
    const { root } = await createTestWorkspace(basicManifest());
    const events: DesktopAutoRunEvent[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const unsubscribeThrowing = subscribeAutoRunEvents(() => {
      throw new Error("listener failed");
    });
    const unsubscribe = subscribeAutoRunEvents((event) => {
      expect(JSON.parse(JSON.stringify(event))).toEqual(event);
      events.push(event);
      if (event.eventType === "run_started") {
        event.state.phase = "failed";
        event.state.options.tmuxEnabled = true;
      }
    });

    try {
      const started = await startAutoRun(root, null, { kind: "project" }, 0, {
        tmuxEnabled: false
      });
      startedRunIds.add(started.runId);
      expect(started.phase).toBe("running");

      const current = await waitForRun(started.runId, (nextState) => nextState.phase === "paused");
      const runEvents = await waitForRunEvent(events, started.runId, "step_limit_reached");

      expect(current).toMatchObject({
        phase: "paused",
        error: "Step limit reached.",
        options: { tmuxEnabled: false }
      });
      expect(runEvents.map((event) => event.eventType)).toEqual([
        "run_started",
        "step_limit_reached"
      ]);
      expect(consoleError).toHaveBeenCalledWith(
        "Auto Run event listener failed.",
        expect.any(Error)
      );
      expect(runEvents[0]).toMatchObject({
        projectRoot: root,
        canvasId: null,
        phase: "running",
        currentRef: null,
        latestRecordId: null,
        latestRecordPath: null,
        eventType: "run_started",
        triggeredAt: expect.any(String)
      });
      expect(runEvents[1]).toMatchObject({
        projectRoot: root,
        canvasId: null,
        phase: "paused",
        currentRef: null,
        latestRecordId: null,
        latestRecordPath: null,
        eventType: "step_limit_reached",
        triggeredAt: expect.any(String),
        state: {
          phase: "paused",
          error: "Step limit reached."
        }
      });
      await expect(getAutoRunState(started.runId)).resolves.toMatchObject({
        phase: "paused",
        options: { tmuxEnabled: false }
      });
    } finally {
      unsubscribe();
      unsubscribeThrowing();
      consoleError.mockRestore();
    }
  });
});
