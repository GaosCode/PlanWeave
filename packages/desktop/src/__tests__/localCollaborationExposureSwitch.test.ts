import { describe, expect, it, vi } from "vitest";
import { switchLocalCollaborationExposure } from "../main/collaboration/localCollaborationExposureSwitch.js";
import { createLocalCollaborationActivationCommand } from "../main/collaboration/localCollaborationSelectionActivation.js";

const view = (mode: "local_only" | "private_https") => ({
  mode,
  topology: mode === "local_only" ? ("loopback_http" as const) : ("private_https" as const),
  provider: mode === "private_https" ? { id: "tailscale", displayName: "Tailscale" } : null,
  lifecycle: "ready" as const,
  advertisedOrigin: mode === "local_only" ? null : "https://planweave.example.ts.net/",
  errorCode: null,
  canActivate: true,
  canInvite: true
});

describe("switchLocalCollaborationExposure", () => {
  it("reconciles the active local profile after the endpoint changes", async () => {
    let mode: "local_only" | "private_https" = "local_only";
    const reconcile = vi.fn().mockResolvedValue(null);
    const local = {
      getExposureView: () => view(mode),
      localProfile: () => ({ profileId: "local-project-1" }),
      setExposureMode: vi.fn(async (input: { mode: typeof mode }) => {
        mode = input.mode;
        return view(mode);
      })
    };
    await expect(
      switchLocalCollaborationExposure(local, { reconcile }, { mode: "private_https" })
    ).resolves.toMatchObject({ mode: "private_https" });
    expect(reconcile).toHaveBeenCalledWith("local-project-1");
  });

  it("records this computer as the last Server before reconciling", async () => {
    let mode: "local_only" | "private_https" = "local_only";
    const rememberThisComputerAsLastServer = vi.fn(async () => undefined);
    const reconcile = vi.fn().mockResolvedValue(null);
    const local = {
      getExposureView: () => view(mode),
      localProfile: () => ({ profileId: "local-project-1" }),
      setExposureMode: vi.fn(async (input: { mode: typeof mode }) => {
        mode = input.mode;
        return view(mode);
      })
    };
    await switchLocalCollaborationExposure(
      local,
      { reconcile, rememberThisComputerAsLastServer },
      { mode: "private_https" }
    );
    expect(rememberThisComputerAsLastServer.mock.invocationCallOrder[0]).toBeLessThan(
      reconcile.mock.invocationCallOrder[0]
    );
  });

  it("runs the activation chain against the newly advertised local origin", async () => {
    let mode: "local_only" | "private_https" = "local_only";
    const coordinator = {
      getExposureView: () => view(mode),
      setExposureMode: vi.fn(async (input: { mode: typeof mode }) => {
        mode = input.mode;
        return view(mode);
      }),
      currentSelection: vi.fn(() => ({ projectId: "desktop-project-1", canvasId: "canvas-1" })),
      status: vi.fn(() => ({ state: "running" })),
      start: vi.fn(async () => ({ state: "running" })),
      currentSelectionIsTrusted: vi.fn(() => true),
      recognizesLocalProfile: vi.fn(() => true),
      ownsLocalProfile: vi.fn(() => true),
      setCurrentSelection: vi.fn(async () => undefined),
      clearCurrentSelection: vi.fn(async () => undefined),
      localProfile: vi.fn(() => ({
        profileId: "local-project-1",
        displayName: "Local Server",
        serverBaseUrl:
          mode === "local_only" ? "http://127.0.0.1:8787/" : "https://planweave.example.ts.net/",
        projectId: "project-1",
        allowInsecureTransport: mode === "local_only",
        endpoint:
          mode === "local_only"
            ? {
                topology: "loopback_http" as const,
                serverOrigin: "http://127.0.0.1:8787/",
                tlsTrust: "not_applicable" as const
              }
            : {
                topology: "private_https" as const,
                serverOrigin: "https://planweave.example.ts.net/",
                tlsTrust: "system_ca" as const
              }
      })),
      localProfileForId: vi.fn(() => ({
        profileId: "local-project-1",
        displayName: "Local Server",
        serverBaseUrl:
          mode === "local_only" ? "http://127.0.0.1:8787/" : "https://planweave.example.ts.net/",
        projectId: "project-1",
        allowInsecureTransport: mode === "local_only",
        endpoint:
          mode === "local_only"
            ? {
                topology: "loopback_http" as const,
                serverOrigin: "http://127.0.0.1:8787/",
                tlsTrust: "not_applicable" as const
              }
            : {
                topology: "private_https" as const,
                serverOrigin: "https://planweave.example.ts.net/",
                tlsTrust: "system_ca" as const
              }
      })),
      registerLocalProfile: vi.fn(() => ({
        workspaceId: "workspace-1",
        projectId: "project-1",
        canvasId: "canvas-1",
        profileId: "local-project-1",
        registeredAt: "2030-01-01T00:00:00.000Z"
      })),
      registerCurrentProject: vi.fn(() => ({
        workspaceId: "workspace-1",
        projectId: "project-1",
        canvasId: "canvas-1",
        profileId: "local-project-1",
        registeredAt: "2030-01-01T00:00:00.000Z"
      }))
    };
    const service = {
      getStatus: vi.fn(async () => ({
        activeProfileId: "local-project-1",
        session: { phase: "connected" }
      })),
      runStatusPublicationTransaction: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
      upsertProfile: vi.fn(async () => undefined),
      migrateLocalProfileCredential: vi.fn(async () => undefined),
      adoptWorkspaceAuthority: vi.fn(async () => undefined),
      setActiveProfile: vi.fn(async () => undefined),
      activeHumanPrincipalId: vi.fn(async () => "human-owner"),
      migrateLegacyLocalOwnerDisplayName: vi.fn(async () => false),
      bootstrapOwner: vi.fn(),
      connectSession: vi.fn(async () => undefined),
      clearActiveProfile: vi.fn(async () => undefined)
    };
    const activation = createLocalCollaborationActivationCommand({ coordinator, service });

    await switchLocalCollaborationExposure(coordinator, activation, {
      mode: "private_https"
    });

    expect(service.upsertProfile).toHaveBeenCalledWith(
      expect.objectContaining({ serverBaseUrl: "https://planweave.example.ts.net/" })
    );
    expect(service.connectSession).toHaveBeenCalledWith({ profileId: "local-project-1" });
    expect(service.migrateLegacyLocalOwnerDisplayName).toHaveBeenCalledWith({
      humanPrincipalId: "human-owner"
    });
  });

  it("restores the previous mode when activation fails", async () => {
    let mode: "local_only" | "private_https" = "local_only";
    const reconcile = vi
      .fn()
      .mockRejectedValueOnce(new Error("activation_failed"))
      .mockResolvedValueOnce(null);
    const local = {
      getExposureView: () => view(mode),
      localProfile: () => ({ profileId: "local-project-1" }),
      setExposureMode: vi.fn(async (input: { mode: typeof mode }) => {
        mode = input.mode;
        return view(mode);
      })
    };
    await expect(
      switchLocalCollaborationExposure(local, { reconcile }, { mode: "private_https" })
    ).rejects.toThrow("activation_failed");
    expect(mode).toBe("local_only");
    expect(local.setExposureMode).toHaveBeenCalledTimes(2);
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it("restores the previous endpoint when the new local server fails to start", async () => {
    let mode: "local_only" | "private_https" = "local_only";
    const reconcile = vi.fn().mockResolvedValue(null);
    const local = {
      getExposureView: () => view(mode),
      localProfile: () => ({ profileId: "local-project-1" }),
      setExposureMode: vi.fn(async (input: { mode: typeof mode }) => {
        mode = input.mode;
        if (mode === "private_https") {
          return {
            ...view(mode),
            lifecycle: "error" as const,
            errorCode: "TAILSCALE_HTTPS_UNAVAILABLE" as const,
            canInvite: false
          };
        }
        return view(mode);
      })
    };
    await expect(
      switchLocalCollaborationExposure(local, { reconcile }, { mode: "private_https" })
    ).resolves.toMatchObject({
      mode: "private_https",
      lifecycle: "error",
      errorCode: "TAILSCALE_HTTPS_UNAVAILABLE"
    });
    expect(mode).toBe("local_only");
    expect(reconcile).toHaveBeenCalledWith("local-project-1");
  });

  it("fails closed when restoring the previous mode returns an error view", async () => {
    let mode: "local_only" | "private_https" = "local_only";
    const reconcile = vi.fn().mockResolvedValue(null);
    const local = {
      getExposureView: () => view(mode),
      localProfile: () => ({ profileId: "local-project-1" }),
      setExposureMode: vi.fn(async (input: { mode: typeof mode }) => {
        mode = input.mode;
        if (mode === "private_https") {
          return {
            ...view(mode),
            lifecycle: "error" as const,
            errorCode: "TAILSCALE_HTTPS_UNAVAILABLE" as const,
            canInvite: false
          };
        }
        return {
          ...view(mode),
          lifecycle: "error" as const,
          errorCode: "LOOPBACK_START_FAILED" as const,
          canInvite: false
        };
      })
    };

    await expect(
      switchLocalCollaborationExposure(local, { reconcile }, { mode: "private_https" })
    ).rejects.toThrow("local_collaboration_exposure_rollback_failed");
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("does not reconcile when the restored authority differs from the previous endpoint", async () => {
    let mode: "local_only" | "private_https" = "local_only";
    let changes = 0;
    const reconcile = vi.fn().mockRejectedValueOnce(new Error("activation_failed"));
    const local = {
      getExposureView: () => view(mode),
      localProfile: () => ({ profileId: "local-project-1" }),
      setExposureMode: vi.fn(async (input: { mode: typeof mode }) => {
        mode = input.mode;
        changes += 1;
        if (changes === 2) {
          return {
            ...view(mode),
            advertisedOrigin: "http://127.0.0.1:9999/"
          };
        }
        return view(mode);
      })
    };

    await expect(
      switchLocalCollaborationExposure(local, { reconcile }, { mode: "private_https" })
    ).rejects.toThrow("local_collaboration_exposure_rollback_failed");
    expect(reconcile).toHaveBeenCalledTimes(1);
  });
});
