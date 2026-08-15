import { mkdtemp } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesktopProjectSummary } from "@planweave-ai/runtime";
import {
  exampleBootstrapResponse,
  exampleInvitationToken,
  exampleMemberPage
} from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import { parseCollaborationInvitationHandoffV2 } from "@planweave-ai/collaboration-protocol/handoff/invitation";
import {
  loopbackServerLifecycleRequestSchema,
  type LoopbackProjectRegistrationView,
  type LoopbackServerStatus,
  type LoopbackTrustedProjectScope
} from "@planweave-ai/collaboration-protocol/loopback";
import {
  TailscaleExposureError,
  type ServerConfig,
  type TailscaleControlPort
} from "@planweave-ai/server";
import { describe, expect, it, vi } from "vitest";
import { LocalCollaborationCoordinatorControl } from "../main/collaboration/CollaborationCoordinatorControl";
import { CollaborationCredentialVault } from "../main/collaboration/collaborationCredentialVault";
import { CollaborationInvitationHandoffCoordinator } from "../main/collaboration/CollaborationInvitationHandoffCoordinator";
import { CollaborationProfileStore } from "../main/collaboration/collaborationProfileStore";
import { CollaborationService } from "../main/collaboration/collaborationService";
import { createLocalCollaborationActivationCommand } from "../main/collaboration/localCollaborationSelectionActivation";
import { switchLocalCollaborationExposure } from "../main/collaboration/localCollaborationExposureSwitch";
import {
  ManagedPrivateHttpsExposureError,
  TailscaleManagedPrivateHttpsAdapter
} from "../main/collaboration/managedPrivateHttpsExposure";

const project: DesktopProjectSummary = {
  projectId: "project-1",
  name: "Project",
  kind: "external",
  rootPath: "/test/project",
  sourceRoot: "/test/project",
  workspaceRoot: "/test/project",
  activeCanvasId: "canvas-1",
  taskCanvases: [
    {
      canvasId: "canvas-1",
      name: "Canvas",
      packageDir: "/test/project/package",
      executionPolicy: null,
      taskCount: 0,
      missingPromptCount: 0,
      diagnostics: [],
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:00.000Z"
    }
  ]
};

const nextProject: DesktopProjectSummary = {
  ...project,
  projectId: "project-2",
  rootPath: "/test/next-project",
  sourceRoot: "/test/next-project",
  workspaceRoot: "/test/next-project"
};
const authorityProjectId = "authority-project-1";

const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: () => Buffer.alloc(0),
  decryptString: () => ""
};

function scopeStore(
  initial = [
    { projectId: project.projectId, canvasId: "canvas-1" },
    { projectId: nextProject.projectId, canvasId: "canvas-1" }
  ]
) {
  let scopes = [...initial];
  return {
    read: vi.fn(async () => [...scopes]),
    write: vi.fn(async (next: typeof scopes) => {
      scopes = [...next];
    })
  };
}

function networkStore(initial = false, initialPreferredPort: number | null = null) {
  let lanSharingEnabled = initial;
  let preferredPort: number | null = initialPreferredPort;
  return {
    read: vi.fn(async () => ({ lanSharingEnabled, preferredPort })),
    write: vi.fn(async (next: { lanSharingEnabled: boolean; preferredPort: number | null }) => {
      lanSharingEnabled = next.lanSharingEnabled;
      preferredPort = next.preferredPort;
    })
  };
}

function fakeControl(
  options: {
    scopes?: readonly LoopbackTrustedProjectScope[];
    pauseStop?: boolean;
    startFailures?: number;
  } = {}
) {
  let status: LoopbackServerStatus = {
    profile: null,
    state: "stopped",
    startedAt: null,
    reason: null
  };
  const scopes = options.scopes ?? [
    { workspaceId: "workspace-2", projectId: authorityProjectId, canvasId: "canvas-1" }
  ];
  let startFailures = options.startFailures ?? 0;
  let releaseStop: (() => void) | null = null;
  const stopGate = options.pauseStop
    ? new Promise<void>((resolve) => {
        releaseStop = resolve;
      })
    : Promise.resolve();
  const apply = vi.fn(async (input: unknown) => {
    const request = loopbackServerLifecycleRequestSchema.parse(input);
    if (request.action === "start") {
      if (startFailures > 0) {
        startFailures -= 1;
        status = {
          profile: request.profile,
          state: "error",
          startedAt: null,
          reason: "start_failed"
        };
        return status;
      }
      status = {
        profile: request.profile,
        state: "running",
        startedAt: "2030-01-01T00:00:00.000Z",
        reason: null
      };
      return status;
    }
    await stopGate;
    status = { profile: null, state: "stopped", startedAt: null, reason: null };
    return status;
  });
  const registerTrustedProject = vi.fn(
    (
      _actor: { kind: "human"; id: string },
      request: {
        workspaceId: string;
        projectId: string;
        canvasId: string;
        profileId: string;
      }
    ): LoopbackProjectRegistrationView => ({
      ...request,
      registeredAt: "2030-01-01T00:00:01.000Z"
    })
  );
  return {
    apply,
    releaseStop: () => releaseStop?.(),
    registerTrustedProject,
    control: {
      status: () => status,
      apply,
      listTrustedProjectScopes: () => scopes,
      registerTrustedProject
    }
  };
}

function tailscaleControl(): TailscaleControlPort {
  return {
    inspectNode: vi.fn().mockResolvedValue({
      version: "1.90.1",
      nodeIdentitySha256: "a".repeat(64),
      dnsName: "planweave.example.ts.net"
    }),
    inspectServe: vi.fn().mockResolvedValue({ config: null }),
    ensurePrivateHttps: vi.fn().mockResolvedValue({ config: null }),
    releasePrivateHttps: vi.fn().mockResolvedValue(undefined)
  };
}

describe("LocalCollaborationCoordinatorControl", () => {
  it("starts selected scopes when LAN sharing is enabled from a stopped state", async () => {
    const fake = fakeControl();
    const control = new LocalCollaborationCoordinatorControl({
      safeStorage,
      syncOperatorProfile: async () => undefined,
      scopeStore: scopeStore([{ projectId: project.projectId, canvasId: "canvas-1" }]),
      networkStore: networkStore(),
      resolveLanAddress: () => "192.168.1.20",
      projects: {
        listProjects: async () => [project],
        resolveAuthorityProjectId: async () => authorityProjectId
      },
      createController: () => fake.control,
      allocatePort: async () => 18_787
    });

    await expect(control.setLanSharing({ enabled: true })).resolves.toMatchObject({
      state: "running",
      lanSharingEnabled: true,
      lanServerBaseUrl: "http://192.168.1.20:18787/"
    });
  });

  it("recovers a stopped service when LAN sharing is already enabled", async () => {
    const fake = fakeControl();
    const storedNetwork = networkStore(true);
    const control = new LocalCollaborationCoordinatorControl({
      safeStorage,
      syncOperatorProfile: async () => undefined,
      scopeStore: scopeStore([{ projectId: project.projectId, canvasId: "canvas-1" }]),
      networkStore: storedNetwork,
      resolveLanAddress: () => "192.168.1.20",
      projects: {
        listProjects: async () => [project],
        resolveAuthorityProjectId: async () => authorityProjectId
      },
      createController: () => fake.control,
      allocatePort: async () => 18_787
    });

    await control.restore();
    await control.stop();
    storedNetwork.write.mockClear();

    await expect(control.setLanSharing({ enabled: true })).resolves.toMatchObject({
      state: "running",
      lanSharingEnabled: true,
      lanServerBaseUrl: "http://192.168.1.20:18787/"
    });
    expect(storedNetwork.write).not.toHaveBeenCalled();
  });

  it("publishes selected canvases on a private LAN address and persists the switch", async () => {
    const fake = fakeControl();
    const storedNetwork = networkStore();
    const allocatePort = vi.fn(async () => 18_787);
    let configFactory:
      | ((profile: NonNullable<LoopbackServerStatus["profile"]>) => ServerConfig)
      | undefined;
    const control = new LocalCollaborationCoordinatorControl({
      safeStorage,
      syncOperatorProfile: async () => undefined,
      scopeStore: scopeStore([{ projectId: project.projectId, canvasId: "canvas-1" }]),
      networkStore: storedNetwork,
      resolveLanAddress: () => "192.168.1.20",
      projects: {
        listProjects: async () => [project],
        resolveAuthorityProjectId: async () => authorityProjectId
      },
      createController: (createConfig) => {
        configFactory = createConfig;
        return fake.control;
      },
      allocatePort
    });

    await control.setLanSharing({ enabled: true });
    const status = await control.start();
    expect(status).toMatchObject({
      state: "running",
      lanSharingEnabled: true,
      lanServerBaseUrl: "http://192.168.1.20:18787/"
    });
    expect(allocatePort).toHaveBeenCalledWith("0.0.0.0", null);
    expect(storedNetwork.write).toHaveBeenCalledWith({
      lanSharingEnabled: true,
      exposureMode: "lan_http",
      preferredPort: 18_787
    });
    expect(configFactory!(status.profile!)).toMatchObject({
      version: "server-config/v2",
      transport: {
        mode: "lan_http",
        listener: { protocol: "http", host: "0.0.0.0", port: 18_787 },
        advertisedOrigin: "http://192.168.1.20:18787"
      },
      insecurePolicy: { allowInsecureTransport: true, allowInsecureLan: true }
    });
    expect(status.profile?.serverBaseUrl).toBe("http://127.0.0.1:18787/");
  });

  it("restores the persisted network switch and starts selected scopes automatically", async () => {
    const fake = fakeControl();
    const control = new LocalCollaborationCoordinatorControl({
      safeStorage,
      syncOperatorProfile: async () => undefined,
      scopeStore: scopeStore([{ projectId: project.projectId, canvasId: "canvas-1" }]),
      networkStore: networkStore(true),
      resolveLanAddress: () => "10.0.0.15",
      projects: {
        listProjects: async () => [project],
        resolveAuthorityProjectId: async () => authorityProjectId
      },
      createController: () => fake.control,
      allocatePort: async () => 18_788
    });

    await expect(control.restore()).resolves.toMatchObject({
      state: "running",
      lanSharingEnabled: true,
      lanServerBaseUrl: "http://10.0.0.15:18788/"
    });
  });

  it("keeps persisted private HTTPS provider failures as an actionable offline state", async () => {
    const tailscale = tailscaleControl();
    vi.mocked(tailscale.inspectNode).mockRejectedValue(
      new TailscaleExposureError("TAILSCALE_JSON_INVALID")
    );
    const control = new LocalCollaborationCoordinatorControl({
      safeStorage,
      syncOperatorProfile: async () => undefined,
      scopeStore: scopeStore([{ projectId: project.projectId, canvasId: "canvas-1" }]),
      networkStore: {
        read: vi.fn(async () => ({
          lanSharingEnabled: false,
          exposureMode: "private_https" as const,
          preferredPort: null
        })),
        write: vi.fn(async () => undefined)
      },
      privateHttpsExposure: new TailscaleManagedPrivateHttpsAdapter(tailscale),
      projects: {
        listProjects: async () => [project],
        resolveAuthorityProjectId: async () => authorityProjectId
      },
      createController: () => fakeControl().control,
      allocatePort: async () => 18_788
    });

    await expect(control.restore()).resolves.toMatchObject({
      state: "stopped",
      profile: null
    });
    expect(control.getExposureView()).toMatchObject({
      mode: "private_https",
      lifecycle: "error",
      advertisedOrigin: null,
      errorCode: "PRIVATE_HTTPS_PROVIDER_UNAVAILABLE",
      canActivate: true,
      canInvite: false
    });

    const service = {
      getStatus: vi.fn(async () => ({
        activeProfileId: "planweave-local-stale",
        profiles: [{ profileId: "planweave-local-stale", hasDeviceCredential: true }],
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
    const activation = createLocalCollaborationActivationCommand({ coordinator: control, service });

    await expect(
      activation.selectAndReconcile({ projectId: project.projectId, canvasId: "canvas-1" })
    ).resolves.toBeNull();
    expect(control.currentSelection()).toEqual({
      projectId: project.projectId,
      canvasId: "canvas-1"
    });
    expect(control.getExposureView()).toMatchObject({
      lifecycle: "error",
      errorCode: "PRIVATE_HTTPS_PROVIDER_UNAVAILABLE"
    });
  });

  it("does not hide unexpected failures while restoring persisted private HTTPS", async () => {
    const control = new LocalCollaborationCoordinatorControl({
      safeStorage,
      syncOperatorProfile: async () => undefined,
      scopeStore: scopeStore([{ projectId: project.projectId, canvasId: "canvas-1" }]),
      networkStore: {
        read: vi.fn(async () => ({
          lanSharingEnabled: false,
          exposureMode: "private_https" as const,
          preferredPort: null
        })),
        write: vi.fn(async () => undefined)
      },
      privateHttpsExposure: new TailscaleManagedPrivateHttpsAdapter(tailscaleControl()),
      projects: {
        listProjects: async () => [project],
        resolveAuthorityProjectId: async () => authorityProjectId
      },
      createController: () => fakeControl().control,
      allocatePort: async () => {
        throw new Error("unexpected_port_failure");
      }
    });

    await expect(control.restore()).rejects.toThrow("unexpected_port_failure");
  });

  it("restores the local management profile without requiring a current canvas selection", async () => {
    const fake = fakeControl();
    const syncOperatorProfile = vi.fn().mockResolvedValue(undefined);
    const control = new LocalCollaborationCoordinatorControl({
      safeStorage,
      syncOperatorProfile,
      scopeStore: scopeStore([{ projectId: project.projectId, canvasId: "canvas-1" }]),
      networkStore: networkStore(),
      projects: {
        listProjects: async () => [project],
        resolveAuthorityProjectId: async () => authorityProjectId
      },
      createController: () => fake.control,
      allocatePort: async () => 18_788
    });

    await expect(control.restore()).resolves.toMatchObject({ state: "running" });
    expect(control.currentSelection()).toBeNull();
    expect(control.invitationEndpoint()).toBeNull();
    const localProfileId = `planweave-local-${createHash("sha256")
      .update(authorityProjectId)
      .digest("hex")
      .slice(0, 24)}`;
    expect(control.localProfileForId(localProfileId)).toMatchObject({
      profileId: localProfileId,
      projectId: authorityProjectId,
      serverBaseUrl: "http://127.0.0.1:18788/"
    });
    expect(syncOperatorProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({
          profileId: "planweave-local-loopback",
          endpoint: expect.objectContaining({
            topology: "loopback_http",
            serverOrigin: "http://127.0.0.1:18788/"
          })
        }),
        operatorId: "desktop-local-admin",
        operatorToken: expect.any(String)
      })
    );

    syncOperatorProfile.mockClear();
    await control.reconcileManagementProfile();
    expect(syncOperatorProfile).toHaveBeenCalledOnce();

    syncOperatorProfile.mockClear();
    await expect(control.start()).resolves.toMatchObject({ state: "running" });
    expect(fake.apply).toHaveBeenCalledOnce();
    expect(syncOperatorProfile).toHaveBeenCalledOnce();
  });

  it("reuses the advertised LAN port after a full coordinator restart", async () => {
    const storedNetwork = networkStore(true);
    const first = fakeControl();
    const firstAllocatePort = vi.fn(
      async (_host: string, preferredPort?: number | null) => preferredPort ?? 18_787
    );
    const firstControl = new LocalCollaborationCoordinatorControl({
      safeStorage,
      syncOperatorProfile: async () => undefined,
      scopeStore: scopeStore([{ projectId: project.projectId, canvasId: "canvas-1" }]),
      networkStore: storedNetwork,
      resolveLanAddress: () => "192.168.1.20",
      projects: {
        listProjects: async () => [project],
        resolveAuthorityProjectId: async () => authorityProjectId
      },
      createController: () => first.control,
      allocatePort: firstAllocatePort
    });

    await expect(firstControl.restore()).resolves.toMatchObject({
      lanServerBaseUrl: "http://192.168.1.20:18787/"
    });
    await firstControl.stop();

    const second = fakeControl();
    const secondAllocatePort = vi.fn(
      async (_host: string, preferredPort?: number | null) => preferredPort ?? 19_999
    );
    const secondControl = new LocalCollaborationCoordinatorControl({
      safeStorage,
      syncOperatorProfile: async () => undefined,
      scopeStore: scopeStore([{ projectId: project.projectId, canvasId: "canvas-1" }]),
      networkStore: storedNetwork,
      resolveLanAddress: () => "192.168.1.20",
      projects: {
        listProjects: async () => [project],
        resolveAuthorityProjectId: async () => authorityProjectId
      },
      createController: () => second.control,
      allocatePort: secondAllocatePort
    });

    await expect(secondControl.restore()).resolves.toMatchObject({
      lanServerBaseUrl: "http://192.168.1.20:18787/"
    });
    expect(secondAllocatePort).toHaveBeenCalledWith("0.0.0.0", 18_787);
  });

  it("allocates and persists a replacement when the preferred port is unavailable", async () => {
    const storedNetwork = networkStore(true, 18_787);
    const fake = fakeControl();
    const allocatePort = vi.fn(async (_host: string, preferredPort: number | null) => {
      if (preferredPort === 18_787) {
        throw new Error("EADDRINUSE");
      }
      return 19_999;
    });
    const control = new LocalCollaborationCoordinatorControl({
      safeStorage,
      syncOperatorProfile: async () => undefined,
      scopeStore: scopeStore([{ projectId: project.projectId, canvasId: "canvas-1" }]),
      networkStore: storedNetwork,
      resolveLanAddress: () => "192.168.1.20",
      projects: {
        listProjects: async () => [project],
        resolveAuthorityProjectId: async () => authorityProjectId
      },
      createController: () => fake.control,
      allocatePort
    });

    await expect(control.restore()).resolves.toMatchObject({
      lanServerBaseUrl: "http://192.168.1.20:19999/"
    });
    expect(allocatePort).toHaveBeenNthCalledWith(1, "0.0.0.0", 18_787);
    expect(allocatePort).toHaveBeenNthCalledWith(2, "0.0.0.0", null);
    expect(storedNetwork.write).toHaveBeenLastCalledWith({
      lanSharingEnabled: true,
      exposureMode: "lan_http",
      preferredPort: 19_999
    });
  });

  it("starts with only the explicitly selected project and canvas scopes", async () => {
    const secondCanvasProject: DesktopProjectSummary = {
      ...project,
      taskCanvases: [
        ...project.taskCanvases,
        { ...project.taskCanvases[0]!, canvasId: "canvas-2", name: "Canvas 2" }
      ]
    };
    let configFactory:
      | ((profile: NonNullable<LoopbackServerStatus["profile"]>) => ServerConfig)
      | undefined;
    let ownerTrustedProjects: ServerConfig["trustedProjects"] | undefined;
    const fake = fakeControl();
    const control = new LocalCollaborationCoordinatorControl({
      safeStorage,
      syncOperatorProfile: async () => undefined,
      scopeStore: scopeStore([]),
      networkStore: networkStore(),
      projects: {
        listProjects: async () => [secondCanvasProject, nextProject],
        resolveAuthorityProjectId: async (root, canvasId) =>
          `${root === nextProject.rootPath ? "authority-project-2" : authorityProjectId}-${canvasId}`
      },
      createController: (createConfig, _onLifecycleError, ownerProjects) => {
        configFactory = createConfig;
        ownerTrustedProjects = ownerProjects;
        return fake.control;
      },
      allocatePort: async () => 18_787
    });

    await control.setCurrentSelection({ projectId: project.projectId, canvasId: "canvas-1" });
    await control.setTrustedScopes({
      scopes: [
        { projectId: project.projectId, canvasId: "canvas-2" },
        { projectId: nextProject.projectId, canvasId: "canvas-1" }
      ]
    });
    const catalog = await control.getScopeCatalog();
    expect(catalog.selectedCount).toBe(2);

    const status = await control.start();
    expect(status.state).toBe("running");
    expect(
      configFactory!(status.profile! as NonNullable<LoopbackServerStatus["profile"]>)
        .trustedProjects
    ).toEqual([
      expect.objectContaining({
        projectId: `${authorityProjectId}-canvas-2`,
        canvasId: "canvas-2"
      }),
      expect.objectContaining({ projectId: "authority-project-2-canvas-1", canvasId: "canvas-1" })
    ]);
    expect(ownerTrustedProjects).toEqual([
      expect.objectContaining({
        projectId: `${authorityProjectId}-canvas-1`,
        canvasId: "canvas-1",
        trustAllDeclaredCanvases: false
      }),
      expect.objectContaining({
        projectId: `${authorityProjectId}-canvas-2`,
        canvasId: "canvas-2",
        trustAllDeclaredCanvases: false
      }),
      expect.objectContaining({
        projectId: "authority-project-2-canvas-1",
        canvasId: "canvas-1",
        trustAllDeclaredCanvases: false
      })
    ]);
    expect(ownerTrustedProjects).toHaveLength(3);
  });

  it("starts the Owner Fleet without any collaboration canvas scope", async () => {
    let configFactory:
      | ((profile: NonNullable<LoopbackServerStatus["profile"]>) => ServerConfig)
      | undefined;
    let ownerTrustedProjects: ServerConfig["trustedProjects"] | undefined;
    const fake = fakeControl();
    const control = new LocalCollaborationCoordinatorControl({
      safeStorage,
      syncOperatorProfile: async () => undefined,
      scopeStore: scopeStore([]),
      networkStore: networkStore(),
      projects: {
        listProjects: async () => [project],
        resolveAuthorityProjectId: async () => authorityProjectId
      },
      createController: (createConfig, _onLifecycleError, ownerProjects) => {
        configFactory = createConfig;
        ownerTrustedProjects = ownerProjects;
        return fake.control;
      },
      allocatePort: async () => 18_787
    });

    const status = await control.start();

    expect(status.state).toBe("running");
    expect(
      configFactory!(status.profile! as NonNullable<LoopbackServerStatus["profile"]>)
        .trustedProjects
    ).toEqual([]);
    expect(ownerTrustedProjects).toEqual([
      expect.objectContaining({
        projectId: authorityProjectId,
        canvasId: "canvas-1",
        trustAllDeclaredCanvases: false
      })
    ]);
  });

  it("reloads the Owner runtime when a newly declared canvas is selected", async () => {
    let catalog = project;
    const ownerCatalogs: ServerConfig["trustedProjects"][] = [];
    const fake = fakeControl();
    const control = new LocalCollaborationCoordinatorControl({
      safeStorage,
      syncOperatorProfile: async () => undefined,
      scopeStore: scopeStore([]),
      networkStore: networkStore(),
      projects: {
        listProjects: async () => [catalog],
        resolveAuthorityProjectId: async () => authorityProjectId
      },
      createController: (_createConfig, _onLifecycleError, ownerProjects) => {
        ownerCatalogs.push(ownerProjects);
        return fake.control;
      },
      allocatePort: async () => 18_787
    });

    await expect(control.start()).resolves.toMatchObject({ state: "running" });
    catalog = {
      ...project,
      taskCanvases: [
        ...project.taskCanvases,
        { ...project.taskCanvases[0]!, canvasId: "canvas-2", name: "Canvas 2" }
      ]
    };

    await control.setCurrentSelection({ projectId: project.projectId, canvasId: "canvas-2" });

    expect(fake.apply).toHaveBeenCalledTimes(3);
    expect(ownerCatalogs.at(-1)).toEqual([
      expect.objectContaining({ canvasId: "canvas-1" }),
      expect.objectContaining({ canvasId: "canvas-2" })
    ]);
  });

  it("resolves opaque selection, registers its exact trusted scope, and only stops explicitly", async () => {
    const fake = fakeControl({ pauseStop: true });
    const resolveAuthorityProjectId = vi.fn().mockResolvedValue(authorityProjectId);
    const control = new LocalCollaborationCoordinatorControl({
      safeStorage,
      syncOperatorProfile: async () => undefined,
      scopeStore: scopeStore([{ projectId: project.projectId, canvasId: "canvas-1" }]),
      networkStore: networkStore(),
      projects: { listProjects: async () => [project], resolveAuthorityProjectId },
      createController: () => fake.control,
      allocatePort: async () => 18_787
    });

    await control.setCurrentSelection({ projectId: project.projectId, canvasId: "canvas-1" });
    await control.start();
    expect(control.listActiveTrustedScopes()).toEqual([
      { workspaceId: "workspace-2", projectId: authorityProjectId, canvasId: "canvas-1" }
    ]);
    expect(control.registerCurrentProject({ kind: "human", id: "owner-1" })).toMatchObject({
      workspaceId: "workspace-2",
      projectId: authorityProjectId,
      canvasId: "canvas-1"
    });
    expect(fake.registerTrustedProject).toHaveBeenCalledWith(
      { kind: "human", id: "owner-1" },
      expect.objectContaining({
        workspaceId: "workspace-2",
        projectId: authorityProjectId,
        canvasId: "canvas-1"
      })
    );
    const localProfileId = control.localProfile()!.profileId;
    expect(control.ownsLocalProfile(localProfileId)).toBe(true);
    expect(control.ownsLocalProfile("remote-team")).toBe(false);

    await control.clearCurrentSelection();
    expect(control.status().state).toBe("running");
    expect(control.ownsLocalProfile(localProfileId)).toBe(true);

    const stop = control.stop();
    await vi.waitFor(() => {
      expect(fake.apply).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: "stop",
          profileId: expect.stringMatching(/^planweave-local-/)
        })
      );
    });
    expect(control.status().state).toBe("running");
    fake.releaseStop();
    await stop;
    expect(control.status().state).toBe("stopped");
    expect(resolveAuthorityProjectId).toHaveBeenCalledWith("/test/project", "canvas-1");
  });

  it("rejects unknown, ambiguous, or duplicate trusted opaque selections", async () => {
    const duplicateScope = {
      workspaceId: "workspace-3",
      projectId: authorityProjectId,
      canvasId: "canvas-1"
    };
    const fake = fakeControl({
      scopes: [
        { workspaceId: "workspace-2", projectId: authorityProjectId, canvasId: "canvas-1" },
        duplicateScope
      ]
    });
    const control = new LocalCollaborationCoordinatorControl({
      safeStorage,
      syncOperatorProfile: async () => undefined,
      scopeStore: scopeStore([{ projectId: project.projectId, canvasId: "canvas-1" }]),
      networkStore: networkStore(),
      projects: {
        listProjects: async () => [project, project],
        resolveAuthorityProjectId: async () => authorityProjectId
      },
      createController: () => fake.control,
      allocatePort: async () => 18_787
    });

    await expect(
      control.setCurrentSelection({ projectId: project.projectId, canvasId: "canvas-1" })
    ).rejects.toThrow("local_collaboration_project_selection_ambiguous");
    await expect(
      control.setCurrentSelection({ projectId: "unknown", canvasId: "canvas-1" })
    ).rejects.toThrow("local_collaboration_project_selection_ambiguous");

    const unambiguousControl = new LocalCollaborationCoordinatorControl({
      safeStorage,
      syncOperatorProfile: async () => undefined,
      scopeStore: scopeStore([{ projectId: project.projectId, canvasId: "canvas-1" }]),
      networkStore: networkStore(),
      projects: {
        listProjects: async () => [project],
        resolveAuthorityProjectId: async () => authorityProjectId
      },
      createController: () => fake.control,
      allocatePort: async () => 18_787
    });
    await unambiguousControl.setCurrentSelection({
      projectId: project.projectId,
      canvasId: "canvas-1"
    });
    await unambiguousControl.start();
    expect(() =>
      unambiguousControl.registerCurrentProject({ kind: "human", id: "owner-1" })
    ).toThrow("local_collaboration_trusted_scope_ambiguous");
  });

  it("keeps the device-local server running while switching project selections", async () => {
    const fake = fakeControl({
      scopes: [
        { workspaceId: "workspace-1", projectId: authorityProjectId, canvasId: "canvas-1" },
        { workspaceId: "workspace-2", projectId: "authority-project-2", canvasId: "canvas-1" }
      ]
    });
    const resolveAuthorityProjectId = vi.fn(async (projectRoot: string) =>
      projectRoot === nextProject.rootPath ? "authority-project-2" : authorityProjectId
    );
    let configFactory:
      | ((profile: NonNullable<LoopbackServerStatus["profile"]>) => ServerConfig)
      | undefined;
    const control = new LocalCollaborationCoordinatorControl({
      safeStorage,
      syncOperatorProfile: async () => undefined,
      scopeStore: scopeStore(),
      networkStore: networkStore(),
      projects: {
        listProjects: async () => [project, nextProject],
        resolveAuthorityProjectId
      },
      createController: (createConfig) => {
        configFactory = createConfig;
        return fake.control;
      },
      allocatePort: async () => 18_787
    });
    await control.setCurrentSelection({ projectId: project.projectId, canvasId: "canvas-1" });
    await control.start();
    const firstWorkspaceProfile = control.localProfile();
    expect(firstWorkspaceProfile).not.toBeNull();
    const firstProfileId = control.status().profile?.profileId;
    const runningProfile = control.status().profile;
    expect(runningProfile).not.toBeNull();
    const config = configFactory!(runningProfile!);
    expect(config.version).toBe("server-config/v2");
    expect(config.transport.mode).toBe("loopback_http");
    expect(config.trustedProjects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectId: authorityProjectId,
          projectRoot: project.rootPath,
          canvasId: "canvas-1"
        }),
        expect.objectContaining({
          projectId: "authority-project-2",
          projectRoot: nextProject.rootPath,
          canvasId: "canvas-1"
        })
      ])
    );
    expect(config.operatorCredentials).toEqual([
      expect.objectContaining({
        operatorId: "desktop-local-admin",
        projectIds: [],
        serverAdmin: true
      })
    ]);

    await control.setCurrentSelection({
      projectId: nextProject.projectId,
      canvasId: "canvas-1"
    });

    expect(fake.apply).toHaveBeenCalledTimes(1);
    expect(fake.apply).toHaveBeenLastCalledWith(expect.objectContaining({ action: "start" }));
    expect(control.status()).toMatchObject({ state: "running" });
    expect(control.status().profile?.profileId).toBe(firstProfileId);
    expect(control.localProfile()?.projectId).toBe("authority-project-2");
    expect(control.localProfile()?.profileId).not.toBe(firstProfileId);
    expect(control.localProfileForId(firstWorkspaceProfile!.profileId)).toMatchObject({
      profileId: firstWorkspaceProfile!.profileId,
      projectId: authorityProjectId
    });
    expect(
      control.registerLocalProfile(firstWorkspaceProfile!.profileId, {
        kind: "human",
        id: "owner-1"
      })
    ).toMatchObject({
      workspaceId: "workspace-1",
      projectId: authorityProjectId,
      canvasId: "canvas-1"
    });
    expect(control.registerCurrentProject({ kind: "human", id: "owner-2" })).toMatchObject({
      workspaceId: "workspace-2",
      projectId: "authority-project-2",
      canvasId: "canvas-1"
    });
    expect(resolveAuthorityProjectId).toHaveBeenLastCalledWith("/test/next-project", "canvas-1");
  });

  it("serializes a redundant start while switching without restarting the server", async () => {
    const fake = fakeControl({
      scopes: [
        { workspaceId: "workspace-1", projectId: authorityProjectId, canvasId: "canvas-1" },
        { workspaceId: "workspace-2", projectId: "authority-project-2", canvasId: "canvas-1" }
      ]
    });
    const control = new LocalCollaborationCoordinatorControl({
      safeStorage,
      syncOperatorProfile: async () => undefined,
      scopeStore: scopeStore(),
      networkStore: networkStore(),
      projects: {
        listProjects: async () => [project, nextProject],
        resolveAuthorityProjectId: async (projectRoot) =>
          projectRoot === nextProject.rootPath ? "authority-project-2" : authorityProjectId
      },
      createController: () => fake.control,
      allocatePort: async () => 18_787
    });
    await control.setCurrentSelection({ projectId: project.projectId, canvasId: "canvas-1" });
    await control.start();

    const switchSelection = control.setCurrentSelection({
      projectId: nextProject.projectId,
      canvasId: "canvas-1"
    });
    const startAfterSwitch = control.start();
    await switchSelection;

    await expect(startAfterSwitch).resolves.toMatchObject({ state: "running" });
    expect(control.status().state).toBe("running");
    expect(control.localProfile()?.projectId).toBe("authority-project-2");
    expect(fake.apply).toHaveBeenCalledTimes(1);
    expect(fake.apply).toHaveBeenLastCalledWith(expect.objectContaining({ action: "start" }));
  });

  it("keeps an unselected newly imported project private without restarting the server", async () => {
    const first = fakeControl({
      scopes: [{ workspaceId: "workspace-1", projectId: authorityProjectId, canvasId: "canvas-1" }]
    });
    const second = fakeControl({
      scopes: [
        { workspaceId: "workspace-1", projectId: authorityProjectId, canvasId: "canvas-1" },
        { workspaceId: "workspace-2", projectId: "authority-project-2", canvasId: "canvas-1" }
      ]
    });
    const listProjects = vi
      .fn()
      .mockResolvedValueOnce([project])
      .mockResolvedValueOnce([project])
      .mockResolvedValue([project, nextProject]);
    const createController = vi
      .fn()
      .mockReturnValueOnce(first.control)
      .mockReturnValueOnce(second.control);
    const control = new LocalCollaborationCoordinatorControl({
      safeStorage,
      syncOperatorProfile: async () => undefined,
      scopeStore: scopeStore([{ projectId: project.projectId, canvasId: "canvas-1" }]),
      networkStore: networkStore(),
      projects: {
        listProjects,
        resolveAuthorityProjectId: async (projectRoot) =>
          projectRoot === nextProject.rootPath ? "authority-project-2" : authorityProjectId
      },
      createController,
      allocatePort: async () => 18_787
    });

    await control.setCurrentSelection({ projectId: project.projectId, canvasId: "canvas-1" });
    await control.start();
    await control.setCurrentSelection({ projectId: nextProject.projectId, canvasId: "canvas-1" });

    expect(first.apply).toHaveBeenCalledTimes(1);
    expect(first.apply).toHaveBeenCalledWith(expect.objectContaining({ action: "start" }));
    expect(second.apply).not.toHaveBeenCalled();
    expect(control.status().state).toBe("running");
    expect(control.localProfile()).toBeNull();
    expect(() => control.registerCurrentProject({ kind: "human", id: "owner-2" })).toThrow(
      "local_collaboration_trusted_scope_ambiguous"
    );
  });

  it("retries a failed loopback start with a fresh literal-loopback port and controller", async () => {
    const first = fakeControl({ startFailures: 1 });
    const second = fakeControl();
    const createController = vi
      .fn()
      .mockReturnValueOnce(first.control)
      .mockReturnValueOnce(second.control);
    const allocatePort = vi.fn().mockResolvedValueOnce(18_788).mockResolvedValueOnce(18_789);
    const control = new LocalCollaborationCoordinatorControl({
      safeStorage,
      syncOperatorProfile: async () => undefined,
      scopeStore: scopeStore([{ projectId: project.projectId, canvasId: "canvas-1" }]),
      networkStore: networkStore(),
      projects: {
        listProjects: async () => [project],
        resolveAuthorityProjectId: async () => authorityProjectId
      },
      createController,
      allocatePort
    });
    await control.setCurrentSelection({ projectId: project.projectId, canvasId: "canvas-1" });

    await expect(control.start()).resolves.toMatchObject({ state: "running" });
    expect(allocatePort).toHaveBeenCalledTimes(2);
    expect(createController).toHaveBeenCalledTimes(2);
    expect(first.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "start",
        profile: expect.objectContaining({ serverBaseUrl: "http://127.0.0.1:18788/" })
      })
    );
    expect(second.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "start",
        profile: expect.objectContaining({ serverBaseUrl: "http://127.0.0.1:18789/" })
      })
    );
  });

  it("reports start failure after the bounded loopback allocation retries are exhausted", async () => {
    const controls = [
      fakeControl({ startFailures: 1 }),
      fakeControl({ startFailures: 1 }),
      fakeControl({ startFailures: 1 })
    ];
    const createController = vi.fn(() => {
      const next = controls.shift();
      if (!next) throw new Error("unexpected_loopback_controller_creation");
      return next.control;
    });
    const allocatePort = vi
      .fn()
      .mockResolvedValueOnce(18_790)
      .mockResolvedValueOnce(18_791)
      .mockResolvedValueOnce(18_792);
    const control = new LocalCollaborationCoordinatorControl({
      safeStorage,
      syncOperatorProfile: async () => undefined,
      scopeStore: scopeStore([{ projectId: project.projectId, canvasId: "canvas-1" }]),
      networkStore: networkStore(),
      projects: {
        listProjects: async () => [project],
        resolveAuthorityProjectId: async () => authorityProjectId
      },
      createController,
      allocatePort
    });
    await control.setCurrentSelection({ projectId: project.projectId, canvasId: "canvas-1" });

    await expect(control.start()).resolves.toMatchObject({
      state: "error",
      reason: "start_failed"
    });
    expect(allocatePort).toHaveBeenCalledTimes(3);
    expect(createController).toHaveBeenCalledTimes(3);
    expect(control.localProfile()).toBeNull();
  });

  it("activates Tailscale with a loopback backend and exposes only the advertised endpoint", async () => {
    const fake = fakeControl();
    const syncOperatorProfile = vi.fn().mockResolvedValue(undefined);
    let configFactory:
      | ((profile: NonNullable<LoopbackServerStatus["profile"]>) => ServerConfig)
      | undefined;
    const control = new LocalCollaborationCoordinatorControl({
      safeStorage,
      syncOperatorProfile,
      scopeStore: scopeStore([{ projectId: project.projectId, canvasId: "canvas-1" }]),
      networkStore: networkStore(),
      privateHttpsExposure: new TailscaleManagedPrivateHttpsAdapter(tailscaleControl()),
      projects: {
        listProjects: async () => [project],
        resolveAuthorityProjectId: async () => authorityProjectId
      },
      createController: (createConfig) => {
        configFactory = createConfig;
        return fake.control;
      },
      allocatePort: async () => 18_787
    });
    await control.setCurrentSelection({ projectId: project.projectId, canvasId: "canvas-1" });

    await expect(control.setExposureMode({ mode: "private_https" })).resolves.toMatchObject({
      mode: "private_https",
      topology: "private_https",
      provider: { id: "tailscale", displayName: "Tailscale" },
      lifecycle: "ready",
      advertisedOrigin: "https://planweave.example.ts.net/",
      errorCode: null,
      canInvite: true
    });
    expect(control.status().profile).toMatchObject({
      serverBaseUrl: "https://planweave.example.ts.net/",
      allowInsecureTransport: false
    });
    expect(configFactory!(control.status().profile!)).toMatchObject({
      transport: {
        mode: "reverse_proxy_https",
        listener: { protocol: "http", host: "127.0.0.1", port: 18_787 },
        advertisedOrigin: "https://planweave.example.ts.net"
      }
    });
    expect(syncOperatorProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({
          endpoint: expect.objectContaining({
            topology: "private_https",
            serverOrigin: "https://planweave.example.ts.net/"
          })
        }),
        operatorToken: expect.any(String)
      })
    );
    expect(JSON.stringify(control.getExposureView())).not.toMatch(
      /127\.0\.0\.1|backend|lease|stdout|stderr|token/i
    );
  });

  it.each([
    ["TAILSCALE_NOT_INSTALLED", "PRIVATE_HTTPS_PROVIDER_NOT_INSTALLED"],
    ["TAILSCALE_LOGIN_REQUIRED", "PRIVATE_HTTPS_PROVIDER_AUTH_REQUIRED"],
    ["TAILSCALE_HTTPS_UNAVAILABLE", "PRIVATE_HTTPS_CERTIFICATE_UNAVAILABLE"]
  ] as const)("maps %s to stable %s without raw details", async (providerCode, expectedCode) => {
    const tailscale = tailscaleControl();
    vi.mocked(tailscale.inspectNode).mockRejectedValue(
      new TailscaleExposureError(providerCode, { cause: new Error("secret stderr output") })
    );
    const control = new LocalCollaborationCoordinatorControl({
      safeStorage,
      syncOperatorProfile: async () => undefined,
      scopeStore: scopeStore([{ projectId: project.projectId, canvasId: "canvas-1" }]),
      networkStore: networkStore(),
      privateHttpsExposure: new TailscaleManagedPrivateHttpsAdapter(tailscale),
      projects: {
        listProjects: async () => [project],
        resolveAuthorityProjectId: async () => authorityProjectId
      },
      createController: () => fakeControl().control,
      allocatePort: async () => 18_787
    });

    const view = await control.setExposureMode({ mode: "private_https" });
    expect(view).toMatchObject({
      lifecycle: "error",
      advertisedOrigin: null,
      errorCode: expectedCode,
      canInvite: false
    });
    expect(JSON.stringify(view)).not.toContain("secret stderr output");
  });

  it("preserves a stable Serve conflict code reported by the server lifecycle", async () => {
    const fake = fakeControl({ startFailures: 3 });
    const createController = vi.fn(
      (
        _createConfig: (profile: NonNullable<LoopbackServerStatus["profile"]>) => ServerConfig,
        onLifecycleError: (error: unknown) => void
      ) => {
        onLifecycleError(new ManagedPrivateHttpsExposureError("PRIVATE_HTTPS_ROUTE_CONFLICT"));
        return fake.control;
      }
    );
    const control = new LocalCollaborationCoordinatorControl({
      safeStorage,
      syncOperatorProfile: async () => undefined,
      scopeStore: scopeStore([{ projectId: project.projectId, canvasId: "canvas-1" }]),
      networkStore: networkStore(),
      privateHttpsExposure: new TailscaleManagedPrivateHttpsAdapter(tailscaleControl()),
      projects: {
        listProjects: async () => [project],
        resolveAuthorityProjectId: async () => authorityProjectId
      },
      createController,
      allocatePort: async () => 18_787
    });

    await expect(control.setExposureMode({ mode: "private_https" })).resolves.toMatchObject({
      lifecycle: "error",
      errorCode: "PRIVATE_HTTPS_ROUTE_CONFLICT",
      advertisedOrigin: null,
      canInvite: false
    });
  });

  it("keeps LAN and loopback profile authority identical through persistence and handoff", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-lan-authority-"));
    const fake = fakeControl();
    const control = new LocalCollaborationCoordinatorControl({
      safeStorage,
      syncOperatorProfile: async () => undefined,
      scopeStore: scopeStore([{ projectId: project.projectId, canvasId: "canvas-1" }]),
      networkStore: networkStore(),
      resolveLanAddress: () => "192.168.1.20",
      projects: {
        listProjects: async () => [project],
        resolveAuthorityProjectId: async () => authorityProjectId
      },
      createController: () => fake.control,
      allocatePort: async () => 18_787
    });
    const profileStore = new CollaborationProfileStore({
      profilesPath: join(root, "profiles.json")
    });
    const service = new CollaborationService({
      profileStore,
      vault: new CollaborationCredentialVault({
        paths: { credentialsPath: join(root, "credentials.json") },
        safeStorage
      }),
      workspaceProfileStorePaths: { profilesPath: join(root, "workspace-profiles.json") },
      invitationsPath: join(root, "invitations.json"),
      safeStorage,
      syncOperatorProfile: async () => undefined,
      createClient: () =>
        ({
          bootstrapOwner: vi.fn().mockResolvedValue({
            ...exampleBootstrapResponse,
            workspaceId: "workspace-2"
          }),
          listMembers: vi.fn().mockResolvedValue(exampleMemberPage),
          verifyAccess: vi.fn().mockResolvedValue(undefined),
          startObserver: vi.fn(),
          stopObserver: vi.fn(),
          stopPresence: vi.fn(),
          dispose: vi.fn(),
          createInvitation: vi.fn().mockResolvedValue({
            invitation: {
              invitationId: "invitation-lan",
              projectId: authorityProjectId,
              role: "member",
              createdByHumanPrincipalId: "human-owner-001",
              createdAt: "2030-01-01T00:00:00.000Z",
              expiresAt: "2030-01-02T00:00:00.000Z"
            },
            invitationToken: exampleInvitationToken
          })
        }) as never
    });
    const activation = createLocalCollaborationActivationCommand({ coordinator: control, service });

    await control.setCurrentSelection({ projectId: project.projectId, canvasId: "canvas-1" });
    await control.setExposureMode({ mode: "lan_http" });
    await activation.reconcile();

    const lanProfile = control.localProfile();
    expect(lanProfile).toMatchObject({
      serverBaseUrl: "http://192.168.1.20:18787/",
      allowInsecureTransport: true,
      endpoint: {
        topology: "lan_http",
        serverOrigin: "http://192.168.1.20:18787/"
      }
    });
    const status = await service.getStatus();
    expect(status.activeProfileId).toBe(lanProfile?.profileId);
    expect(status.profiles[0]).toMatchObject({
      serverBaseUrl: lanProfile?.endpoint.serverOrigin,
      endpoint: { serverOrigin: lanProfile?.serverBaseUrl },
      connectionState: "ready"
    });
    expect(
      (
        await new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") }).get(
          lanProfile!.profileId
        )
      )?.serverBaseUrl
    ).toBe(lanProfile?.endpoint.serverOrigin);

    const handoff = await new CollaborationInvitationHandoffCoordinator(service, control).create(
      {}
    );
    expect(parseCollaborationInvitationHandoffV2(handoff.handoff)?.endpoint.serverOrigin).toBe(
      lanProfile?.serverBaseUrl
    );

    await switchLocalCollaborationExposure(control, activation, { mode: "local_only" });
    const loopbackProfile = control.localProfile();
    expect(loopbackProfile?.serverBaseUrl).toBe(loopbackProfile?.endpoint.serverOrigin);
    expect(loopbackProfile?.endpoint.topology).toBe("loopback_http");
    expect((await service.getStatus()).profiles[0]).toMatchObject({
      serverBaseUrl: loopbackProfile?.serverBaseUrl,
      endpoint: { serverOrigin: loopbackProfile?.serverBaseUrl }
    });
  });
});
