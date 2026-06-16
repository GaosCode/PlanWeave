import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAutoRunState,
  startAutoRun,
  subscribeAutoRunEvents
} from "../desktop/index.js";
import type { DesktopAutoRunEvent } from "../desktop/index.js";
import { basicManifest, createTestWorkspace } from "./promptTestHelpers.js";

afterEach(() => {
  delete process.env.PLANWEAVE_HOME;
});

async function waitForRun(runId: string, predicate: (state: Awaited<ReturnType<typeof getAutoRunState>>) => boolean) {
  let state = await getAutoRunState(runId);
  for (let attempt = 0; attempt < 500 && !predicate(state); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    state = await getAutoRunState(runId);
  }
  return state;
}

describe("desktop auto run events", () => {
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
      const started = await startAutoRun(root, null, { kind: "project" }, 0, { tmuxEnabled: false });
      expect(started.phase).toBe("running");

      const current = await waitForRun(started.runId, (nextState) => nextState.phase === "paused");
      const runEvents = events.filter((event) => event.runId === started.runId);

      expect(current).toMatchObject({
        phase: "paused",
        error: "Step limit reached.",
        options: { tmuxEnabled: false }
      });
      expect(runEvents.map((event) => event.eventType)).toEqual(["run_started", "step_limit_reached"]);
      expect(consoleError).toHaveBeenCalledWith("Auto Run event listener failed.", expect.any(Error));
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
