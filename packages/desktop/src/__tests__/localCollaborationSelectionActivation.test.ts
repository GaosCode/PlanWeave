import { describe, expect, it, vi } from "vitest";
import {
  activateLocalCollaborationSelection,
  createLocalCollaborationActivationCommand
} from "../main/collaboration/localCollaborationSelectionActivation.js";

const profile = {
  profileId: "planweave-local-project",
  displayName: "Local collaboration server",
  serverBaseUrl: "http://127.0.0.1:8787/",
  projectId: "project-1",
  allowInsecureTransport: true
};

describe("activateLocalCollaborationSelection", () => {
  it("waits for local server restoration before reconciling a persisted workspace", async () => {
    let resolveReady!: () => void;
    let restored = false;
    const ready = new Promise<void>((resolve) => {
      resolveReady = () => {
        restored = true;
        resolve();
      };
    });
    const coordinator = {
      currentSelection: vi.fn(() => null),
      status: vi.fn(() => ({ state: restored ? "running" : "stopped" })),
      start: vi.fn(async () => ({ state: "running" })),
      currentSelectionIsTrusted: vi.fn(() => restored),
      recognizesLocalProfile: vi.fn(() => true),
      setCurrentSelection: vi.fn(async () => undefined),
      clearCurrentSelection: vi.fn(async () => undefined),
      localProfile: vi.fn(() => (restored ? profile : null)),
      localProfileForId: vi.fn(() => (restored ? profile : null)),
      ownsLocalProfile: vi.fn(() => true),
      registerCurrentProject: vi.fn(() => ({
        workspaceId: "workspace-1",
        projectId: "project-1",
        canvasId: "canvas-1",
        profileId: profile.profileId,
        registeredAt: "2030-01-01T00:00:00.000Z"
      })),
      registerLocalProfile: vi.fn(() => ({
        workspaceId: "workspace-1",
        projectId: "project-1",
        canvasId: "canvas-1",
        profileId: profile.profileId,
        registeredAt: "2030-01-01T00:00:00.000Z"
      }))
    };
    const service = {
      getStatus: vi.fn(async () => ({
        activeProfileId: profile.profileId,
        profiles: [{ profileId: profile.profileId, hasDeviceCredential: true }],
        session: { phase: "idle" }
      })),
      runStatusPublicationTransaction: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
      clearActiveProfile: vi.fn(async () => undefined),
      setActiveProfile: vi.fn(async () => undefined),
      connectSession: vi.fn(async () => undefined),
      migrateLegacyLocalOwnerDisplayName: vi.fn(async () => false),
      upsertProfile: vi.fn(async () => undefined),
      migrateLocalProfileCredential: vi.fn(async () => undefined),
      adoptWorkspaceAuthority: vi.fn(async () => undefined),
      activeHumanPrincipalId: vi.fn(async () => "human-owner"),
      bootstrapOwner: vi.fn()
    };

    const command = createLocalCollaborationActivationCommand({
      coordinator,
      service,
      coordinatorReady: ready
    });
    const reconciliation = command.selectAndReconcile({
      projectId: "desktop-project-1",
      canvasId: "canvas-1"
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(service.clearActiveProfile).not.toHaveBeenCalled();
    expect(service.upsertProfile).not.toHaveBeenCalled();

    resolveReady();
    await reconciliation;

    expect(service.clearActiveProfile).not.toHaveBeenCalled();
    expect(service.upsertProfile).toHaveBeenCalledWith(profile);
    expect(service.adoptWorkspaceAuthority).toHaveBeenCalledWith({
      profileId: profile.profileId,
      workspaceId: "workspace-1",
      membershipRole: "owner"
    });
    expect(service.connectSession).toHaveBeenCalledWith({ profileId: profile.profileId });
  });

  it("restarts a stopped local owner authority before restoring its command session", async () => {
    let serverState = "stopped";
    const registration = {
      workspaceId: "workspace-1",
      projectId: "project-1",
      canvasId: "canvas-1",
      profileId: profile.profileId,
      registeredAt: "2030-01-01T00:00:00.000Z"
    };
    const coordinator = {
      currentSelection: vi.fn(() => null),
      status: vi.fn(() => ({ state: serverState })),
      start: vi.fn(async () => {
        serverState = "running";
        return { state: serverState };
      }),
      currentSelectionIsTrusted: vi.fn(() => serverState === "running"),
      recognizesLocalProfile: vi.fn((profileId: string) => profileId === profile.profileId),
      setCurrentSelection: vi.fn(async () => undefined),
      clearCurrentSelection: vi.fn(async () => undefined),
      localProfile: vi.fn(() => (serverState === "running" ? profile : null)),
      localProfileForId: vi.fn(() => (serverState === "running" ? profile : null)),
      registerCurrentProject: vi.fn(() => registration),
      registerLocalProfile: vi.fn(() => registration)
    };
    const service = {
      getStatus: vi.fn(async () => ({
        activeProfileId: profile.profileId,
        profiles: [{ profileId: profile.profileId, hasDeviceCredential: true }],
        session: { phase: "error" }
      })),
      runStatusPublicationTransaction: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
      clearActiveProfile: vi.fn(async () => undefined),
      setActiveProfile: vi.fn(async () => undefined),
      connectSession: vi.fn(async () => undefined),
      migrateLegacyLocalOwnerDisplayName: vi.fn(async () => false),
      upsertProfile: vi.fn(async () => undefined),
      migrateLocalProfileCredential: vi.fn(async () => undefined),
      adoptWorkspaceAuthority: vi.fn(async () => undefined),
      activeHumanPrincipalId: vi.fn(async () => "human-owner"),
      bootstrapOwner: vi.fn()
    };

    const command = createLocalCollaborationActivationCommand({ coordinator, service });
    await command.selectAndReconcile({ projectId: "desktop-project-1", canvasId: "canvas-1" });

    expect(coordinator.start).toHaveBeenCalledOnce();
    expect(coordinator.registerLocalProfile).toHaveBeenCalledWith(profile.profileId, {
      kind: "human",
      id: "human-owner"
    });
    expect(service.connectSession).toHaveBeenCalledWith({ profileId: profile.profileId });
  });

  it("restores an explicit local owner profile when no active profile or selection is retained", async () => {
    const registration = {
      workspaceId: "workspace-1",
      projectId: "project-1",
      canvasId: "canvas-1",
      profileId: profile.profileId,
      registeredAt: "2030-01-01T00:00:00.000Z"
    };
    const coordinator = {
      currentSelection: vi.fn(() => null),
      status: vi.fn(() => ({ state: "running" })),
      start: vi.fn(async () => ({ state: "running" })),
      currentSelectionIsTrusted: vi.fn(() => false),
      recognizesLocalProfile: vi.fn((profileId: string) => profileId === profile.profileId),
      setCurrentSelection: vi.fn(async () => undefined),
      clearCurrentSelection: vi.fn(async () => undefined),
      localProfile: vi.fn(() => null),
      localProfileForId: vi.fn((profileId: string) =>
        profileId === profile.profileId ? profile : null
      ),
      registerCurrentProject: vi.fn(),
      registerLocalProfile: vi.fn(() => registration)
    };
    const service = {
      getStatus: vi.fn(async () => ({
        activeProfileId: null,
        profiles: [{ profileId: profile.profileId, hasDeviceCredential: false }],
        session: { phase: "error" }
      })),
      runStatusPublicationTransaction: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
      clearActiveProfile: vi.fn(async () => undefined),
      setActiveProfile: vi.fn(async () => undefined),
      connectSession: vi.fn(async () => undefined),
      migrateLegacyLocalOwnerDisplayName: vi.fn(async () => false),
      upsertProfile: vi.fn(async () => undefined),
      migrateLocalProfileCredential: vi.fn(async () => undefined),
      adoptWorkspaceAuthority: vi.fn(async () => undefined),
      activeHumanPrincipalId: vi.fn(async () => null),
      bootstrapOwner: vi.fn(async () => ({
        workspaceId: "workspace-1",
        principal: { humanPrincipalId: "human-restored-owner" }
      })),
      markLastServerConnectionLocal: vi.fn(async () => undefined)
    };

    const command = createLocalCollaborationActivationCommand({ coordinator, service });
    await expect(command.activate({ profileId: profile.profileId })).resolves.toEqual(registration);

    expect(coordinator.registerLocalProfile).toHaveBeenCalledWith(profile.profileId, {
      kind: "human",
      id: "human-restored-owner"
    });
    expect(coordinator.registerCurrentProject).not.toHaveBeenCalled();
    expect(service.connectSession).toHaveBeenCalledWith({ profileId: profile.profileId });
    expect(service.markLastServerConnectionLocal).toHaveBeenCalledOnce();
  });

  it("keeps an old local canvas selectable when automatic Server restoration fails", async () => {
    const coordinator = {
      currentSelection: vi.fn(() => null),
      status: vi.fn(() => ({ state: "stopped" })),
      start: vi.fn(async () => ({ state: "error" })),
      currentSelectionIsTrusted: vi.fn(() => false),
      recognizesLocalProfile: vi.fn(() => true),
      setCurrentSelection: vi.fn(async () => undefined),
      clearCurrentSelection: vi.fn(async () => undefined),
      localProfile: vi.fn(() => null),
      localProfileForId: vi.fn(() => null),
      registerCurrentProject: vi.fn(),
      registerLocalProfile: vi.fn()
    };
    const service = {
      getStatus: vi.fn(async () => ({
        activeProfileId: profile.profileId,
        profiles: [{ profileId: profile.profileId, hasDeviceCredential: true }],
        session: { phase: "error" }
      })),
      runStatusPublicationTransaction: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
      clearActiveProfile: vi.fn(async () => undefined),
      setActiveProfile: vi.fn(async () => undefined),
      connectSession: vi.fn(async () => undefined),
      upsertProfile: vi.fn(),
      migrateLocalProfileCredential: vi.fn(),
      adoptWorkspaceAuthority: vi.fn(),
      activeHumanPrincipalId: vi.fn(),
      bootstrapOwner: vi.fn()
    };

    const command = createLocalCollaborationActivationCommand({ coordinator, service });
    await expect(
      command.selectAndReconcile({ projectId: "desktop-project-1", canvasId: "canvas-1" })
    ).resolves.toBeNull();

    expect(coordinator.setCurrentSelection).toHaveBeenCalledWith({
      projectId: "desktop-project-1",
      canvasId: "canvas-1"
    });
    expect(coordinator.clearCurrentSelection).not.toHaveBeenCalled();
    expect(service.clearActiveProfile).not.toHaveBeenCalled();
  });

  it("preserves a configured workspace when the selected project is not hosted", async () => {
    const coordinator = {
      currentSelection: vi.fn(() => null),
      status: vi.fn(() => ({ state: "running" })),
      start: vi.fn(async () => ({ state: "running" })),
      currentSelectionIsTrusted: vi.fn(() => false),
      recognizesLocalProfile: vi.fn(() => true),
      setCurrentSelection: vi.fn(async () => undefined),
      clearCurrentSelection: vi.fn(async () => undefined),
      localProfile: vi.fn(() => null),
      localProfileForId: vi.fn(() => null),
      ownsLocalProfile: vi.fn((profileId: string) => profileId === "planweave-local-tiny"),
      registerCurrentProject: vi.fn(),
      registerLocalProfile: vi.fn()
    };
    const service = {
      getStatus: vi.fn(async () => ({
        activeProfileId: "planweave-local-tiny",
        profiles: [{ profileId: "planweave-local-tiny", hasDeviceCredential: true }],
        session: { phase: "idle" }
      })),
      runStatusPublicationTransaction: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
      clearActiveProfile: vi.fn(async () => undefined),
      setActiveProfile: vi.fn(),
      connectSession: vi.fn(),
      upsertProfile: vi.fn(),
      migrateLocalProfileCredential: vi.fn(),
      adoptWorkspaceAuthority: vi.fn(),
      activeHumanPrincipalId: vi.fn(),
      bootstrapOwner: vi.fn()
    };

    const command = createLocalCollaborationActivationCommand({ coordinator, service });
    await command.selectAndReconcile({ projectId: "desktop-apollo", canvasId: "default" });

    expect(service.clearActiveProfile).not.toHaveBeenCalled();
    expect(service.setActiveProfile).not.toHaveBeenCalled();
  });

  it("preserves a remote profile when the selected local project is not trusted", async () => {
    const coordinator = {
      currentSelection: vi.fn(() => null),
      status: vi.fn(() => ({ state: "running" })),
      start: vi.fn(async () => ({ state: "running" })),
      currentSelectionIsTrusted: vi.fn(() => false),
      recognizesLocalProfile: vi.fn(() => false),
      setCurrentSelection: vi.fn(async () => undefined),
      clearCurrentSelection: vi.fn(async () => undefined),
      localProfile: vi.fn(() => null),
      localProfileForId: vi.fn(() => null),
      ownsLocalProfile: vi.fn(() => false),
      registerCurrentProject: vi.fn(),
      registerLocalProfile: vi.fn()
    };
    const service = {
      getStatus: vi.fn(async () => ({
        activeProfileId: "remote-team",
        profiles: [{ profileId: "remote-team", hasDeviceCredential: true }],
        session: { phase: "connected" }
      })),
      runStatusPublicationTransaction: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
      clearActiveProfile: vi.fn(async () => undefined),
      setActiveProfile: vi.fn(),
      connectSession: vi.fn(),
      upsertProfile: vi.fn(),
      migrateLocalProfileCredential: vi.fn(),
      adoptWorkspaceAuthority: vi.fn(),
      activeHumanPrincipalId: vi.fn(),
      bootstrapOwner: vi.fn()
    };

    const command = createLocalCollaborationActivationCommand({ coordinator, service });
    await command.selectAndReconcile({ projectId: "desktop-apollo", canvasId: "default" });

    expect(service.clearActiveProfile).not.toHaveBeenCalled();
  });

  it("does not adopt this computer when the last Server connection is remote", async () => {
    const coordinator = {
      currentSelection: vi.fn(() => null),
      status: vi.fn(() => ({ state: "stopped" })),
      start: vi.fn(async () => ({ state: "running" })),
      currentSelectionIsTrusted: vi.fn(() => true),
      recognizesLocalProfile: vi.fn(() => true),
      setCurrentSelection: vi.fn(async () => undefined),
      clearCurrentSelection: vi.fn(async () => undefined),
      localProfile: vi.fn(() => profile),
      localProfileForId: vi.fn(() => profile),
      registerCurrentProject: vi.fn(),
      registerLocalProfile: vi.fn()
    };
    const service = {
      getStatus: vi.fn(async () => ({
        activeProfileId: profile.profileId,
        profiles: [{ profileId: profile.profileId, hasDeviceCredential: true }],
        session: { phase: "idle" }
      })),
      runStatusPublicationTransaction: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
      peekPersistedRemoteProfileId: vi.fn(async () => "profile-workspace-001"),
      clearActiveProfile: vi.fn(async () => undefined),
      setActiveProfile: vi.fn(),
      connectSession: vi.fn(),
      upsertProfile: vi.fn(),
      migrateLocalProfileCredential: vi.fn(),
      adoptWorkspaceAuthority: vi.fn(),
      activeHumanPrincipalId: vi.fn(),
      bootstrapOwner: vi.fn()
    };

    const command = createLocalCollaborationActivationCommand({ coordinator, service });
    await expect(
      command.selectAndReconcile({ projectId: "desktop-apollo", canvasId: "default" })
    ).resolves.toBeNull();

    expect(coordinator.setCurrentSelection).toHaveBeenCalledWith({
      projectId: "desktop-apollo",
      canvasId: "default"
    });
    expect(coordinator.start).not.toHaveBeenCalled();
    expect(service.adoptWorkspaceAuthority).not.toHaveBeenCalled();
    expect(service.upsertProfile).not.toHaveBeenCalled();
  });

  it("restores the active local workspace without switching to the sidebar project", async () => {
    const activeWorkspaceProfile = {
      ...profile,
      profileId: "planweave-local-workspace-a",
      projectId: "workspace-project-a"
    };
    const selectedProjectProfile = {
      ...profile,
      profileId: "planweave-local-sidebar-project",
      projectId: "sidebar-project"
    };
    const coordinator = {
      currentSelection: vi.fn(() => null),
      status: vi.fn(() => ({ state: "running" })),
      start: vi.fn(async () => ({ state: "running" })),
      currentSelectionIsTrusted: vi.fn(() => true),
      recognizesLocalProfile: vi.fn(() => true),
      setCurrentSelection: vi.fn(async () => undefined),
      clearCurrentSelection: vi.fn(async () => undefined),
      localProfile: vi.fn(() => selectedProjectProfile),
      localProfileForId: vi.fn((profileId: string) =>
        profileId === activeWorkspaceProfile.profileId ? activeWorkspaceProfile : null
      ),
      registerCurrentProject: vi.fn(),
      registerLocalProfile: vi.fn(() => ({
        workspaceId: "workspace-a",
        projectId: activeWorkspaceProfile.projectId,
        canvasId: "canvas-a",
        profileId: activeWorkspaceProfile.profileId,
        registeredAt: "2030-01-01T00:00:00.000Z"
      }))
    };
    const service = {
      getStatus: vi.fn(async () => ({
        activeProfileId: activeWorkspaceProfile.profileId,
        profiles: [{ profileId: activeWorkspaceProfile.profileId, hasDeviceCredential: true }],
        session: { phase: "idle" }
      })),
      runStatusPublicationTransaction: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
      clearActiveProfile: vi.fn(async () => undefined),
      setActiveProfile: vi.fn(async () => undefined),
      connectSession: vi.fn(async () => undefined),
      migrateLegacyLocalOwnerDisplayName: vi.fn(async () => false),
      upsertProfile: vi.fn(async () => undefined),
      migrateLocalProfileCredential: vi.fn(async () => undefined),
      adoptWorkspaceAuthority: vi.fn(async () => undefined),
      activeHumanPrincipalId: vi.fn(async () => "human-owner"),
      bootstrapOwner: vi.fn()
    };

    const command = createLocalCollaborationActivationCommand({ coordinator, service });
    await command.selectAndReconcile({ projectId: "desktop-sidebar", canvasId: "default" });

    expect(service.upsertProfile).toHaveBeenCalledWith(activeWorkspaceProfile);
    expect(service.upsertProfile).not.toHaveBeenCalledWith(selectedProjectProfile);
    expect(coordinator.registerLocalProfile).toHaveBeenCalledWith(
      activeWorkspaceProfile.profileId,
      { kind: "human", id: "human-owner" }
    );
    expect(coordinator.registerCurrentProject).not.toHaveBeenCalled();
    expect(service.clearActiveProfile).not.toHaveBeenCalled();
  });

  it("changes the selected canvas without clearing the active collaboration profile", async () => {
    const calls: string[] = [];
    const coordinator = {
      currentSelection: vi.fn(() => null),
      status: vi.fn(() => ({ state: "running" })),
      start: vi.fn(async () => ({ state: "running" })),
      currentSelectionIsTrusted: vi.fn(() => true),
      recognizesLocalProfile: vi.fn(() => true),
      ownsLocalProfile: vi.fn(() => true),
      setCurrentSelection: vi.fn(async () => {
        calls.push("select");
      }),
      clearCurrentSelection: vi.fn(async () => undefined),
      localProfile: vi.fn(() => profile),
      localProfileForId: vi.fn(() => profile),
      registerCurrentProject: vi.fn(() => {
        calls.push("register");
        return {
          workspaceId: "workspace-1",
          projectId: "project-1",
          canvasId: "canvas-1",
          profileId: profile.profileId,
          registeredAt: "2030-01-01T00:00:00.000Z"
        };
      }),
      registerLocalProfile: vi.fn(() => {
        calls.push("register");
        return {
          workspaceId: "workspace-1",
          projectId: "project-1",
          canvasId: "canvas-1",
          profileId: profile.profileId,
          registeredAt: "2030-01-01T00:00:00.000Z"
        };
      })
    };
    const service = {
      upsertProfile: vi.fn(async () => {
        calls.push("upsert");
      }),
      migrateLocalProfileCredential: vi.fn(async () => undefined),
      adoptWorkspaceAuthority: vi.fn(async () => undefined),
      setActiveProfile: vi.fn(async () => undefined),
      activeHumanPrincipalId: vi.fn(async () => "human-owner"),
      bootstrapOwner: vi.fn(async () => {
        throw new Error("bootstrap must not run for a persisted owner");
      }),
      connectSession: vi.fn(async () => {
        calls.push("connect");
      }),
      migrateLegacyLocalOwnerDisplayName: vi.fn(async () => {
        calls.push("migrate-owner-name");
        return false;
      }),
      clearActiveProfile: vi.fn(async () => undefined),
      getStatus: vi.fn(async () => ({
        activeProfileId: profile.profileId,
        profiles: [{ profileId: profile.profileId, hasDeviceCredential: true }],
        session: { phase: "connected" }
      })),
      runStatusPublicationTransaction: vi.fn(async <T>(operation: () => Promise<T>) => operation())
    };

    const command = createLocalCollaborationActivationCommand({ coordinator, service });
    await command.selectAndReconcile({
      projectId: "desktop-project-1",
      canvasId: "canvas-1"
    });

    expect(calls).toEqual(["select", "upsert", "register", "connect", "migrate-owner-name"]);
    expect(coordinator.setCurrentSelection).toHaveBeenCalledOnce();
  });

  it("re-registers a trusted canvas before reconnecting a persisted owner", async () => {
    const calls: string[] = [];
    const coordinator = {
      setCurrentSelection: vi.fn(async () => undefined),
      clearCurrentSelection: vi.fn(async () => undefined),
      localProfile: vi.fn(() => profile),
      localProfileForId: vi.fn(() => profile),
      registerLocalProfile: vi.fn(),
      registerCurrentProject: vi.fn(() => {
        calls.push("register");
        return {
          workspaceId: "workspace-1",
          projectId: "project-1",
          canvasId: "canvas-1",
          profileId: profile.profileId,
          registeredAt: "2030-01-01T00:00:00.000Z"
        };
      })
    };
    const service = {
      upsertProfile: vi.fn(async () => undefined),
      migrateLocalProfileCredential: vi.fn(async () => undefined),
      adoptWorkspaceAuthority: vi.fn(async () => undefined),
      setActiveProfile: vi.fn(async () => undefined),
      activeHumanPrincipalId: vi.fn(async () => "human-owner"),
      bootstrapOwner: vi.fn(async () => {
        throw new Error("bootstrap must not run for a persisted owner");
      }),
      connectSession: vi.fn(async () => {
        calls.push("connect");
      }),
      migrateLegacyLocalOwnerDisplayName: vi.fn(async () => {
        calls.push("migrate-owner-name");
        return false;
      }),
      clearActiveProfile: vi.fn(async () => undefined)
    };

    const registration = await activateLocalCollaborationSelection({
      coordinator,
      service,
      ownerDisplayName: "Local owner"
    });

    expect(registration).toEqual(expect.objectContaining({ projectId: "project-1" }));
    expect(calls).toEqual(["register", "connect", "migrate-owner-name"]);
    expect(coordinator.registerCurrentProject).toHaveBeenCalledWith({
      kind: "human",
      id: "human-owner"
    });
    expect(service.adoptWorkspaceAuthority).toHaveBeenCalledWith({
      profileId: profile.profileId,
      workspaceId: "workspace-1",
      membershipRole: "owner"
    });
  });

  it("initializes the local owner once and continues activation automatically", async () => {
    const coordinator = {
      setCurrentSelection: vi.fn(async () => undefined),
      clearCurrentSelection: vi.fn(async () => undefined),
      localProfile: vi.fn(() => profile),
      localProfileForId: vi.fn(() => profile),
      registerLocalProfile: vi.fn(),
      registerCurrentProject: vi.fn(() => ({
        workspaceId: "workspace-1",
        projectId: "project-1",
        canvasId: "canvas-1",
        profileId: profile.profileId,
        registeredAt: "2030-01-01T00:00:00.000Z"
      }))
    };
    const service = {
      upsertProfile: vi.fn(async () => undefined),
      migrateLocalProfileCredential: vi.fn(async () => undefined),
      adoptWorkspaceAuthority: vi.fn(async () => undefined),
      setActiveProfile: vi.fn(async () => undefined),
      activeHumanPrincipalId: vi.fn(async () => null),
      bootstrapOwner: vi.fn(async () => ({
        workspaceId: "workspace-1",
        principal: { humanPrincipalId: "human-new-owner" }
      })),
      connectSession: vi.fn(async () => undefined),
      clearActiveProfile: vi.fn(async () => undefined)
    };

    await activateLocalCollaborationSelection({
      coordinator,
      service,
      ownerDisplayName: "Local owner"
    });

    expect(service.bootstrapOwner).toHaveBeenCalledWith({
      profileId: profile.profileId,
      request: { displayName: "Local owner" }
    });
    expect(coordinator.registerCurrentProject).toHaveBeenCalledWith({
      kind: "human",
      id: "human-new-owner"
    });
    expect(service.connectSession).toHaveBeenCalledWith({ profileId: profile.profileId });
  });

  it("rejects a local bootstrap whose Workspace does not match the registered project", async () => {
    const coordinator = {
      setCurrentSelection: vi.fn(async () => undefined),
      clearCurrentSelection: vi.fn(async () => undefined),
      localProfile: vi.fn(() => profile),
      localProfileForId: vi.fn(() => profile),
      registerLocalProfile: vi.fn(),
      registerCurrentProject: vi.fn(() => ({
        workspaceId: "workspace-registration",
        projectId: "project-1",
        canvasId: "canvas-1",
        profileId: profile.profileId,
        registeredAt: "2030-01-01T00:00:00.000Z"
      }))
    };
    const service = {
      upsertProfile: vi.fn(async () => undefined),
      migrateLocalProfileCredential: vi.fn(async () => undefined),
      adoptWorkspaceAuthority: vi.fn(async () => undefined),
      setActiveProfile: vi.fn(async () => undefined),
      activeHumanPrincipalId: vi.fn(async () => null),
      bootstrapOwner: vi.fn(async () => ({
        workspaceId: "workspace-bootstrap",
        principal: { humanPrincipalId: "human-new-owner" }
      })),
      connectSession: vi.fn(async () => undefined),
      clearActiveProfile: vi.fn(async () => undefined)
    };

    await expect(
      activateLocalCollaborationSelection({
        coordinator,
        service,
        ownerDisplayName: "Local owner"
      })
    ).rejects.toThrow("local_collaboration_workspace_mismatch");
    expect(service.adoptWorkspaceAuthority).not.toHaveBeenCalled();
    expect(service.connectSession).not.toHaveBeenCalled();
  });

  it("restores the previous stable selection and profile when activation fails", async () => {
    const previousSelection = { projectId: "desktop-project-1", canvasId: "canvas-stable" };
    const nextSelection = { projectId: "desktop-project-1", canvasId: "canvas-next" };
    let currentSelection = previousSelection;
    const coordinator = {
      currentSelection: vi.fn(() => currentSelection),
      status: vi.fn(() => ({ state: "running" })),
      start: vi.fn(async () => ({ state: "running" })),
      currentSelectionIsTrusted: vi.fn(() => true),
      recognizesLocalProfile: vi.fn(() => false),
      ownsLocalProfile: vi.fn(() => false),
      setCurrentSelection: vi.fn(async (selection: typeof previousSelection) => {
        currentSelection = selection;
      }),
      clearCurrentSelection: vi.fn(async () => {
        throw new Error("a previous stable selection must not be cleared");
      }),
      localProfile: vi.fn(() => profile),
      localProfileForId: vi.fn(() => null),
      registerLocalProfile: vi.fn(),
      registerCurrentProject: vi.fn(() => {
        throw new Error("registration_failed");
      })
    };
    const service = {
      upsertProfile: vi.fn(async () => undefined),
      migrateLocalProfileCredential: vi.fn(async () => undefined),
      adoptWorkspaceAuthority: vi.fn(async () => undefined),
      setActiveProfile: vi.fn(async () => undefined),
      activeHumanPrincipalId: vi.fn(async () => "human-owner"),
      bootstrapOwner: vi.fn(async () => ({
        workspaceId: "workspace-1",
        principal: { humanPrincipalId: "human-owner" }
      })),
      connectSession: vi.fn(async () => undefined),
      clearActiveProfile: vi.fn(async () => undefined),
      getStatus: vi.fn(async () => ({
        activeProfileId: "profile-stable",
        profiles: [{ profileId: "profile-stable", hasDeviceCredential: true }],
        session: { phase: "connected" }
      })),
      runStatusPublicationTransaction: vi.fn(async <T>(operation: () => Promise<T>) => operation())
    };

    const command = createLocalCollaborationActivationCommand({ coordinator, service });

    await expect(
      command.activate({
        selection: nextSelection,
        ownerDisplayName: "Local owner"
      })
    ).rejects.toThrow("registration_failed");

    expect(currentSelection).toEqual(previousSelection);
    expect(service.setActiveProfile).toHaveBeenLastCalledWith({ profileId: "profile-stable" });
    expect(service.connectSession).toHaveBeenLastCalledWith({ profileId: "profile-stable" });
    expect(service.clearActiveProfile).not.toHaveBeenCalled();
  });

  it("serializes overlapping local activation commands", async () => {
    const calls: string[] = [];
    let releaseFirstSelection!: () => void;
    const firstSelectionBlocked = new Promise<void>((resolve) => {
      releaseFirstSelection = resolve;
    });
    let selectedCanvasId = "canvas-stable";
    const coordinator = {
      currentSelection: vi.fn(() => ({
        projectId: "desktop-project-1",
        canvasId: selectedCanvasId
      })),
      status: vi.fn(() => ({ state: "running" })),
      start: vi.fn(async () => ({ state: "running" })),
      currentSelectionIsTrusted: vi.fn(() => true),
      recognizesLocalProfile: vi.fn(() => true),
      ownsLocalProfile: vi.fn(() => true),
      setCurrentSelection: vi.fn(async (selection: { projectId: string; canvasId: string }) => {
        selectedCanvasId = selection.canvasId;
        calls.push(`select:${selection.canvasId}`);
        if (selection.canvasId === "canvas-first") await firstSelectionBlocked;
      }),
      clearCurrentSelection: vi.fn(async () => undefined),
      localProfile: vi.fn(() => ({ ...profile, projectId: selectedCanvasId })),
      localProfileForId: vi.fn(() => ({ ...profile, projectId: selectedCanvasId })),
      registerCurrentProject: vi.fn(() => {
        calls.push(`register:${selectedCanvasId}`);
        return {
          workspaceId: "workspace-1",
          projectId: selectedCanvasId,
          canvasId: selectedCanvasId,
          profileId: profile.profileId,
          registeredAt: "2030-01-01T00:00:00.000Z"
        };
      }),
      registerLocalProfile: vi.fn(() => {
        calls.push(`register:${selectedCanvasId}`);
        return {
          workspaceId: "workspace-1",
          projectId: selectedCanvasId,
          canvasId: selectedCanvasId,
          profileId: profile.profileId,
          registeredAt: "2030-01-01T00:00:00.000Z"
        };
      })
    };
    const service = {
      upsertProfile: vi.fn(async () => undefined),
      migrateLocalProfileCredential: vi.fn(async () => undefined),
      adoptWorkspaceAuthority: vi.fn(async () => undefined),
      setActiveProfile: vi.fn(async () => undefined),
      activeHumanPrincipalId: vi.fn(async () => "human-owner"),
      bootstrapOwner: vi.fn(async () => {
        throw new Error("bootstrap must not run for a persisted owner");
      }),
      connectSession: vi.fn(async () => {
        calls.push(`connect:${selectedCanvasId}`);
      }),
      migrateLegacyLocalOwnerDisplayName: vi.fn(async () => {
        calls.push(`migrate-owner-name:${selectedCanvasId}`);
        return false;
      }),
      clearActiveProfile: vi.fn(async () => undefined),
      getStatus: vi.fn(async () => ({
        activeProfileId: profile.profileId,
        profiles: [{ profileId: profile.profileId, hasDeviceCredential: true }],
        session: { phase: "connected" }
      })),
      runStatusPublicationTransaction: vi.fn(async <T>(operation: () => Promise<T>) => operation())
    };
    const command = createLocalCollaborationActivationCommand({ coordinator, service });

    const first = command.activate({
      selection: { projectId: "desktop-project-1", canvasId: "canvas-first" }
    });
    await vi.waitFor(() => expect(calls).toEqual(["select:canvas-first"]));
    const second = command.activate({
      selection: { projectId: "desktop-project-1", canvasId: "canvas-second" }
    });
    await Promise.resolve();
    expect(calls).toEqual(["select:canvas-first"]);

    releaseFirstSelection();
    await Promise.all([first, second]);
    expect(calls).toEqual([
      "select:canvas-first",
      "register:canvas-first",
      "connect:canvas-first",
      "migrate-owner-name:canvas-first",
      "select:canvas-second",
      "register:canvas-second",
      "connect:canvas-second",
      "migrate-owner-name:canvas-second"
    ]);
  });
});
