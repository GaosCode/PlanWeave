import { scopedProjectFixture } from "./helpers/collaborationOperationScopeFixture";
/* @vitest-environment jsdom */
import { waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exampleActivityRecord,
  exampleAssignmentProjection,
  exampleObserverEvent
} from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import { CollaborationReadModelController } from "../renderer/collaboration/CollaborationReadModelController";
import { createMockApi } from "./helpers/collaborationReadModelFixtures";
import { WorkAuthorityReadArbitrator } from "../renderer/collaboration/workAuthorityReadArbitration";
const workItem = exampleAssignmentProjection.workItem;
describe("work authority observer cursor recovery", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    "pending",
    "success",
    "failure"
  ])("rechecks a %s successor started after the authority batch check before publishing recovery", async (outcome) => {
    const mock = createMockApi();
    const controller = new CollaborationReadModelController({ api: mock.api });
    await controller.setActiveProject(
      scopedProjectFixture({ profileId: "profile-demo-001", projectId: "project-demo-001" })
    );
    const authority = await controller.ensureWorkAuthority(workItem);
    if (!authority) throw new Error("Authority fixture is missing");
    const replacement = {
      ...authority,
      responsibility: { ...authority.responsibility, revision: 1 },
      revisions: { ...authority.revisions, responsibilityRevision: 1 }
    };
    let release!: (value: typeof authority) => void;
    let reject!: (error: unknown) => void;
    const latest = new Promise<typeof authority>((resolve, rejectPromise) => {
      release = resolve;
      reject = rejectPromise;
    });
    const failure = {
      kind: "offline",
      code: "replacement_failed",
      message: "Replacement failed",
      retryable: true
    };
    let successor!: Promise<unknown>;
    let crossed!: () => void;
    const boundary = new Promise<void>((resolve) => {
      crossed = resolve;
    });
    const originalWait = WorkAuthorityReadArbitrator.prototype.waitForAggregate;
    // Keep the real request checks, then start a successor before the caller can publish.
    vi.spyOn(WorkAuthorityReadArbitrator.prototype, "waitForAggregate").mockImplementationOnce(
      function (this: WorkAuthorityReadArbitrator, ...args) {
        return originalWait.apply(this, args).then((results) => {
          vi.mocked(mock.api.getCollaborationWorkAuthority)
            .mockResolvedValue(replacement)
            .mockReturnValueOnce(latest);
          successor = controller.ensureWorkAuthority(workItem).catch((error) => error);
          if (outcome === "success") release(replacement);
          if (outcome === "failure") reject(failure);
          crossed();
          return results;
        });
      }
    );
    const refreshes = vi.spyOn(controller, "refreshAuthoritative");
    const emit = (cursor: number, kind: "invitation" | "activity" = "invitation") => {
      mock.signalListeners[0]!({
        type: "human.observer.event",
        profileId: "profile-demo-001",
        projectId: "project-demo-001",
        event: { ...exampleObserverEvent, kind, cursor, previousCursor: cursor - 1 }
      });
    };
    try {
      for (let index = 0; index < 512; index += 1) {
        const cursor = index === 0 ? 1 : index === 1 ? 3 : index + 3;
        await new Promise<void>((resolve) => {
          const unsubscribe = controller.subscribe((snapshot) => {
            if (snapshot.observerCursor !== cursor) return;
            unsubscribe();
            resolve();
          });
          emit(cursor);
        });
      }
      await boundary;
      const recovery = refreshes.mock.results[0]!.value;
      let settled = false;
      void recovery.then(() => {
        settled = true;
      });
      // A new event-loop turn drains the entire publication/recovery microtask chain.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (outcome === "pending") {
        expect(settled).toBe(false);
        expect(controller.getSnapshot().loadingKinds).toContain("snapshot");
      }
      if (outcome !== "success") {
        const recoveredActivity = { ...exampleActivityRecord, activityId: "late-gap-activity" };
        const reads = mock.listActivity.mock.calls.length;
        mock.listActivity.mockResolvedValue({ items: [recoveredActivity], nextCursor: null });
        emit(2, "activity");
        await waitFor(() => {
          expect(mock.listActivity.mock.calls.length).toBeGreaterThan(reads);
          expect(controller.getSnapshot().activity).toEqual([recoveredActivity]);
        });
      }
      release(replacement);
      await successor;
      await expect(recovery).resolves.toMatchObject({
        status: outcome === "failure" ? "failed" : "applied",
        ...(outcome === "failure" ? { error: failure } : {})
      });
      if (outcome !== "failure") {
        expect(controller.getSnapshot().lastError).toBeNull();
      }
      await waitFor(() => expect(controller.getSnapshot().loadingKinds).toEqual([]));
      if (outcome !== "failure") {
        expect(Object.values(controller.getSnapshot().workAuthorityByWorkItem)).toEqual([
          replacement
        ]);
      }
    } finally {
      release(replacement);
      controller.dispose();
    }
  });

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
