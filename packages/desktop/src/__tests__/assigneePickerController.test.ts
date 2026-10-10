/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  acquireCollaborationReadModelController,
  resetCollaborationReadModelHubForTests
} from "../renderer/collaboration/collaborationReadModelHub";
import type { CollaborationReadBridgePort } from "../renderer/collaboration/CollaborationReadModelController";
import { useAssigneePickerController } from "../renderer/hooks/useAssigneePickerController";
import type { CollaborationStatus, PlanWeaveCollaborationApi } from "../shared/collaboration";
import { createTranslator } from "../renderer/i18n";
import { workItemKey } from "../shared/collaborationReadModels";

const taskItem: WorkItemRef = { kind: "task", canvasId: "canvas-1", taskId: "T-1" };
const blockItem: WorkItemRef = { kind: "block", canvasId: "canvas-1", blockRef: "T-1#B-001" };
function connectedStatus(): CollaborationStatus {
  return {
    profiles: [
      {
        profileId: "profile-1",
        displayName: "Demo",
        serverBaseUrl: "https://example.test",
        projectId: "project-1",
        allowInsecureTransport: false,
        hasDeviceCredential: true,
        deviceCredentialPersistence: "persisted",
        deviceCredentialId: "device-1",
        humanPrincipalId: "human-1",
        updatedAt: "2030-01-01T00:00:00.000Z"
      }
    ],
    activeProfileId: "profile-1",
    credentialStorage: "available",
    nonPersistenceWarning: null,
    session: {
      phase: "connected",
      activeProfileId: "profile-1",
      detail: null,
      lastErrorCode: null,
      lastErrorMessage: null
    },
    updatedAt: "2030-01-01T00:00:00.000Z",
    workspaceConnection: {
      schemaVersion: "workspace-setup/v1",
      status: "local_only",
      profile: null,
      workspaceId: null,
      workspaceDisplayName: null,
      connectedAt: null,
      error: null
    },
    workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null }
  };
}

function createApi() {
  let status = connectedStatus();
  const statusListeners = new Set<(status: CollaborationStatus) => void>();
  const updateResponsibility = vi.fn().mockResolvedValue({
    schemaVersion: "responsibility/v1",
    scope: {
      kind: "task",
      workspaceId: "w",
      projectId: "project-1",
      canvasId: "canvas-1",
      taskId: "T-1"
    },
    principal: { kind: "human", humanPrincipalId: "human-1" },
    revision: 1,
    updatedAt: "2030-01-01T00:00:00.000Z",
    availability: "active"
  });
  const getWorkAuthority = vi
    .fn()
    .mockImplementation(async ({ workItem }: { workItem: WorkItemRef }) => {
      const scope =
        workItem.kind === "task"
          ? {
              kind: "task" as const,
              workspaceId: "w",
              projectId: status.profiles[0]!.projectId,
              canvasId: workItem.canvasId,
              taskId: workItem.taskId
            }
          : {
              kind: "block" as const,
              workspaceId: "w",
              projectId: status.profiles[0]!.projectId,
              canvasId: workItem.canvasId,
              blockRef: workItem.blockRef
            };
      return {
        schemaVersion: "work-authority/v1",
        scope,
        responsibility: {
          schemaVersion: "responsibility/v1",
          scope,
          principal: null,
          revision: 0,
          updatedAt: "2030-01-01T00:00:00.000Z",
          availability: "unassigned"
        },
        reviewer: {
          schemaVersion: "review-assignment/v1",
          scope,
          principal: null,
          revision: 0,
          updatedAt: "2030-01-01T00:00:00.000Z",
          availability: "unassigned"
        },
        executionTarget:
          workItem.kind === "block"
            ? {
                schemaVersion: "execution-target/v1",
                scope,
                target: { kind: "unassigned" },
                revision: 0,
                updatedAt: "2030-01-01T00:00:00.000Z",
                availability: { status: "unassigned", reason: "unassigned" }
              }
            : null,
        revisions: {
          responsibilityRevision: 0,
          reviewerRevision: 0,
          executionTargetRevision: 0
        },
        selectedHost: null,
        evaluatedAt: "2030-01-01T00:00:00.000Z"
      };
    });
  const listEligibleAssignees = vi.fn(async ({ workItem }: { workItem: WorkItemRef }) => ({
    workItem,
    humans: [],
    hosts:
      workItem.kind === "block"
        ? [
            {
              projectId: "project-1",
              hostId: "host-1",
              displayName: "Builder",
              exists: true,
              revoked: false,
              authorizedForProject: true,
              online: true,
              capabilities: ["acp.codex"],
              capacityRemaining: 1
            },
            ...(workItem.blockRef === secondBlockItem.blockRef
              ? []
              : [
                  {
                    projectId: "project-1",
                    hostId: "host-only-first",
                    displayName: "First only",
                    exists: true,
                    revoked: false,
                    authorizedForProject: true,
                    online: true,
                    capabilities: ["acp.codex"],
                    capacityRemaining: 1
                  }
                ])
          ]
        : [],
    nextHumanCursor: null,
    nextHostCursor: null
  }));
  const dispatchRemoteOperation = vi.fn().mockResolvedValue({ operationId: "operation-1" });
  const api = {
    getCollaborationStatus: vi.fn(async () => status),
    listCollaborationMembers: vi.fn().mockResolvedValue({
      items: [
        {
          membershipId: "m-1",
          projectId: "project-1",
          humanPrincipalId: "human-1",
          displayName: "Ada",
          role: "owner",
          createdAt: "2030-01-01T00:00:00.000Z",
          updatedAt: "2030-01-01T00:00:00.000Z"
        }
      ],
      nextCursor: null
    }),
    listCollaborationAssignments: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listCollaborationEligibleAssignees: listEligibleAssignees,
    getCollaborationWorkAuthority: getWorkAuthority,
    updateCollaborationResponsibility: updateResponsibility,
    updateCollaborationReviewer: vi.fn(),
    listCollaborationComments: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listCollaborationActivity: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    updateCollaborationAssignment: vi.fn(),
    createCollaborationComment: vi.fn(),
    editCollaborationComment: vi.fn(),
    tombstoneCollaborationComment: vi.fn(),
    dispatchCollaborationRemoteOperation: dispatchRemoteOperation,
    onCollaborationStatusChanged: vi.fn((listener: (next: CollaborationStatus) => void) => {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    }),
    onCollaborationObserverSignal: vi.fn(() => () => undefined)
  } as unknown as PlanWeaveCollaborationApi & CollaborationReadBridgePort;
  return {
    api,
    updateResponsibility,
    listEligibleAssignees,
    dispatchRemoteOperation,
    getWorkAuthority,
    changeConnection: (kind: "workspace" | "server") => {
      status = {
        ...status,
        profiles: status.profiles.map((profile) => ({
          ...profile,
          ...(kind === "server" ? { serverBaseUrl: "https://other.test" } : {})
        })),
        workspaceConnection: {
          ...status.workspaceConnection,
          ...(kind === "workspace" ? { workspaceId: "workspace-B" } : {})
        }
      };
      for (const listener of statusListeners) listener(status);
    },
    changeStatus: (projectId: string | null, profileId = "profile-1") => {
      status = connectedStatus();
      if (projectId === null) {
        status.activeProfileId = null;
        status.session.activeProfileId = null;
        status.session.phase = "idle";
      } else {
        status.activeProfileId = profileId;
        status.session.activeProfileId = profileId;
        status.profiles[0] = { ...status.profiles[0]!, projectId, profileId };
      }
      for (const listener of statusListeners) listener(status);
    }
  };
}

afterEach(() => {
  resetCollaborationReadModelHubForTests();
  vi.restoreAllMocks();
});

describe("useAssigneePickerController", () => {
  it("hard-rejects Host targets on the responsibility axis without calling Host mutation", async () => {
    const { api, updateResponsibility } = createApi();
    const shell = acquireCollaborationReadModelController(api);
    await shell.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "canvas-1"
    });

    const { result } = renderHook(() =>
      useAssigneePickerController({
        workItem: taskItem,
        authorityRole: "responsibility",
        api,
        detailsOpen: false,
        t: createTranslator("zh-CN")
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel).not.toBeNull();
    });

    let ok = true;
    await act(async () => {
      ok = await result.current.selectTarget({ kind: "automatic_host" });
    });
    expect(ok).toBe(false);
    expect(updateResponsibility).not.toHaveBeenCalled();
    expect(result.current.viewModel?.lastError).toBe("Task 不能分配给 Agent Host。");

    await act(async () => {
      ok = await result.current.selectTarget({
        kind: "exact_host",
        hostId: "host-1"
      });
    });
    expect(ok).toBe(false);

    shell.release();
    resetCollaborationReadModelHubForTests(api);
  });

  it("does not expose a Host authority axis for Blocks", async () => {
    const { api, updateResponsibility } = createApi();
    const shell = acquireCollaborationReadModelController(api);
    await shell.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "canvas-1"
    });

    const { result } = renderHook(() =>
      useAssigneePickerController({
        workItem: blockItem,
        api,
        detailsOpen: true,
        t: createTranslator("en")
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel).not.toBeNull();
    });

    expect(result.current.viewModel?.sections.some((section) => section.id === "hosts")).toBe(
      false
    );
    expect(result.current.authorityRole).toBe("responsibility");
    expect(updateResponsibility).not.toHaveBeenCalled();

    shell.release();
    resetCollaborationReadModelHubForTests(api);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const chosenTarget = { kind: "human", humanPrincipalId: "human-new" } as const;
const roles = ["responsibility", "reviewer"] as const;

async function scopedPicker(role: (typeof roles)[number]) {
  const fixture = createApi();
  const shell = acquireCollaborationReadModelController(fixture.api);
  await shell.controller.setActiveProject({
    profileId: "profile-1",
    projectId: "project-1",
    canvasId: "canvas-1"
  });
  const onOutcome = vi.fn();
  const hook = renderHook(
    ({
      workItem,
      authorityRole
    }: {
      workItem: WorkItemRef;
      authorityRole: (typeof roles)[number];
    }) =>
      useAssigneePickerController({
        api: fixture.api,
        workItem,
        authorityRole,
        detailsOpen: true,
        onAssignmentOutcome: onOutcome
      }),
    { initialProps: { workItem: taskItem, authorityRole: role } }
  );
  await waitFor(() => expect(hook.result.current.authority).not.toBeNull());
  await waitFor(() => expect(hook.result.current.viewModel?.mode).not.toBe("loading"));
  const mutation =
    role === "responsibility"
      ? fixture.updateResponsibility
      : vi.mocked(fixture.api.updateCollaborationReviewer);
  const projection =
    role === "responsibility"
      ? hook.result.current.authority!.responsibility
      : hook.result.current.authority!.reviewer;
  const success = {
    ...projection,
    principal: { kind: "human" as const, humanPrincipalId: "human-new" },
    revision: 1,
    availability: "active" as const
  };
  const transition = async (projectId: string | null, profileId = "profile-1") => {
    await act(async () => {
      fixture.changeStatus(projectId, profileId);
      if (projectId === null) shell.controller.clear();
      else await shell.controller.setActiveProject({ profileId, projectId, canvasId: "canvas-1" });
    });
    await waitFor(() => expect(hook.result.current.viewModel?.mode).not.toBe("loading"));
  };
  return { ...fixture, ...hook, shell, onOutcome, mutation, success, transition };
}

describe("assignee picker original mutation scope", () => {
  for (const role of roles) {
    it.each([
      true,
      false
    ])(`${role}: old A completion cannot publish B error/busy/outcome or reload (success=%s)`, async (success) => {
      const f = await scopedPicker(role);
      const old = deferred<typeof f.success>();
      const current = deferred<typeof f.success>();
      f.mutation.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
      let pendingA!: Promise<boolean>;
      act(() => {
        pendingA = f.result.current.selectTarget(chosenTarget);
      });
      await f.transition("project-B");
      let pendingB!: Promise<boolean>;
      act(() => {
        pendingB = f.result.current.selectTarget(chosenTarget);
      });
      expect(f.result.current.viewModel?.pending).toBe(true);
      const reads = f.listEligibleAssignees.mock.calls.length;
      const authorityReads = f.getWorkAuthority.mock.calls.length;
      await act(async () => {
        if (success) old.resolve(f.success);
        else
          old.reject({ kind: "offline", code: "A_failed", message: "A failed", retryable: true });
        expect(await pendingA).toBe(success);
      });
      expect(f.result.current.viewModel?.pending).toBe(true);
      expect(f.result.current.viewModel?.lastError).toBeNull();
      expect(f.onOutcome).not.toHaveBeenCalled();
      expect(f.listEligibleAssignees).toHaveBeenCalledTimes(reads);
      expect(f.getWorkAuthority).toHaveBeenCalledTimes(authorityReads);
      await act(async () => {
        current.resolve({ ...f.success, scope: { ...f.success.scope, projectId: "project-B" } });
        expect(await pendingB).toBe(true);
      });
      expect(f.onOutcome).toHaveBeenCalledTimes(1);
      f.unmount();
      f.shell.release();
    });

    it.each([
      "ABA",
      "profile",
      "logout",
      "unmount"
    ])(`${role}: retires mutation after %s`, async (transition) => {
      const f = await scopedPicker(role);
      const gate = deferred<typeof f.success>();
      f.mutation.mockReturnValueOnce(gate.promise);
      let pending!: Promise<boolean>;
      act(() => {
        pending = f.result.current.selectTarget(chosenTarget);
      });
      if (transition === "ABA") {
        await f.transition("project-B");
        await f.transition("project-1");
      }
      if (transition === "profile") await f.transition("project-1", "profile-B");
      if (transition === "logout") await f.transition(null);
      if (transition === "unmount") f.unmount();
      const reads = f.listEligibleAssignees.mock.calls.length;
      await act(async () => {
        gate.resolve(f.success);
        expect(await pending).toBe(true);
      });
      expect(f.onOutcome).not.toHaveBeenCalled();
      expect(f.listEligibleAssignees).toHaveBeenCalledTimes(reads);
      f.unmount();
      f.shell.release();
    });

    it.each([
      "eligible",
      "conflict reload"
    ])(`${role}: fences second await during %s`, async (stage) => {
      const f = await scopedPicker(role);
      const gate = deferred<void>();
      if (stage === "eligible") {
        f.mutation.mockResolvedValueOnce(f.success);
        f.listEligibleAssignees.mockImplementationOnce(async () => {
          await gate.promise;
          return {
            workItem: taskItem,
            humans: [],
            hosts: [],
            nextHumanCursor: null,
            nextHostCursor: null
          };
        });
      } else {
        f.mutation.mockRejectedValueOnce({
          kind: "conflict",
          code: "revision_conflict",
          message: "Conflict",
          retryable: true
        });
        f.getWorkAuthority.mockImplementationOnce(async () => {
          await gate.promise;
          return f.result.current.authority;
        });
      }
      const expectedReads =
        (stage === "eligible" ? f.listEligibleAssignees : f.getWorkAuthority).mock.calls.length + 1;
      let pending!: Promise<boolean>;
      act(() => {
        pending = f.result.current.selectTarget(chosenTarget);
      });
      await waitFor(() =>
        expect(
          stage === "eligible" ? f.listEligibleAssignees : f.getWorkAuthority
        ).toHaveBeenCalledTimes(expectedReads)
      );
      await f.transition("project-B");
      f.onOutcome.mockClear();
      await act(async () => {
        gate.resolve();
        expect(await pending).toBe(stage === "eligible");
      });
      expect(f.onOutcome).not.toHaveBeenCalled();
      expect(f.result.current.viewModel?.lastError).toBeNull();
      f.unmount();
      f.shell.release();
    });

    it.each([
      "success",
      "conflict",
      "offline"
    ])(`${role}: preserves same-scope %s feedback`, async (outcome) => {
      const f = await scopedPicker(role);
      const gate = deferred<typeof f.success>();
      f.mutation.mockReturnValueOnce(gate.promise);
      let pending!: Promise<boolean>;
      act(() => {
        pending = f.result.current.selectTarget(chosenTarget);
      });
      await act(async () => {
        await f.result.current.refresh();
      });
      await act(async () => {
        if (outcome === "success") gate.resolve(f.success);
        else gate.reject({ kind: outcome, code: outcome, message: outcome, retryable: true });
        expect(await pending).toBe(outcome === "success");
      });
      expect(f.result.current.viewModel?.pending).toBe(false);
      expect(f.onOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ ok: outcome === "success" })
      );
      if (outcome !== "success") expect(f.result.current.viewModel?.lastError).toBeTruthy();
      f.unmount();
      f.shell.release();
    });
  }
});

describe("assignee picker explicit retry authority", () => {
  for (const role of roles) {
    it.each([
      "success",
      "failure",
      "retired"
    ])(`${role}: retry awaits aggregate authority successor (%s)`, async (outcome) => {
      const f = await scopedPicker(role);
      const other = role === "responsibility" ? "reviewer" : "responsibility";
      let authority = {
        ...f.result.current.authority!,
        [role]: { ...f.result.current.authority![role], revision: 2 },
        [other]: { ...f.result.current.authority![other], revision: 17 }
      };
      f.getWorkAuthority.mockImplementation(async () => authority);
      await act(async () => {
        await f.result.current.refresh();
      });
      f.mutation.mockRejectedValueOnce({
        kind: "conflict",
        code: "revision_conflict",
        message: "Conflict",
        retryable: true
      });
      await act(async () => {
        expect(await f.result.current.selectTarget(chosenTarget)).toBe(false);
      });
      const old = deferred<typeof authority>();
      const successor = deferred<typeof authority>();
      const started = deferred<void>();
      const oldAuthority = authority;
      f.getWorkAuthority
        .mockImplementationOnce(async () => oldAuthority)
        .mockImplementationOnce(() => {
          started.resolve();
          return old.promise;
        });
      f.mutation.mockImplementation(async (input) => {
        authority = {
          ...authority,
          [role]: {
            ...authority[role],
            principal: input.principal,
            revision: 4,
            availability: "active"
          }
        };
        return authority[role];
      });
      let retry!: Promise<boolean>;
      let retryFinished = false;
      let replacement!: Promise<unknown>;
      const error = {
        kind: "offline",
        code: "successor_failed",
        message: "Successor failed",
        retryable: true
      };
      try {
        act(() => {
          retry = f.result.current.retryLastTarget().then((result) => {
            retryFinished = true;
            return result;
          });
        });
        await started.promise;
        f.getWorkAuthority.mockReturnValueOnce(successor.promise);
        act(() => {
          replacement = f.shell.controller.ensureWorkAuthority(taskItem).catch((reason) => reason);
        });
        await act(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        });
        const callsBeforeSuccessor = f.mutation.mock.calls.length;
        authority = { ...authority, [role]: { ...authority[role], revision: 3 } };
        await act(async () => {
          if (outcome === "retired") f.shell.controller.clear();
          if (outcome === "failure") successor.reject(error);
          else successor.resolve(authority);
          await replacement;
          await vi.waitFor(() => expect(retryFinished).toBe(true));
          expect(await retry).toBe(outcome === "success");
        });
        expect(callsBeforeSuccessor).toBe(1);
        expect(f.mutation.mock.calls.map(([input]) => input.expectedRevision)).toEqual(
          outcome === "success" ? [2, 3] : [2]
        );
        if (outcome !== "retired") expect(f.result.current.authority?.[other].revision).toBe(17);
        expect(f.result.current.viewModel?.pending).toBe(false);
        expect(f.shell.controller.getSnapshot().loadingKinds).toEqual([]);
        if (outcome === "failure") expect(f.result.current.viewModel?.lastError).toBeTruthy();
      } finally {
        old.resolve(oldAuthority);
        successor.resolve(authority);
        f.unmount();
        f.shell.release();
      }
    });

    it(`${role}: ignores older authority completing while retry waits for eligible targets`, async () => {
      const f = await scopedPicker(role);
      const other = role === "responsibility" ? "reviewer" : "responsibility";
      let authority = {
        ...f.result.current.authority!,
        [role]: { ...f.result.current.authority![role], revision: 2 },
        [other]: { ...f.result.current.authority![other], revision: 17 }
      };
      f.getWorkAuthority.mockImplementation(async () => authority);
      await act(async () => {
        await f.result.current.refresh();
      });
      f.mutation.mockRejectedValueOnce({
        kind: "conflict",
        code: "revision_conflict",
        message: "Conflict",
        retryable: true
      });
      await act(async () => {
        expect(await f.result.current.selectTarget(chosenTarget)).toBe(false);
      });
      const oldAuthority = authority;
      const old = deferred<typeof authority>();
      f.getWorkAuthority.mockImplementationOnce(() => old.promise);
      let oldRead!: Promise<unknown>;
      act(() => {
        oldRead = f.shell.controller.ensureWorkAuthority(taskItem);
      });
      authority = { ...authority, [role]: { ...authority[role], revision: 3 } };
      const eligiblePage = await f.listEligibleAssignees({ workItem: taskItem });
      const eligible = deferred<typeof eligiblePage>();
      f.listEligibleAssignees.mockImplementationOnce(() => eligible.promise);
      const eligibleReads = f.listEligibleAssignees.mock.calls.length;
      f.mutation.mockImplementation(async (input) => {
        if (input.expectedRevision !== 3)
          throw {
            kind: "conflict",
            code: "revision_conflict",
            message: "Conflict",
            retryable: true
          };
        authority = {
          ...authority,
          [role]: {
            ...authority[role],
            principal: input.principal,
            revision: 4,
            availability: "active"
          }
        };
        return authority[role];
      });
      let pending!: Promise<boolean>;
      act(() => {
        pending = f.result.current.retryLastTarget();
      });
      await waitFor(() => expect(f.listEligibleAssignees).toHaveBeenCalledTimes(eligibleReads + 1));
      expect(f.result.current.authority?.[role].revision).toBe(3);
      expect(f.result.current.viewModel?.pending).toBe(true);
      await act(async () => {
        old.resolve(oldAuthority);
        await oldRead;
      });
      const revisionAfterOldRead =
        f.shell.controller.getSnapshot().workAuthorityByWorkItem[workItemKey(taskItem)]?.[role]
          .revision;
      await act(async () => {
        eligible.resolve(eligiblePage);
        await pending;
      });
      expect(revisionAfterOldRead).toBe(3);
      expect(await pending).toBe(true);
      expect(f.mutation.mock.calls.map(([input]) => input.expectedRevision)).toEqual([2, 3]);
      expect(f.result.current.authority?.[role].revision).toBe(4);
      expect(f.result.current.authority?.[other].revision).toBe(17);
      expect(f.result.current.viewModel?.pending).toBe(false);
      expect(f.shell.controller.getSnapshot().loadingKinds).toEqual([]);
      f.unmount();
      f.shell.release();
    });
    it.each([
      "success",
      "same target",
      "second conflict",
      "refresh failure"
    ])(`${role}: retries with latest role authority (%s)`, async (scenario) => {
      const f = await scopedPicker(role);
      let authority = { ...f.result.current.authority! };
      const other = role === "responsibility" ? "reviewer" : "responsibility";
      authority = {
        ...authority,
        [role]: { ...authority[role], revision: 2 },
        [other]: { ...authority[other], revision: 17 }
      };
      f.getWorkAuthority.mockImplementation(async () => authority);
      await act(async () => {
        await f.result.current.refresh();
      });
      const payloads: number[] = [];
      f.mutation.mockImplementation(async (input) => {
        payloads.push(input.expectedRevision);
        if (input.expectedRevision !== authority[role].revision)
          throw {
            kind: "conflict",
            code: "revision_conflict",
            message: "Conflict",
            retryable: true
          };
        authority = {
          ...authority,
          [role]: {
            ...authority[role],
            revision: input.expectedRevision + 1,
            principal: input.principal,
            availability: "active"
          }
        };
        return authority[role];
      });
      authority = { ...authority, [role]: { ...authority[role], revision: 3 } };
      await act(async () => {
        expect(await f.result.current.selectTarget(chosenTarget)).toBe(false);
      });
      // Retain the revision=2 render and its retry callback while refreshing to 3.
      authority = { ...authority, [role]: { ...authority[role], revision: 2 } };
      await act(async () => {
        await f.result.current.refresh();
      });
      const retry = f.result.current.retryLastTarget;
      authority = {
        ...authority,
        [role]: {
          ...authority[role],
          revision: 3,
          principal:
            scenario === "same target" ? { kind: "human", humanPrincipalId: "human-new" } : null
        }
      };
      const gate = deferred<typeof authority>();
      f.getWorkAuthority.mockImplementationOnce(() => gate.promise);
      if (scenario === "second conflict") {
        f.mutation.mockImplementationOnce(async (input) => {
          payloads.push(input.expectedRevision);
          authority = { ...authority, [role]: { ...authority[role], revision: 4 } };
          throw {
            kind: "conflict",
            code: "revision_conflict",
            message: "Conflict",
            retryable: true
          };
        });
      }
      let pending!: Promise<boolean>;
      act(() => {
        pending = retry();
      });
      await act(async () => {
        if (scenario === "refresh failure") gate.reject(new Error("refresh failed"));
        else gate.resolve(authority);
        expect(await pending).toBe(scenario === "success" || scenario === "same target");
      });
      expect(payloads).toEqual(
        scenario === "success" || scenario === "second conflict" ? [2, 3] : [2]
      );
      expect(f.result.current.authority?.[role].revision).toBe(
        scenario === "success" || scenario === "second conflict"
          ? 4
          : scenario === "refresh failure"
            ? 2
            : 3
      );
      expect(f.result.current.authority?.[other].revision).toBe(17);
      if (scenario === "second conflict" || scenario === "refresh failure")
        expect(f.result.current.viewModel?.lastError).toBeTruthy();
      f.unmount();
      f.shell.release();
    });
  }
});

describe("assignee picker retry lifecycle", () => {
  for (const role of roles) {
    it(`${role}: rejects selection before authority loads instead of submitting revision zero`, async () => {
      const f = createApi();
      const initialAuthority = await f.getWorkAuthority({ workItem: taskItem });
      const gate = deferred<typeof initialAuthority>();
      f.getWorkAuthority.mockImplementation(() => gate.promise);
      const shell = acquireCollaborationReadModelController(f.api);
      await shell.controller.setActiveProject({
        profileId: "profile-1",
        projectId: "project-1",
        canvasId: "canvas-1"
      });
      const hook = renderHook(() =>
        useAssigneePickerController({ api: f.api, workItem: taskItem, authorityRole: role })
      );
      await waitFor(() => expect(hook.result.current.viewModel).not.toBeNull());
      await act(async () => {
        expect(await hook.result.current.selectTarget(chosenTarget)).toBe(false);
      });
      expect(f.updateResponsibility).not.toHaveBeenCalled();
      expect(f.api.updateCollaborationReviewer).not.toHaveBeenCalled();
      expect(hook.result.current.authority).toBeNull();
      expect(hook.result.current.viewModel?.lastError).toBe("assignment_authority_unavailable");
      await act(async () => {
        gate.resolve(initialAuthority);
      });
      hook.unmount();
      shell.release();
    });
    it.each([
      "project",
      "profile",
      "workspace",
      "server",
      "workItem",
      "role",
      "disconnect"
    ] as const)(`${role}: does not write after retry refresh crosses %s`, async (scope) => {
      const f = await scopedPicker(role);
      f.mutation.mockRejectedValueOnce({
        kind: "conflict",
        code: "revision_conflict",
        message: "Conflict",
        retryable: true
      });
      await act(async () => {
        expect(await f.result.current.selectTarget(chosenTarget)).toBe(false);
      });
      const oldAuthority = f.result.current.authority!;
      const gate = deferred<typeof oldAuthority>();
      f.getWorkAuthority.mockImplementationOnce(() => gate.promise);
      const retry = f.result.current.retryLastTarget;
      let pending!: Promise<boolean>;
      act(() => {
        pending = retry();
      });
      if (scope === "project") await f.transition("project-B");
      if (scope === "profile") await f.transition("project-1", "profile-B");
      if (scope === "disconnect") await f.transition(null);
      if (scope === "workspace" || scope === "server")
        act(() => {
          f.changeConnection(scope);
        });
      if (scope === "workItem") f.rerender({ workItem: blockItem, authorityRole: role });
      if (scope === "role")
        f.rerender({
          workItem: taskItem,
          authorityRole: role === "responsibility" ? "reviewer" : "responsibility"
        });
      f.onOutcome.mockClear();
      await act(async () => {
        gate.resolve(oldAuthority);
        expect(await pending).toBe(false);
      });
      expect(f.mutation).toHaveBeenCalledTimes(1);
      expect(f.onOutcome).not.toHaveBeenCalled();
      expect(f.result.current.viewModel?.pending).toBe(false);
      f.unmount();
      f.shell.release();
    });

    it(`${role}: reserves pending across retry refresh and releases it for the next operation`, async () => {
      const f = await scopedPicker(role);
      f.mutation.mockRejectedValueOnce({
        kind: "conflict",
        code: "revision_conflict",
        message: "Conflict",
        retryable: true
      });
      await act(async () => {
        await f.result.current.selectTarget(chosenTarget);
      });
      const gate = deferred<NonNullable<typeof f.result.current.authority>>();
      f.getWorkAuthority.mockImplementationOnce(() => gate.promise);
      f.mutation.mockResolvedValue(f.success);
      const retry = f.result.current.retryLastTarget;
      let pending!: Promise<boolean>;
      act(() => {
        pending = retry();
      });
      await act(async () => {
        expect(await retry()).toBe(false);
        expect(await f.result.current.selectTarget(chosenTarget)).toBe(false);
      });
      expect(f.result.current.viewModel?.pending).toBe(true);
      await act(async () => {
        gate.resolve(f.result.current.authority!);
        expect(await pending).toBe(true);
      });
      expect(f.mutation).toHaveBeenCalledTimes(2);
      expect(f.result.current.viewModel?.pending).toBe(false);
      await act(async () => {
        expect(await f.result.current.selectTarget(chosenTarget)).toBe(true);
      });
      expect(f.mutation).toHaveBeenCalledTimes(3);
      f.unmount();
      f.shell.release();
    });
  }
});
