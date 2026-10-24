/* @vitest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkAuthorityProjection } from "@planweave-ai/collaboration-protocol/work/authority";
import { humanObserverEventSchema } from "@planweave-ai/collaboration-protocol/activity/observer";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import { acquireCollaborationReadModelController } from "../renderer/collaboration/collaborationReadModelHub";
import { useAssigneePickerController } from "../renderer/hooks/useAssigneePickerController";
import { workItemKey } from "../shared/collaborationReadModels";
import { createApi, taskItem, blockItem } from "./helpers/assigneePickerControllerFixture";
import {
  collaborationOperationScopeFixture,
  scopedProjectFixture
} from "./helpers/collaborationOperationScopeFixture";

const roles = ["responsibility", "reviewer"] as const;
const principal = { kind: "human", humanPrincipalId: "human-removed" } as const;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

async function fixture(workItem: WorkItemRef, role: (typeof roles)[number], lateEligible = false) {
  const f = createApi();
  const initial = await f.getWorkAuthority({ workItem });
  const originalMemberPage = await f.api.listCollaborationMembers({});
  const member = {
    ...originalMemberPage.items[0]!,
    membershipId: "m-removed",
    humanPrincipalId: principal.humanPrincipalId,
    displayName: "Grace Hopper",
    role: "member" as const
  };
  const eligible = {
    workItem,
    humans: [{ projectId: "project-1", ...member, membershipActive: true }],
    hosts: [],
    nextHumanCursor: null,
    nextHostCursor: null
  };
  let active = true;
  const authority = (available: boolean): WorkAuthorityProjection => ({
    ...initial,
    responsibility: {
      ...initial.responsibility,
      principal,
      revision: 7,
      availability: available ? "active" : "inactive_member"
    },
    reviewer: {
      ...initial.reviewer,
      principal,
      revision: 11,
      availability: available ? "active" : "inactive_member"
    },
    revisions: { ...initial.revisions, responsibilityRevision: 7, reviewerRevision: 11 }
  });
  const members = vi.mocked(f.api.listCollaborationMembers);
  members.mockImplementation(async () => ({
    ...originalMemberPage,
    items: active ? [...originalMemberPage.items, member] : originalMemberPage.items
  }));
  f.getWorkAuthority.mockImplementation(async () => authority(active));
  const eligibleGate = deferred<typeof eligible>();
  f.listEligibleAssignees.mockImplementation(async () =>
    lateEligible ? eligibleGate.promise : eligible
  );
  const shell = acquireCollaborationReadModelController(f.api);
  await shell.controller.setActiveProject(
    scopedProjectFixture({ profileId: "profile-1", projectId: "project-1", canvasId: "canvas-1" })
  );
  const hook = renderHook(() =>
    useAssigneePickerController({ api: f.api, workItem, authorityRole: role, detailsOpen: true })
  );
  await waitFor(() => expect(hook.result.current.viewModel?.current.label).toBe("Grace Hopper"));
  if (!lateEligible) await waitFor(() => expect(hook.result.current.viewModel?.mode).toBe("ready"));
  const emit = (kind: "membership" | "project", cursor = 1) =>
    f.emitObserverSignal({
      type: "human.observer.event",
      profileId: "profile-1",
      projectId: "project-1",
      event: humanObserverEventSchema.parse({
        type: "human.observer.event",
        protocolVersion: 1,
        cursor,
        previousCursor: cursor - 1,
        occurredAt: "2030-01-01T00:00:00.000Z",
        kind,
        humanPrincipalId: principal.humanPrincipalId
      })
    });
  return {
    ...f,
    ...hook,
    shell,
    authority,
    emit,
    members,
    remove: () => {
      active = false;
    },
    finishEligible: () => eligibleGate.resolve(eligible),
    dispose: () => {
      hook.unmount();
      shell.release();
    }
  };
}

const axes = [taskItem, blockItem].flatMap((workItem) => roles.map((role) => ({ workItem, role })));
describe("assignee membership observer invalidation", () => {
  it.each(
    axes.flatMap((axis) =>
      ["membership", "project"].flatMap((event) =>
        [false, true].map((lateEligible) => ({
          ...axis,
          event: event as "membership" | "project",
          lateEligible
        }))
      )
    )
  )("$workItem.kind/$role: $event refreshes unchanged-revision availability (late eligible=$lateEligible)", async ({
    workItem,
    role,
    event,
    lateEligible
  }) => {
    const f = await fixture(workItem, role, lateEligible);
    try {
      act(() => {
        f.remove();
        f.emit(event);
      });
      await waitFor(() => expect(f.shell.controller.getSnapshot().observerCursor).toBe(1));
      await act(async () => {
        f.finishEligible();
      });
      await waitFor(() => expect(f.result.current.viewModel?.mode).toBe("ready"));
      const model = f.result.current.viewModel!;
      expect(model.current).toMatchObject({
        label: principal.humanPrincipalId,
        humanPrincipalId: principal.humanPrincipalId,
        revision: role === "responsibility" ? 7 : 11,
        issueReason: "human_membership_inactive"
      });
      expect(
        model.filteredOptions.find((option) => option.id === `human:${principal.humanPrincipalId}`)
      ).toMatchObject({
        selected: true,
        selectable: false,
        label: principal.humanPrincipalId,
        target: { kind: "human", humanPrincipalId: principal.humanPrincipalId },
        unavailableReason: "human_membership_inactive"
      });
      expect(model.filteredOptions.find((option) => option.id === "human:human-1")).toMatchObject({
        selected: false,
        selectable: true,
        unavailableReason: null
      });
      expect(model.canEdit).toBe(true);
      expect(model.expectedRevision).toBe(role === "responsibility" ? 7 : 11);
      expect(f.result.current.authority?.responsibility).toMatchObject({
        principal,
        revision: 7,
        availability: "inactive_member"
      });
      expect(f.result.current.authority?.reviewer).toMatchObject({
        principal,
        revision: 11,
        availability: "inactive_member"
      });
      expect(f.updateResponsibility).not.toHaveBeenCalled();
      expect(f.api.updateCollaborationReviewer).not.toHaveBeenCalled();
    } finally {
      f.dispose();
    }
  });

  it.each([
    "membership",
    "project"
  ] as const)("does not acknowledge %s until its required authority refresh succeeds", async (event) => {
    const f = await fixture(taskItem, "responsibility");
    try {
      f.getWorkAuthority.mockRejectedValue({
        kind: "server_error",
        code: "membership_authority_failed",
        message: "Unavailable",
        retryable: true
      });
      act(() => {
        f.remove();
        f.emit(event);
      });
      await waitFor(() =>
        expect(f.shell.controller.getSnapshot().lastError?.code).toBe("membership_authority_failed")
      );
      expect(f.shell.controller.getSnapshot().observerCursor).not.toBe(1);
      expect(f.result.current.authority?.responsibility.availability).toBe("active");
      f.getWorkAuthority.mockResolvedValue(f.authority(false));
      act(() => f.emit(event));
      await waitFor(() => expect(f.shell.controller.getSnapshot().observerCursor).toBe(1));
      expect(f.result.current.viewModel?.current.issueReason).toBe("human_membership_inactive");
    } finally {
      f.dispose();
    }
  });

  it("waits for a successor authority read and ignores the retired event response", async () => {
    const f = await fixture(blockItem, "reviewer");
    const old = deferred<WorkAuthorityProjection>();
    const successor = deferred<WorkAuthorityProjection>();
    try {
      f.getWorkAuthority.mockImplementationOnce(() => old.promise);
      const initialReads = f.getWorkAuthority.mock.calls.length;
      act(() => {
        f.remove();
        f.emit("membership");
      });
      await waitFor(() =>
        expect(f.getWorkAuthority.mock.calls.length).toBeGreaterThan(initialReads)
      );
      f.getWorkAuthority.mockImplementationOnce(() => successor.promise);
      let pending!: Promise<unknown>;
      act(() => {
        pending = f.shell.controller.ensureWorkAuthority(blockItem);
      });
      await act(async () => {
        old.resolve(f.authority(true));
      });
      expect(f.shell.controller.getSnapshot().observerCursor).not.toBe(1);
      expect(f.result.current.authority?.reviewer.availability).toBe("active");
      await act(async () => {
        successor.resolve(f.authority(false));
        await pending;
      });
      await waitFor(() => expect(f.shell.controller.getSnapshot().observerCursor).toBe(1));
      expect(f.result.current.authority?.reviewer.availability).toBe("inactive_member");
    } finally {
      old.resolve(f.authority(true));
      successor.resolve(f.authority(false));
      f.dispose();
    }
  });

  it.each([
    "project",
    "connection"
  ] as const)("retires pending member-event authority and eligible reads after a %s switch", async (scope) => {
    const f = await fixture(taskItem, "responsibility", true);
    const old = deferred<WorkAuthorityProjection>();
    try {
      f.getWorkAuthority.mockImplementationOnce(() => old.promise);
      const reads = f.getWorkAuthority.mock.calls.length;
      act(() => {
        f.remove();
        f.emit("membership");
      });
      await waitFor(() => expect(f.getWorkAuthority.mock.calls.length).toBeGreaterThan(reads));
      const projectId = scope === "project" ? "project-B" : "project-1";
      const operationScope = {
        ...collaborationOperationScopeFixture("profile-1", projectId),
        ...(scope === "connection"
          ? {
              serverBaseUrl: "https://other.test/",
              sessionId: "00000000-0000-4000-8000-000000000002"
            }
          : {})
      };
      const replacement = f.authority(true);
      const nextScope = { ...replacement.scope, projectId };
      f.getWorkAuthority.mockResolvedValue({
        ...replacement,
        scope: nextScope,
        responsibility: { ...replacement.responsibility, scope: nextScope },
        reviewer: { ...replacement.reviewer, scope: nextScope }
      });
      f.members.mockResolvedValue({ items: [], nextCursor: null });
      f.listEligibleAssignees.mockResolvedValue({
        workItem: taskItem,
        humans: [],
        hosts: [],
        nextHumanCursor: null,
        nextHostCursor: null
      });
      await act(async () => {
        if (scope === "project") f.changeStatus(projectId);
        else f.changeConnection("server");
        await f.shell.controller.setActiveProject({
          profileId: "profile-1",
          projectId,
          operationScope,
          canvasId: "canvas-1"
        });
      });
      await waitFor(() => expect(f.result.current.authority).not.toBeNull());
      await act(async () => {
        old.resolve(f.authority(false));
        f.finishEligible();
      });
      expect(f.shell.controller.getSnapshot().projectId).toBe(projectId);
      expect(f.shell.controller.getSnapshot().observerCursor).not.toBe(1);
      expect(
        f.shell.controller.getSnapshot().workAuthorityByWorkItem[workItemKey(taskItem)]
          ?.responsibility.availability
      ).toBe("active");
      expect(f.result.current.viewModel?.current.issueReason).toBeNull();
      expect(
        f.result.current.viewModel?.filteredOptions.some(
          (option) => option.label === "Grace Hopper"
        )
      ).toBe(false);
    } finally {
      old.resolve(f.authority(false));
      f.finishEligible();
      f.dispose();
    }
  });
});
