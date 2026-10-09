/* @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import {
  exampleAssignmentProjection,
  exampleObserverEvent
} from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import type { WorkAuthorityProjection } from "@planweave-ai/collaboration-protocol/work/authority";
import { CollaborationReadModelController } from "../renderer/collaboration/CollaborationReadModelController";
import { workItemKey } from "../shared/collaborationReadModels";
import { createMockApi } from "./helpers/collaborationReadModelFixtures";

const workItem = exampleAssignmentProjection.workItem;
const key = workItemKey(workItem);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function fixture() {
  const f = createMockApi();
  const read = vi.mocked(f.api.getCollaborationWorkAuthority);
  const authorityFor = read.getMockImplementation()!;
  const initial = await f.api.getCollaborationWorkAuthority({ workItem });
  const authority = {
    ...initial,
    responsibility: { ...initial.responsibility, revision: 3 },
    reviewer: { ...initial.reviewer, revision: 17 }
  };
  read.mockResolvedValue(authority);
  const controller = new CollaborationReadModelController({ api: f.api });
  await controller.setActiveProject({
    profileId: "profile-demo-001",
    projectId: "project-demo-001",
    canvasId: "canvas-1"
  });
  await controller.ensureWorkAuthority(workItem);
  let observerCursor = 0;
  const run = async (entry: string) => {
    if (entry === "ensure") await controller.ensureWorkAuthority(workItem);
    else if (entry === "aggregate") await controller.refreshAuthoritative();
    else if (entry === "observer") {
      observerCursor += 1;
      f.signalListeners[0]!({
        type: "human.observer.event",
        profileId: "profile-demo-001",
        projectId: "project-demo-001",
        event: {
          ...exampleObserverEvent,
          cursor: observerCursor,
          previousCursor: observerCursor - 1,
          kind: "assignment",
          workItem
        }
      });
      await vi.waitFor(() => expect(controller.getSnapshot().observerCursor).toBe(observerCursor));
    } else if (entry === "responsibility") {
      vi.mocked(f.api.updateCollaborationResponsibility).mockResolvedValue(
        authority.responsibility
      );
      expect(
        await controller.updateResponsibility({ workItem, principal: null, expectedRevision: 2 })
      ).toEqual(authority.responsibility);
    } else {
      vi.mocked(f.api.updateCollaborationReviewer).mockResolvedValue(authority.reviewer);
      expect(
        await controller.updateReviewer({ workItem, principal: null, expectedRevision: 16 })
      ).toEqual(authority.reviewer);
    }
  };
  return { ...f, controller, read, authority, authorityFor, run };
}

describe("work authority request ordering", () => {
  it("keeps a current authority aggregate failure incomplete and recovers on newer same-item success", async () => {
    const f = await fixture();
    try {
      f.read.mockRejectedValueOnce({
        kind: "offline",
        code: "current_authority_failed",
        message: "Current failure",
        retryable: true
      });
      await f.controller.refreshAuthoritative();
      expect(f.controller.getSnapshot().lastError?.code).toBe("current_authority_failed");
      expect(f.controller.getSnapshot().syncPhase).toBe("error");
      expect(f.controller.getSnapshot().loadingKinds).toEqual([]);
      await f.controller.ensureWorkAuthority(workItem);
      expect(f.controller.getSnapshot().lastError).toBeNull();
      expect(f.controller.getSnapshot().syncPhase).toBe("ready");
    } finally {
      f.controller.dispose();
    }
  });
  it("success for another work item cannot clear the current authority error", async () => {
    const f = await fixture();
    try {
      const error = {
        kind: "forbidden",
        code: "current_item_failed",
        message: "Current item failed",
        retryable: false
      };
      f.read.mockRejectedValueOnce(error);
      await expect(f.controller.ensureWorkAuthority(workItem)).rejects.toBe(error);
      const otherItem = { ...workItem, canvasId: "other-canvas" };
      f.read.mockResolvedValueOnce(await f.authorityFor({ workItem: otherItem }));
      await f.controller.ensureWorkAuthority(otherItem);
      expect(f.controller.getSnapshot().lastError?.code).toBe(error.code);
      expect(f.controller.getSnapshot().syncPhase).toBe("forbidden");
      expect(f.controller.getSnapshot().loadingKinds).toEqual([]);
    } finally {
      f.controller.dispose();
    }
  });
  it.each([
    "latest failure",
    "latest success",
    "current activity failure"
  ])("does not replay retired aggregate authority failure after %s", async (scenario) => {
    const f = await fixture();
    const page = await f.api.listCollaborationActivity({});
    const activity = deferred<typeof page>();
    const observed = deferred<void>();
    const oldError = {
      kind: "offline",
      code: "old_aggregate_failed",
      message: "Old failure",
      retryable: true
    };
    const latestError = {
      kind: "forbidden",
      code: "latest_authority_failed",
      message: "Latest failure",
      retryable: false
    };
    const unsubscribe = f.controller.subscribe((snapshot) => {
      if (snapshot.lastError?.code === oldError.code) observed.resolve();
    });
    try {
      f.listActivity.mockReturnValueOnce(activity.promise);
      f.read.mockRejectedValueOnce(oldError);
      const aggregate = f.controller.refreshAuthoritative();
      await observed.promise;
      if (scenario === "latest failure") {
        f.read.mockRejectedValueOnce(latestError);
        await expect(f.controller.ensureWorkAuthority(workItem)).rejects.toBe(latestError);
        expect(f.controller.getSnapshot().lastError?.code).toBe(latestError.code);
      } else await f.controller.ensureWorkAuthority(workItem);
      if (scenario === "current activity failure")
        activity.reject({
          kind: "offline",
          code: "activity_failed",
          message: "Activity failed",
          retryable: true
        });
      else activity.resolve(page);
      await aggregate;
      expect(f.controller.getSnapshot().lastError?.code ?? null).toBe(
        scenario === "latest failure"
          ? latestError.code
          : scenario === "current activity failure"
            ? "activity_failed"
            : null
      );
      expect(f.controller.getSnapshot().syncPhase).toBe(
        scenario === "latest failure"
          ? "forbidden"
          : scenario === "current activity failure"
            ? "error"
            : "ready"
      );
      expect(f.controller.getSnapshot().loadingKinds).toEqual([]);
    } finally {
      unsubscribe();
      activity.resolve(page);
      f.controller.dispose();
    }
  });
  it.each([
    "ensure",
    "aggregate",
    "observer",
    "responsibility",
    "reviewer"
  ])("%s refresh supersedes older success and failure", async (entry) => {
    const f = await fixture();
    try {
      for (const olderEntry of new Set(["ensure", entry]))
        for (const failure of [false, true]) {
          const old = deferred<WorkAuthorityProjection>();
          f.read.mockReturnValueOnce(old.promise);
          const reads = f.read.mock.calls.length;
          const pending = f.run(olderEntry);
          await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(reads + 1));
          await f.run(olderEntry === "ensure" ? entry : "ensure");
          if (failure)
            old.reject({
              kind: "offline",
              code: "old_failed",
              message: "Old failure",
              retryable: true
            });
          else
            old.resolve({
              ...f.authority,
              responsibility: { ...f.authority.responsibility, revision: 2 }
            });
          await pending;
          expect(f.controller.getSnapshot().workAuthorityByWorkItem[key]).toEqual(f.authority);
          expect(f.controller.getSnapshot().lastError).toBeNull();
          expect(f.controller.getSnapshot().loadingKinds).toEqual([]);
        }
    } finally {
      f.controller.dispose();
    }
  });
  it("an older aggregate cannot clear a newer authority error", async () => {
    const f = await fixture();
    const old = deferred<WorkAuthorityProjection>();
    try {
      f.read.mockReturnValueOnce(old.promise);
      const aggregate = f.controller.refreshAuthoritative();
      await vi.waitFor(() =>
        expect(f.controller.getSnapshot().loadingKinds).toContain(`authority:${key}`)
      );
      f.read.mockRejectedValueOnce({
        kind: "offline",
        code: "latest_failed",
        message: "Latest failed",
        retryable: true
      });
      await expect(f.controller.ensureWorkAuthority(workItem)).rejects.toMatchObject({
        code: "latest_failed"
      });
      old.resolve(f.authority);
      await aggregate;
      expect(f.controller.getSnapshot().lastError?.code).toBe("latest_failed");
      expect(f.controller.getSnapshot().loadingKinds).toEqual([]);
    } finally {
      old.resolve(f.authority);
      f.controller.dispose();
    }
  });
  it.each([
    "success",
    "failure"
  ])("retired scope ignores old %s and releases leases", async (outcome) => {
    const f = await fixture();
    const gate = deferred<WorkAuthorityProjection>();
    try {
      f.read.mockReturnValueOnce(gate.promise);
      const pending = f.controller.ensureWorkAuthority(workItem);
      f.controller.clear();
      await f.controller.setActiveProject({ profileId: "profile-new", projectId: "project-new" });
      if (outcome === "success") gate.resolve(f.authority);
      else gate.reject(new Error("retired_failed"));
      expect(await pending).toBeNull();
      expect(f.controller.getSnapshot().workAuthorityByWorkItem).toEqual({});
      expect(f.controller.getSnapshot().lastError).toBeNull();
      expect(f.controller.getSnapshot().loadingKinds).toEqual([]);
    } finally {
      gate.resolve(f.authority);
      f.controller.dispose();
    }
  });
  it.each([
    "responsibility",
    "reviewer"
  ] as const)("%s mutation success survives latest confirmation refresh error", async (role) => {
    const f = await fixture();
    try {
      f.read.mockRejectedValueOnce({
        kind: "offline",
        code: "confirmation_failed",
        message: "Refresh failed",
        retryable: true
      });
      await f.run(role);
      expect(f.controller.getSnapshot().lastError?.code).toBe("confirmation_failed");
      expect(f.controller.getSnapshot().loadingKinds).toEqual([]);
      expect(Object.values(f.controller.getSnapshot().mutationsById)).toEqual([
        expect.objectContaining({ status: "confirmed" })
      ]);
    } finally {
      f.controller.dispose();
    }
  });
});
