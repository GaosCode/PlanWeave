import {
  collaborationOperationScopeFixture,
  scopedProjectFixture
} from "./helpers/collaborationOperationScopeFixture";
import { resolveCollaborationSurfaceReadBinding } from "../renderer/hooks/useCollaborationSurface";
/* @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollaborationStatus, PlanWeaveCollaborationApi } from "../shared/collaboration";
import { toCollaborationReadBridge } from "../renderer/collaboration/collaborationReadBridge";
import { useCollaborationReadModels } from "../renderer/hooks/useCollaborationReadModels";
import {
  acquireCollaborationReadModelController,
  resetCollaborationReadModelHubForTests
} from "../renderer/collaboration/collaborationReadModelHub";
import type { CollaborationObserverSignal } from "../shared/collaborationReadModels";
import type {
  WorkspaceConnectionMemberView,
  WorkspaceConnectionSelfView,
  WorkspaceConnectionMembersPage
} from "@planweave-ai/collaboration-protocol/connection";
import { usePeoplePanelController } from "../renderer/hooks/usePeoplePanelController";

afterEach(() => {
  cleanup();
  resetCollaborationReadModelHubForTests();
});

it("loads Workspace identity and members without requesting project identity endpoints", async () => {
  const status: CollaborationStatus = {
    profiles: [],
    activeProfileId: null,
    credentialStorage: "available",
    nonPersistenceWarning: null,
    updatedAt: "2030-01-01T00:00:00.000Z",
    session: {
      operationScope: null,
      phase: "idle",
      activeProfileId: null,
      detail: null,
      lastErrorCode: null,
      lastErrorMessage: null
    },
    workspaceConnection: {
      schemaVersion: "workspace-setup/v1",
      status: "connected",
      profile: null,
      workspaceId: "workspace-one",
      workspaceDisplayName: "Team",
      connectedAt: "2030-01-01T00:00:00.000Z",
      error: null
    },
    workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null }
  };
  const self = {
    schemaVersion: "workspace-setup/v1",
    workspaceId: "workspace-one",
    membershipId: "member-one",
    humanPrincipalId: "human-one",
    displayName: "Win",
    role: "member",
    deviceSessionId: "device-one"
  };
  const members = [
    {
      schemaVersion: "workspace-setup/v1",
      membershipId: self.membershipId,
      humanPrincipalId: self.humanPrincipalId,
      displayName: self.displayName,
      role: self.role,
      devices: []
    }
  ];
  const legacyMembers = vi.fn().mockRejectedValue(new Error("human_auth_unauthenticated"));
  const legacyDevices = vi.fn().mockRejectedValue(new Error("human_auth_unauthenticated"));
  const legacyInvitations = vi.fn().mockRejectedValue(new Error("human_auth_unauthenticated"));
  const api = {
    getCollaborationStatus: vi.fn().mockResolvedValue(status),
    getWorkspaceConnectionSelf: vi.fn().mockResolvedValue(self),
    listWorkspaceConnectionMembers: vi.fn().mockResolvedValue({ items: members, nextCursor: null }),
    listCollaborationMembers: legacyMembers,
    listCollaborationDevices: legacyDevices,
    listCollaborationInvitations: legacyInvitations
  } as PlanWeaveCollaborationApi;
  const { result } = renderHook(() =>
    usePeoplePanelController({
      api,
      status,
      members: [],
      hosts: [],
      syncPhase: "ready",
      detailsOpen: true
    })
  );
  await waitFor(() => expect(result.current.members).toHaveLength(1));
  await waitFor(() => expect(result.current.detailsLoading).toBe(false));
  expect(result.current.detailsError).toBeNull();
  expect(result.current.identity?.displayName).toBe("Win");
  const readBridge = toCollaborationReadBridge(api)!;
  await expect(readBridge.listCollaborationMembers({ cursor: 0, limit: 100 })).resolves.toEqual({
    items: members,
    nextCursor: null
  });
  expect(legacyMembers).not.toHaveBeenCalled();
  expect(legacyDevices).not.toHaveBeenCalled();
  expect(legacyInvitations).not.toHaveBeenCalled();
  vi.mocked(api.listWorkspaceConnectionMembers).mockRejectedValueOnce(
    new Error("workspace_members_unavailable")
  );
  await expect(readBridge.listCollaborationMembers({ cursor: 0, limit: 100 })).rejects.toThrow(
    "workspace_members_unavailable"
  );
  expect(legacyMembers).not.toHaveBeenCalled();
  vi.mocked(api.getCollaborationStatus).mockResolvedValue({
    ...status,
    workspaceConnection: { ...status.workspaceConnection, status: "local_only" }
  });
  await expect(readBridge.listCollaborationMembers({ cursor: 0, limit: 100 })).rejects.toThrow(
    "human_auth_unauthenticated"
  );
  expect(legacyMembers).toHaveBeenCalledTimes(1);
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

function workspaceStatus(workspaceId = "workspace-one"): CollaborationStatus {
  return {
    profiles: [
      {
        profileId: "profile-one",
        displayName: "Team",
        serverBaseUrl: "https://example.test",
        projectId: "project-one",
        allowInsecureTransport: false,
        hasDeviceCredential: true,
        deviceCredentialPersistence: "persisted",
        deviceCredentialId: "device-one",
        humanPrincipalId: "human-one",
        updatedAt: "2030-01-01T00:00:00.000Z"
      }
    ],
    activeProfileId: "profile-one",
    credentialStorage: "available",
    nonPersistenceWarning: null,
    updatedAt: "2030-01-01T00:00:00.000Z",
    session: {
      operationScope: collaborationOperationScopeFixture("profile-one", "project-one"),
      phase: "connected",
      activeProfileId: "profile-one",
      detail: null,
      lastErrorCode: null,
      lastErrorMessage: null
    },
    workspaceConnection: {
      schemaVersion: "workspace-setup/v1",
      status: "connected",
      profile: {
        schemaVersion: "workspace-identity/v1",
        profileId: "profile-one",
        displayName: "Team",
        serverBaseUrl: "https://example.test",
        workspaceId,
        allowInsecureTransport: false
      },
      workspaceId,
      workspaceDisplayName: "Team",
      connectedAt: "2030-01-01T00:00:00.000Z",
      error: null
    },
    workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null }
  };
}

function member(id: string, displayName = id): WorkspaceConnectionMemberView {
  return {
    schemaVersion: "workspace-setup/v1",
    membershipId: `membership-${id}`,
    humanPrincipalId: id,
    displayName,
    role: "member",
    devices: [
      {
        schemaVersion: "workspace-setup/v1",
        deviceSessionId: `device-${id}`,
        humanPrincipalId: id,
        issuedAt: "2030-01-01T00:00:00.000Z",
        lastUsedAt: null,
        isCurrentDevice: id === "human-one"
      }
    ]
  };
}

async function observedPeople(
  initialGate?: ReturnType<typeof deferred<WorkspaceConnectionMembersPage>>,
  connectionOnly = false
) {
  let status = workspaceStatus();
  if (connectionOnly)
    status = {
      ...status,
      profiles: [],
      activeProfileId: null,
      session: { ...status.session, operationScope: null, phase: "idle", activeProfileId: null }
    };
  let roster = [member("human-one", "A"), member("human-removed", "Removed")];
  const signals = new Set<(signal: CollaborationObserverSignal) => void>();
  const statuses = new Set<(status: CollaborationStatus) => void>();
  const readMembers = vi.fn(
    async ({
      cursor = 0,
      limit = 100
    }: {
      cursor?: number;
      limit?: number;
    }): Promise<WorkspaceConnectionMembersPage> => ({
      schemaVersion: "workspace-setup/v1",
      items: roster.slice(cursor, cursor + limit),
      nextCursor: cursor + limit < roster.length ? cursor + limit : null
    })
  );
  const readSelf = vi.fn(
    async (): Promise<WorkspaceConnectionSelfView> => ({
      schemaVersion: "workspace-setup/v1",
      workspaceId: status.workspaceConnection.workspaceId!,
      membershipId: "membership-human-one",
      humanPrincipalId: "human-one",
      displayName:
        roster.find((item) => item.humanPrincipalId === "human-one")?.displayName ?? "Self",
      role: "member",
      deviceSessionId: "device-human-one"
    })
  );
  const legacyMembers = vi.fn().mockRejectedValue(new Error("project identity forbidden"));
  const api = {
    getCollaborationStatus: vi.fn(async () => status),
    getWorkspaceConnectionSelf: readSelf,
    listWorkspaceConnectionMembers: readMembers,
    listCollaborationMembers: legacyMembers,
    listCollaborationAssignments: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listCollaborationActivity: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    onCollaborationStatusChanged: vi.fn((listener: (next: CollaborationStatus) => void) => {
      statuses.add(listener);
      return () => {
        statuses.delete(listener);
      };
    }),
    onCollaborationObserverSignal: vi.fn(
      (listener: (signal: CollaborationObserverSignal) => void) => {
        signals.add(listener);
        return () => {
          signals.delete(listener);
        };
      }
    )
  } as PlanWeaveCollaborationApi;
  const readPort = toCollaborationReadBridge(api)!;
  const shell = acquireCollaborationReadModelController(readPort);
  if (!connectionOnly)
    await shell.controller.setActiveProject(
      scopedProjectFixture({ profileId: "profile-one", projectId: "project-one" })
    );
  if (initialGate) readMembers.mockImplementationOnce(() => initialGate.promise);
  const hook = renderHook(
    ({ nextStatus, open }: { nextStatus: CollaborationStatus; open: boolean }) => {
      const shared = useCollaborationReadModels({
        api: readPort,
        ...(connectionOnly
          ? resolveCollaborationSurfaceReadBinding({
              sessionConnected: nextStatus.session.phase === "connected",
              profileId: nextStatus.activeProfileId,
              profileProjectId: "project-one",
              localProjectId: "local-project",
              canvasId: "canvas-one"
            })
          : { profileId: "profile-one", projectId: "project-one", canvasId: "canvas-one" }),
        manageActiveProject: connectionOnly
      });
      const panel = usePeoplePanelController({
        api,
        status: nextStatus,
        members: shared.viewModel.members,
        hosts: shared.viewModel.hosts,
        syncPhase: shared.snapshot.syncPhase,
        detailsOpen: open
      });
      return { panel, shared };
    },
    { initialProps: { nextStatus: status, open: true } }
  );
  if (!initialGate) {
    await waitFor(() =>
      expect(hook.result.current.panel.members.map((item) => item.displayName)).toEqual([
        "A",
        "Removed"
      ])
    );
    await waitFor(() => expect(hook.result.current.panel.detailsLoading).toBe(false));
  } else await waitFor(() => expect(hook.result.current.panel.detailsLoading).toBe(true));
  let cursor = 0;
  const emit = (kind: "membership" | "activity" | "invitation") => {
    const previousCursor = cursor++;
    for (const listener of signals)
      listener({
        type: "human.observer.event",
        profileId: "profile-one",
        projectId: "project-one",
        event: {
          type: "human.observer.event",
          protocolVersion: 1,
          cursor,
          previousCursor,
          occurredAt: "2030-01-01T00:00:00.000Z",
          kind
        }
      });
  };
  return {
    ...hook,
    api,
    shell,
    readMembers,
    readSelf,
    legacyMembers,
    emit,
    emitWorkspace: (overrides: Record<string, unknown> = {}) => {
      for (const listener of signals)
        listener({
          type: "workspace.members.invalidated",
          schemaVersion: "workspace-setup/v1",
          profileId: status.workspaceConnection.profile!.profileId,
          serverBaseUrl: status.workspaceConnection.profile!.serverBaseUrl,
          workspaceId: status.workspaceConnection.workspaceId!,
          ...overrides
        } as CollaborationObserverSignal);
    },
    listenerCount: () => signals.size,
    setRoster: (items: WorkspaceConnectionMemberView[]) => {
      roster = items;
    },
    changeStatus: (next: CollaborationStatus) => {
      status = next;
      for (const listener of statuses) listener(next);
      hook.rerender({ nextStatus: next, open: true });
    },
    close: () => hook.rerender({ nextStatus: status, open: false }),
    open: () => hook.rerender({ nextStatus: status, open: true })
  };
}

describe("Workspace People membership invalidation", () => {
  it("refreshes complete details after observer rename/add/remove and ignores unrelated events", async () => {
    const f = await observedPeople();
    const selfReads = f.readSelf.mock.calls.length;
    f.setRoster([member("human-one", "Renamed"), member("human-new", "New")]);
    act(() => f.emit("membership"));
    await waitFor(() =>
      expect(f.result.current.shared.viewModel.members.map((item) => item.displayName)).toEqual([
        "Renamed",
        "New"
      ])
    );
    await waitFor(() =>
      expect(f.result.current.panel.members.map((item) => item.displayName)).toEqual([
        "Renamed",
        "New"
      ])
    );
    expect(f.result.current.panel.identity?.displayName).toBe("Renamed");
    expect(f.result.current.panel.presence.memberCount).toBe(2);
    expect(
      f.result.current.panel.presence.avatarMembers.map((item) => [item.displayName, item.initials])
    ).toEqual([
      ["Renamed", "RE"],
      ["New", "NE"]
    ]);
    expect(f.result.current.panel.devices.map((device) => device.deviceCredentialId)).toEqual([
      "device-human-one",
      "device-human-new"
    ]);
    expect(f.result.current.panel.presence.currentUserIsOwner).toBe(false);
    expect(f.readSelf).toHaveBeenCalledTimes(selfReads + 1);
    act(() => {
      f.emit("activity");
      f.emit("invitation");
    });
    await waitFor(() => expect(f.result.current.shared.snapshot.observerCursor).toBe(3));
    expect(f.readSelf).toHaveBeenCalledTimes(selfReads + 1);
    f.setRoster([member("human-new", "New"), member("human-one", "Renamed")]);
    act(() => f.emit("membership"));
    await waitFor(() => expect(f.result.current.shared.snapshot.observerCursor).toBe(4));
    expect(f.readSelf).toHaveBeenCalledTimes(selfReads + 1);
    expect(f.legacyMembers).not.toHaveBeenCalled();
    f.unmount();
    f.shell.release();
  });
  it("queues one trailing detail refresh when membership changes during an in-flight read", async () => {
    const f = await observedPeople();
    const baseReads = f.readSelf.mock.calls.length;
    const b = [member("human-one", "B")];
    const gate = deferred<WorkspaceConnectionMembersPage>();
    f.setRoster(b);
    f.readMembers
      .mockResolvedValueOnce({ schemaVersion: "workspace-setup/v1", items: b, nextCursor: null })
      .mockImplementationOnce(() => gate.promise);
    act(() => f.emit("membership"));
    await waitFor(() => expect(f.readSelf).toHaveBeenCalledTimes(baseReads + 1));
    f.setRoster([member("human-one", "C"), member("human-added", "Added")]);
    act(() => f.emit("membership"));
    await waitFor(() =>
      expect(f.result.current.shared.viewModel.members[0]?.displayName).toBe("C")
    );
    f.setRoster([member("human-one", "D"), member("human-added", "Added")]);
    act(() => f.emit("membership"));
    await waitFor(() =>
      expect(f.result.current.shared.viewModel.members[0]?.displayName).toBe("D")
    );
    expect(f.result.current.panel.members[0]?.displayName).toBe("A");
    await act(async () => {
      gate.resolve({ schemaVersion: "workspace-setup/v1", items: b, nextCursor: null });
    });
    await waitFor(() =>
      expect(f.result.current.panel.members.map((item) => item.displayName)).toEqual(["D", "Added"])
    );
    expect(f.result.current.panel.identity?.displayName).toBe("D");
    expect(f.readSelf).toHaveBeenCalledTimes(baseReads + 2);
    expect(f.result.current.panel.detailsLoading).toBe(false);
    f.unmount();
    f.shell.release();
  });

  it("keeps a successful empty roster authoritative and exhausts more than 100 members", async () => {
    const f = await observedPeople();
    f.setRoster([]);
    act(() => f.emit("membership"));
    await waitFor(() => expect(f.result.current.panel.members).toEqual([]));
    expect(f.result.current.panel.presence.memberCount).toBe(0);
    expect(f.result.current.panel.devices).toEqual([]);
    const roster = Array.from({ length: 125 }, (_, index) =>
      member(index === 0 ? "human-one" : `human-${index}`, `Member ${index}`)
    );
    f.setRoster(roster);
    act(() => f.emit("membership"));
    await waitFor(() => expect(f.result.current.panel.members).toHaveLength(125));
    expect(f.result.current.panel.members.map((item) => item.humanPrincipalId)).toEqual(
      roster.map((item) => item.humanPrincipalId)
    );
    expect(f.result.current.panel.devices).toHaveLength(125);
    expect(
      f.readMembers.mock.calls.some(([input]) => input.cursor === 100 && input.limit === 100)
    ).toBe(true);
    f.unmount();
    f.shell.release();
  });

  it("preserves same-scope details on failed refresh and retries without treating project data as fallback", async () => {
    const f = await observedPeople();
    const b = [member("human-one", "B")];
    f.setRoster(b);
    f.readMembers
      .mockResolvedValueOnce({ schemaVersion: "workspace-setup/v1", items: b, nextCursor: null })
      .mockRejectedValueOnce(new Error("workspace_details_failed"));
    act(() => f.emit("membership"));
    await waitFor(() =>
      expect(f.result.current.panel.detailsError).toBe("workspace_details_failed")
    );
    expect(f.result.current.panel.members.map((item) => item.displayName)).toEqual([
      "A",
      "Removed"
    ]);
    expect(f.result.current.panel.identity?.displayName).toBe("A");
    await act(async () => {
      await f.result.current.panel.refreshDetails();
    });
    expect(f.result.current.panel.members.map((item) => item.displayName)).toEqual(["B"]);
    expect(f.result.current.panel.detailsError).toBeNull();
    expect(f.legacyMembers).not.toHaveBeenCalled();
    f.unmount();
    f.shell.release();
  });

  it.each([
    "workspace",
    "profile",
    "server",
    "disconnect",
    "close and reopen"
  ] as const)("fences a late details response after %s", async (change) => {
    const f = await observedPeople();
    const old = deferred<WorkspaceConnectionMembersPage>();
    const a = [member("human-one", "Old A")];
    f.readMembers.mockImplementationOnce(() => old.promise);
    act(() => {
      void f.result.current.panel.refreshDetails();
    });
    f.setRoster([member("human-one", "New B")]);
    if (change === "close and reopen") {
      act(() => f.close());
      act(() => f.open());
    } else {
      const next = workspaceStatus(change === "workspace" ? "workspace-B" : "workspace-one");
      if (change === "profile") {
        next.activeProfileId = "profile-B";
        next.session.activeProfileId = "profile-B";
        next.workspaceConnection.profile = {
          ...next.workspaceConnection.profile!,
          profileId: "profile-B"
        };
      }
      if (change === "server") {
        next.workspaceConnection.profile = {
          ...next.workspaceConnection.profile!,
          serverBaseUrl: "https://other.test"
        };
      }
      if (change === "disconnect") {
        next.workspaceConnection = { ...next.workspaceConnection, status: "local_only" };
        next.activeProfileId = null;
        next.session = {
          ...next.session,
          operationScope: null,
          phase: "idle",
          activeProfileId: null
        };
      }
      act(() => f.changeStatus(next));
    }
    if (change === "disconnect")
      await waitFor(() => expect(f.result.current.panel.members).toEqual([]));
    else await waitFor(() => expect(f.result.current.panel.members[0]?.displayName).toBe("New B"));
    await act(async () => {
      old.resolve({ schemaVersion: "workspace-setup/v1", items: a, nextCursor: null });
    });
    expect(f.result.current.panel.members.map((item) => item.displayName)).toEqual(
      change === "disconnect" ? [] : ["New B"]
    );
    expect(f.result.current.panel.detailsError).toBeNull();
    f.unmount();
    f.shell.release();
  });

  it("remembers membership changes before the initial details request finishes", async () => {
    const gate = deferred<WorkspaceConnectionMembersPage>();
    const f = await observedPeople(gate);
    const initial = [member("human-one", "Initial A")];
    const reads = f.readSelf.mock.calls.length;
    f.setRoster([member("human-one", "B")]);
    act(() => f.emit("membership"));
    await waitFor(() =>
      expect(f.result.current.shared.viewModel.members[0]?.displayName).toBe("B")
    );
    f.setRoster([member("human-one", "Final C")]);
    act(() => f.emit("membership"));
    await waitFor(() =>
      expect(f.result.current.shared.viewModel.members[0]?.displayName).toBe("Final C")
    );
    expect(f.result.current.panel.members).toEqual([]);
    await act(async () => {
      gate.resolve({ schemaVersion: "workspace-setup/v1", items: initial, nextCursor: null });
    });
    await waitFor(() => expect(f.result.current.panel.members[0]?.displayName).toBe("Final C"));
    expect(f.result.current.panel.identity?.displayName).toBe("Final C");
    expect(f.readSelf).toHaveBeenCalledTimes(reads + 1);
    f.unmount();
    f.shell.release();
  });

  it("preserves complete prior details when a paginated refresh repeats a cursor", async () => {
    const f = await observedPeople();
    f.readMembers.mockResolvedValueOnce({
      schemaVersion: "workspace-setup/v1",
      items: [member("human-partial", "Partial")],
      nextCursor: 0
    });
    await act(async () => {
      await f.result.current.panel.refreshDetails();
    });
    expect(f.result.current.panel.members.map((item) => item.displayName)).toEqual([
      "A",
      "Removed"
    ]);
    expect(f.result.current.panel.detailsError).toContain("cursor_repeated");
    expect(f.result.current.panel.detailsLoading).toBe(false);
    f.unmount();
    f.shell.release();
  });
});

describe("connection-only People shell invalidation", () => {
  it("refreshes device-only changes and merged roster devices through idle shell authority", async () => {
    const f = await observedPeople(undefined, true);
    const owner = member("human-one", "A");
    const addedDevice = {
      ...owner.devices[0]!,
      deviceSessionId: "device-second",
      isCurrentDevice: false
    };
    f.setRoster([
      { ...owner, devices: [...owner.devices, addedDevice] },
      member("human-removed", "Removed")
    ]);
    act(() => f.emitWorkspace());
    await waitFor(() => expect(f.result.current.panel.devices).toHaveLength(3));
    expect(f.result.current.panel.presence.memberCount).toBe(2);
    const transferredDevice = { ...addedDevice, deviceSessionId: "device-transferred" };
    f.setRoster([{ ...owner, devices: [...owner.devices, addedDevice, transferredDevice] }]);
    act(() => f.emitWorkspace());
    await waitFor(() => expect(f.result.current.panel.presence.memberCount).toBe(1));
    expect(f.result.current.panel.devices.map((device) => device.deviceCredentialId)).toEqual([
      "device-human-one",
      "device-second",
      "device-transferred"
    ]);
    expect(f.result.current.panel.identity?.humanPrincipalId).toBe("human-one");
    expect(f.legacyMembers).not.toHaveBeenCalled();
    f.unmount();
    f.shell.release();
    expect(f.listenerCount()).toBe(0);
  });
  it("uses real idle shell binding for name, count, join and removal updates without Project reads", async () => {
    const f = await observedPeople(undefined, true);
    expect(f.result.current.shared.snapshot.projectId).toBeNull();
    expect(f.listenerCount()).toBe(1);
    f.setRoster([
      member("human-one", "Renamed"),
      member("human-added", "Added"),
      member("human-removed", "Removed")
    ]);
    act(() => f.emitWorkspace());
    await waitFor(() =>
      expect(f.result.current.panel.members.map((item) => item.displayName)).toEqual([
        "Renamed",
        "Added",
        "Removed"
      ])
    );
    expect(f.result.current.panel.presence.memberCount).toBe(3);
    expect(f.result.current.panel.identity?.displayName).toBe("Renamed");
    f.setRoster([member("human-one", "Only")]);
    act(() => f.emitWorkspace());
    await waitFor(() => expect(f.result.current.panel.presence.memberCount).toBe(1));
    expect(f.result.current.panel.members[0]?.displayName).toBe("Only");
    const reads = f.readSelf.mock.calls.length;
    act(() => {
      f.emit("activity");
      f.emit("invitation");
      f.emitWorkspace({ workspaceId: "other-workspace" });
      f.emitWorkspace({ serverBaseUrl: "https://other.test" });
    });
    expect(f.readSelf).toHaveBeenCalledTimes(reads);
    expect(f.legacyMembers).not.toHaveBeenCalled();
    expect(f.api.listCollaborationAssignments).not.toHaveBeenCalled();
    f.unmount();
    f.shell.release();
    expect(f.listenerCount()).toBe(0);
  });
  it("coalesces initial in-flight Workspace invalidations into one trailing authority read", async () => {
    const gate = deferred<WorkspaceConnectionMembersPage>();
    const f = await observedPeople(gate, true);
    f.setRoster([member("human-one", "Final"), member("human-added", "Added")]);
    act(() => {
      f.emitWorkspace();
      f.emitWorkspace();
      f.emitWorkspace();
    });
    expect(f.readSelf).toHaveBeenCalledTimes(1);
    await act(async () =>
      gate.resolve({
        schemaVersion: "workspace-setup/v1",
        items: [member("human-one", "Old")],
        nextCursor: null
      })
    );
    await waitFor(() => expect(f.result.current.panel.presence.memberCount).toBe(2));
    expect(f.result.current.panel.identity?.displayName).toBe("Final");
    expect(f.readSelf).toHaveBeenCalledTimes(2);
    expect(f.readMembers).toHaveBeenCalledTimes(2);
    f.unmount();
    f.shell.release();
  });
  it.each([
    "workspace",
    "profile",
    "server",
    "disconnect",
    "close and reopen"
  ] as const)("fences late idle-shell authority and old signals after %s", async (change) => {
    const f = await observedPeople(undefined, true);
    const gate = deferred<WorkspaceConnectionMembersPage>();
    f.readMembers.mockImplementationOnce(() => gate.promise);
    act(() => f.emitWorkspace());
    f.setRoster([member("human-one", "New")]);
    if (change === "close and reopen") {
      act(() => f.close());
      act(() => f.open());
    } else {
      const next = workspaceStatus(change === "workspace" ? "workspace-two" : "workspace-one");
      next.profiles = [];
      next.activeProfileId = null;
      next.session = {
        ...next.session,
        operationScope: null,
        phase: "idle",
        activeProfileId: null
      };
      if (change === "profile")
        next.workspaceConnection.profile = {
          ...next.workspaceConnection.profile!,
          profileId: "profile-two"
        };
      if (change === "server")
        next.workspaceConnection.profile = {
          ...next.workspaceConnection.profile!,
          serverBaseUrl: "https://other.test"
        };
      if (change === "disconnect")
        next.workspaceConnection = { ...next.workspaceConnection, status: "local_only" };
      act(() => f.changeStatus(next));
    }
    await waitFor(() =>
      expect(f.result.current.panel.members.map((item) => item.displayName)).toEqual(
        change === "disconnect" ? [] : ["New"]
      )
    );
    const reads = f.readSelf.mock.calls.length;
    if (change !== "close and reopen")
      act(() =>
        f.emitWorkspace({
          profileId: "profile-one",
          serverBaseUrl: "https://example.test",
          workspaceId: "workspace-one"
        })
      );
    await act(async () =>
      gate.resolve({
        schemaVersion: "workspace-setup/v1",
        items: [member("human-one", "Old")],
        nextCursor: null
      })
    );
    expect(f.readSelf).toHaveBeenCalledTimes(reads);
    expect(f.result.current.panel.members.map((item) => item.displayName)).toEqual(
      change === "disconnect" ? [] : ["New"]
    );
    expect(f.result.current.shared.snapshot.projectId).toBeNull();
    f.unmount();
    f.shell.release();
  });
  it("shows scoped observer failure while preserving usable HTTP authority and clears it on revalidation", async () => {
    const f = await observedPeople(undefined, true);
    act(() =>
      f.emitWorkspace({
        type: "workspace.members.observer_error",
        code: "workspace_members_disconnected"
      })
    );
    expect(f.result.current.panel.detailsError).toContain("workspace_members_disconnected");
    expect(f.result.current.panel.members).toHaveLength(2);
    await act(async () => f.result.current.panel.refreshDetails());
    expect(f.result.current.panel.detailsError).toBeNull();
    f.unmount();
    f.shell.release();
  });
});
