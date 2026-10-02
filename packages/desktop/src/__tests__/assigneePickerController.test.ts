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
  const hook = renderHook(() =>
    useAssigneePickerController({
      api: fixture.api,
      workItem: taskItem,
      authorityRole: role,
      detailsOpen: true,
      onAssignmentOutcome: onOutcome
    })
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
