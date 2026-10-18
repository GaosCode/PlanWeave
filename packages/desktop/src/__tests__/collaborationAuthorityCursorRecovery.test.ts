import { scopedProjectFixture } from "./helpers/collaborationOperationScopeFixture";
/* @vitest-environment jsdom */
import { waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  exampleAssignmentProjection,
  exampleObserverEvent
} from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import { CollaborationReadModelController } from "../renderer/collaboration/CollaborationReadModelController";
import { createMockApi } from "./helpers/collaborationReadModelFixtures";
const workItem = exampleAssignmentProjection.workItem;
describe("work authority observer cursor recovery", () => {
  it.each([
    "success",
    "failure"
  ])("retains cursor recovery while its authority replacement is pending (%s)", async (outcome) => {
    const mock = createMockApi();
    const controller = new CollaborationReadModelController({ api: mock.api });
    let releaseOld!: (
      projection: Awaited<ReturnType<typeof mock.api.getCollaborationWorkAuthority>>
    ) => void;
    let releaseNew!: (
      projection: Awaited<ReturnType<typeof mock.api.getCollaborationWorkAuthority>>
    ) => void;
    let rejectNew!: (error: unknown) => void;
    let start!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const read = vi.mocked(mock.api.getCollaborationWorkAuthority);
    const observer = mock.signalListeners;
    await controller.setActiveProject(
      scopedProjectFixture({
        profileId: "profile-demo-001",
        projectId: "project-demo-001"
      })
    );
    const authority = await controller.ensureWorkAuthority(workItem);
    expect(authority).not.toBeNull();
    if (!authority) throw new Error("Authority fixture is missing");
    const old = new Promise<typeof authority>((resolve) => {
      releaseOld = resolve;
    });
    const latest = new Promise<typeof authority>((resolve, reject) => {
      releaseNew = resolve;
      rejectNew = reject;
    });
    read
      .mockImplementation(() => latest)
      .mockImplementationOnce(() => {
        start();
        return old;
      });
    try {
      // A full applied window requests recovery, with cursor 2 deliberately absent.
      for (let i = 0; i < 512; i += 1) {
        const cursor = i === 0 ? 1 : i === 1 ? 3 : i + 3;
        await new Promise<void>((resolve) => {
          const unsubscribe = controller.subscribe((snapshot) => {
            if (snapshot.observerCursor === cursor) {
              unsubscribe();
              resolve();
            }
          });
          observer[0]!({
            type: "human.observer.event",
            profileId: "profile-demo-001",
            projectId: "project-demo-001",
            event: {
              ...exampleObserverEvent,
              kind: "invitation",
              cursor,
              previousCursor: cursor - 1
            }
          });
        });
      }
      await started;
      read.mockReturnValueOnce(latest);
      const successor = controller.ensureWorkAuthority(workItem).catch((error) => error);
      releaseOld(authority);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const phaseWhilePending = controller.getSnapshot().syncPhase;
      const activityReads = mock.listActivity.mock.calls.length;
      // Retiring the recovery early would drop this missing out-of-order event.
      observer[0]!({
        type: "human.observer.event",
        profileId: "profile-demo-001",
        projectId: "project-demo-001",
        event: { ...exampleObserverEvent, kind: "activity", cursor: 2, previousCursor: 1 }
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const gapWasRead = mock.listActivity.mock.calls.length > activityReads;
      const failure = {
        kind: "offline",
        code: "replacement_failed",
        message: "Replacement failed",
        retryable: true
      };
      if (outcome === "success") releaseNew(authority);
      else rejectNew(failure);
      const result = await successor;
      await waitFor(() => expect(controller.getSnapshot().loadingKinds).toEqual([]));
      expect(phaseWhilePending).toBe("loading");
      expect(gapWasRead).toBe(true);
      expect(controller.getSnapshot().syncPhase).toBe(outcome === "success" ? "ready" : "error");
      if (outcome === "failure") {
        expect(result).toBe(failure);
        expect(controller.getSnapshot().lastError?.code).toBe(failure.code);
        const reads = mock.listActivity.mock.calls.length;
        observer[0]!({
          type: "human.observer.event",
          profileId: "profile-demo-001",
          projectId: "project-demo-001",
          event: { ...exampleObserverEvent, kind: "activity", cursor: 4, previousCursor: 3 }
        });
        await waitFor(() => expect(mock.listActivity.mock.calls.length).toBeGreaterThan(reads));
      }
    } finally {
      releaseOld(authority);
      releaseNew(authority);
      controller.dispose();
    }
  });
});
