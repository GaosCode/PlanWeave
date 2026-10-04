import { afterEach, describe, expect, it, vi } from "vitest";
import { workAuthorityProjectionSchema } from "@planweave-ai/collaboration-protocol/work/authority";
import {
  exampleAssignmentProjection,
  exampleCommentProjection,
  exampleMemberPage,
  exampleObserverCatchupRequired
} from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import {
  CollaborationReadModelController,
  type CollaborationReadBridgePort
} from "../renderer/collaboration/CollaborationReadModelController";
import type { CollaborationObserverSignal } from "../shared/collaboration";

import { CollaborationMutationLedger } from "../renderer/collaboration/collaborationRetention";

afterEach(() => vi.restoreAllMocks());

const workItem = exampleAssignmentProjection.workItem;
const projectA = "project-demo-001";
const kinds = ["assignment", "responsibility", "reviewer", "create", "edit", "tombstone"] as const;
type MutationKind = (typeof kinds)[number];

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function authority(projectId: string) {
  return workAuthorityProjectionSchema.parse({
    schemaVersion: "work-authority/v1",
    scope: {
      kind: "task",
      workspaceId: "workspace-1",
      projectId,
      canvasId: "canvas-1",
      taskId: "task-1"
    },
    responsibility: {
      schemaVersion: "responsibility/v1",
      scope: {
        kind: "task",
        workspaceId: "workspace-1",
        projectId,
        canvasId: "canvas-1",
        taskId: "task-1"
      },
      principal: null,
      revision: 1,
      updatedAt: "2030-01-01T00:00:00.000Z",
      availability: "unassigned"
    },
    reviewer: {
      schemaVersion: "review-assignment/v1",
      scope: {
        kind: "task",
        workspaceId: "workspace-1",
        projectId,
        canvasId: "canvas-1",
        taskId: "task-1"
      },
      principal: null,
      revision: 1,
      updatedAt: "2030-01-01T00:00:00.000Z",
      availability: "unassigned"
    },
    executionTarget: null,
    selectedHost: null,
    revisions: { responsibilityRevision: 1, reviewerRevision: 1, executionTargetRevision: 0 },
    evaluatedAt: "2030-01-01T00:00:00.000Z"
  });
}

function setup(useDefaultMutationIds = false) {
  const gate = deferred();
  let projectId = projectA;
  let signalListener: ((signal: CollaborationObserverSignal) => void) | undefined;
  const assignment = { ...exampleAssignmentProjection, revision: 2 };
  const comment = { ...exampleCommentProjection, revision: 2, body: "server accepted A" };
  const tombstone = { ...comment, tombstoned: true };
  const models = authority(projectA);
  const api: CollaborationReadBridgePort = {
    getCollaborationStatus: vi.fn(),
    listCollaborationMembers: vi.fn().mockResolvedValue(exampleMemberPage),
    listCollaborationAssignments: vi.fn(async () => ({
      items: [{ ...exampleAssignmentProjection, projectId }],
      nextCursor: null
    })),
    listCollaborationEligibleAssignees: vi.fn(),
    listCollaborationEligibleHostsBatch: vi.fn().mockResolvedValue({ items: [], hosts: [] }),
    getCollaborationWorkAuthority: vi.fn(async () => authority(projectId)),
    listCollaborationComments: vi.fn(async () => ({
      items: [{ ...exampleCommentProjection, projectId }],
      nextCursor: null
    })),
    listCollaborationActivity: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    updateCollaborationAssignment: vi.fn(async () => {
      await gate.promise;
      return assignment;
    }),
    updateCollaborationResponsibility: vi.fn(async () => {
      await gate.promise;
      return models.responsibility;
    }),
    updateCollaborationReviewer: vi.fn(async () => {
      await gate.promise;
      return models.reviewer;
    }),
    createCollaborationComment: vi.fn(async () => {
      await gate.promise;
      return comment;
    }),
    editCollaborationComment: vi.fn(async () => {
      await gate.promise;
      return comment;
    }),
    tombstoneCollaborationComment: vi.fn(async () => {
      await gate.promise;
      return tombstone;
    }),
    onCollaborationStatusChanged: () => () => undefined,
    onCollaborationObserverSignal: (callback) => {
      signalListener = callback;
      return () => {
        signalListener = undefined;
      };
    }
  };
  let mutationSequence = 0;
  const controller = new CollaborationReadModelController({
    api,
    clock: { now: () => new Date("2030-01-01T00:00:00.000Z") },
    ...(useDefaultMutationIds ? {} : { createMutationId: () => `mut-${++mutationSequence}` })
  });
  const activate = async (project = projectA, profile = "profile-A", canvas = "canvas-1") => {
    projectId = project;
    await controller.setActiveProject({ profileId: profile, projectId: project, canvasId: canvas });
    await controller.trackWorkItemComments(workItem);
    await controller.ensureWorkAuthority(workItem);
  };
  const start = (kind: MutationKind) => {
    switch (kind) {
      case "assignment":
        return controller.updateAssignment({
          workItem,
          target: { kind: "unassigned" },
          expectedRevision: 1
        });
      case "responsibility":
        return controller.updateResponsibility({ workItem, principal: null, expectedRevision: 1 });
      case "reviewer":
        return controller.updateReviewer({ workItem, principal: null, expectedRevision: 1 });
      case "create":
        return controller.createComment({
          workItem,
          body: "submitted",
          bodyFormat: "markdown",
          attachments: []
        });
      case "edit":
        return controller.editComment({
          commentId: comment.commentId,
          body: "edited",
          bodyFormat: "markdown",
          expectedRevision: 1
        });
      case "tombstone":
        return controller.tombstoneComment({ commentId: comment.commentId, expectedRevision: 1 });
    }
  };
  const results = {
    assignment,
    responsibility: models.responsibility,
    reviewer: models.reviewer,
    create: comment,
    edit: comment,
    tombstone
  };
  return {
    api,
    controller,
    gate,
    activate,
    start,
    results,
    catchup: () =>
      signalListener?.({
        type: "human.observer.catchup_required",
        profileId: "profile-A",
        projectId: projectA,
        ...exampleObserverCatchupRequired
      })
  };
}

describe("mutation publication belongs to the original collaboration scope", () => {
  for (const outcome of ["success", "failure"] as const) {
    it.each(
      kinds
    )(`isolates late %s ${outcome} from another project with identical work IDs`, async (kind) => {
      const f = setup();
      try {
        await f.activate();
        const pending = f.start(kind);
        const observed = pending.then(
          (value) => ({ value }),
          (error) => ({ error })
        );
        await f.activate("project-B");
        const snapshot = f.controller.getSnapshot();
        const listener = vi.fn();
        f.controller.subscribe(listener);
        const reads = vi.mocked(f.api.getCollaborationWorkAuthority).mock.calls.length;
        const failure = { kind: "offline", code: "old_request_failed", message: "A failed" };
        if (outcome === "success") f.gate.resolve();
        else f.gate.reject(failure);
        expect(await observed).toEqual(
          outcome === "success" ? { value: f.results[kind] } : { error: failure }
        );
        expect(f.controller.getSnapshot()).toBe(snapshot);
        expect(listener).not.toHaveBeenCalled();
        expect(f.api.getCollaborationWorkAuthority).toHaveBeenCalledTimes(reads);
      } finally {
        f.controller.dispose();
      }
    });
  }

  it.each([
    "project ABA",
    "profile",
    "canvas ABA",
    "clear",
    "dispose"
  ])("retires pending writes across %s", async (transition) => {
    const f = setup();
    try {
      await f.activate();
      const pending = f.start("create");
      if (transition === "project ABA") {
        await f.activate("project-B");
        await f.activate();
      }
      if (transition === "profile") await f.activate(projectA, "profile-B");
      if (transition === "canvas ABA") {
        await f.activate(projectA, "profile-A", "canvas-B");
        await f.activate();
      }
      if (transition === "clear") f.controller.clear();
      if (transition === "dispose") f.controller.dispose();
      const snapshot = f.controller.getSnapshot();
      f.gate.resolve();
      expect(await pending).toBe(f.results.create);
      expect(f.controller.getSnapshot()).toBe(snapshot);
    } finally {
      f.controller.dispose();
    }
  });

  for (const success of [true, false]) {
    it(`finishes retired canvas ledger with ${success ? "success" : "failure"} while new writes stay isolated`, async () => {
      const f = setup();
      let retired: CollaborationMutationLedger | undefined;
      const original = CollaborationMutationLedger.prototype.setPending;
      const capture = vi
        .spyOn(CollaborationMutationLedger.prototype, "setPending")
        .mockImplementation(function (this: CollaborationMutationLedger, record) {
          retired = this;
          original.call(this, record);
        });
      try {
        await f.activate();
        const old = f.start("create");
        const observed = old.then(
          (value) => ({ value }),
          (error) => ({ error })
        );
        expect(retired?.records.get("mut-1")?.status).toBe("pending");
        capture.mockRestore();
        await f.activate(projectA, "profile-A", "canvas-B");
        const currentGate = deferred();
        vi.mocked(f.api.createCollaborationComment).mockImplementationOnce(async () => {
          await currentGate.promise;
          return { ...f.results.create, body: "current canvas confirmed" };
        });
        const current = f.start("create");
        const snapshot = f.controller.getSnapshot();
        const listener = vi.fn();
        f.controller.subscribe(listener);
        const failure = { kind: "offline", code: "retired_failure", message: "old canvas failed" };
        if (success) f.gate.resolve();
        else f.gate.reject(failure);
        expect(await observed).toEqual(success ? { value: f.results.create } : { error: failure });
        expect(retired?.records.get("mut-1")?.status).toBe(success ? "confirmed" : "offline");
        expect(f.controller.getSnapshot()).toBe(snapshot);
        expect(listener).not.toHaveBeenCalled();
        expect(Object.values(snapshot.mutationsById)).toEqual([
          expect.objectContaining({ mutationId: "mut-2", status: "pending" })
        ]);
        currentGate.resolve();
        expect(await current).toMatchObject({ body: "current canvas confirmed" });
        expect(f.controller.getSnapshot().mutationsById["mut-2"]?.status).toBe("confirmed");
        await f.activate();
        expect(f.controller.getSnapshot().mutationsById).toEqual({});
      } finally {
        f.controller.dispose();
      }
    });
  }

  it("bounds retired ledger history when more than 256 old canvas writes finish", async () => {
    const f = setup();
    let retired: CollaborationMutationLedger | undefined;
    const original = CollaborationMutationLedger.prototype.setPending;
    vi.spyOn(CollaborationMutationLedger.prototype, "setPending").mockImplementation(function (
      this: CollaborationMutationLedger,
      record
    ) {
      retired = this;
      original.call(this, record);
    });
    try {
      await f.activate();
      const old = Array.from({ length: 257 }, () => f.start("create"));
      expect(retired?.records.size).toBe(257);
      await f.activate(projectA, "profile-A", "canvas-B");
      await f.activate();
      const snapshot = f.controller.getSnapshot();
      f.gate.resolve();
      expect(await Promise.all(old)).toEqual(Array.from({ length: 257 }, () => f.results.create));
      expect(retired?.records.size).toBe(256);
      expect(retired?.records.has("mut-1")).toBe(false);
      expect([...retired!.records.values()].every((record) => record.status === "confirmed")).toBe(
        true
      );
      expect(snapshot.mutationsById).toEqual({});
      expect(f.controller.getSnapshot()).toBe(snapshot);
    } finally {
      f.controller.dispose();
    }
  });

  it.each(kinds)("preserves same-scope %s confirmation and failure feedback", async (kind) => {
    for (const success of [true, false]) {
      const f = setup();
      try {
        await f.activate();
        const pending = f.start(kind);
        if (success) f.gate.resolve();
        else f.gate.reject({ kind: "conflict", code: "revision_conflict", message: "Conflict" });
        expect(await pending).toEqual(success ? f.results[kind] : null);
        expect(Object.values(f.controller.getSnapshot().mutationsById)[0]?.status).toBe(
          success ? "confirmed" : "rejected"
        );
        expect(f.controller.getSnapshot().syncPhase).toBe(success ? "ready" : "stale_conflict");
      } finally {
        f.controller.dispose();
      }
    }
  });

  it.each([
    "responsibility",
    "reviewer"
  ] as const)("isolates %s authority reload already in flight when the scope changes", async (kind) => {
    const f = setup();
    const readGate = deferred();
    try {
      await f.activate();
      vi.mocked(f.api.getCollaborationWorkAuthority).mockImplementationOnce(async () => {
        await readGate.promise;
        return authority(projectA);
      });
      const pending = f.start(kind);
      f.gate.resolve();
      await vi.waitFor(() => expect(f.api.getCollaborationWorkAuthority).toHaveBeenCalledTimes(2));
      await f.activate("project-B");
      const snapshot = f.controller.getSnapshot();
      const listener = vi.fn();
      f.controller.subscribe(listener);
      readGate.resolve();
      expect(await pending).toBe(f.results[kind]);
      expect(f.controller.getSnapshot()).toBe(snapshot);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      readGate.resolve();
      f.controller.dispose();
    }
  });

  it.each([
    "responsibility",
    "reviewer"
  ] as const)("does not start %s authority reload after a confirmation subscriber clears scope", async (kind) => {
    const f = setup();
    try {
      await f.activate();
      f.controller.subscribe((snapshot) => {
        if (Object.values(snapshot.mutationsById).some((record) => record.status === "confirmed"))
          f.controller.clear();
      });
      const reads = vi.mocked(f.api.getCollaborationWorkAuthority).mock.calls.length;
      const pending = f.start(kind);
      f.gate.resolve();
      expect(await pending).toBe(f.results[kind]);
      expect(f.api.getCollaborationWorkAuthority).toHaveBeenCalledTimes(reads);
      expect(f.controller.getSnapshot().projectId).toBeNull();
    } finally {
      f.controller.dispose();
    }
  });

  it("keeps pending mutation valid through same-scope refresh and observer catchup", async () => {
    const f = setup();
    try {
      await f.activate();
      const pending = f.start("create");
      await f.controller.refreshAuthoritative({ reason: "test" });
      f.catchup();
      await f.controller.refreshAuthoritative({ reason: "test" });
      f.gate.resolve();
      expect(await pending).toBe(f.results.create);
      expect(Object.values(f.controller.getSnapshot().mutationsById)[0]?.status).toBe("confirmed");
    } finally {
      f.controller.dispose();
    }
  });
});

it("does not recycle mutation event identity across controller remounts in the same millisecond", async () => {
  const first = setup(true);
  const second = setup(true);
  try {
    await first.activate();
    await second.activate();
    const one = first.start("assignment");
    const two = second.start("assignment");
    const firstRecord = Object.values(first.controller.getSnapshot().mutationsById)[0];
    const secondRecord = Object.values(second.controller.getSnapshot().mutationsById)[0];
    expect(firstRecord.submittedAt).toBe(secondRecord.submittedAt);
    expect(firstRecord.mutationId).not.toBe(secondRecord.mutationId);
    first.gate.resolve();
    second.gate.resolve();
    await Promise.all([one, two]);
    expect(Object.values(first.controller.getSnapshot().mutationsById)[0].mutationId).toBe(
      firstRecord.mutationId
    );
  } finally {
    first.gate.resolve();
    second.gate.resolve();
    first.controller.dispose();
    second.controller.dispose();
  }
});
