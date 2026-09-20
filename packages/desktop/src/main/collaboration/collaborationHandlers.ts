import { handleDesktopCommand } from "../desktopCommandHandler.js";
import { app, BrowserWindow, clipboard, dialog, safeStorage } from "electron";
import { registerCollaborationCaptureHandlers } from "./collaborationCapture.js";
import { resolveSelfHostServerResourceDirectory } from "./selfHostServerResource.js";
import WebSocket from "ws";
import { z } from "zod";
import {
  humanCreateInvitationResponseSchema,
  humanDevicePageSchema,
  humanInvitationPageSchema,
  humanInvitationViewSchema,
  humanMemberPageSchema,
  humanPrincipalViewSchema,
  humanRevokeInvitationsResponseSchema
} from "@planweave-ai/collaboration-protocol/identity/workspace";
import { collaborationInvitationHandoffResponseSchema } from "@planweave-ai/collaboration-protocol/handoff/invitation";
import { canvasRuntimeAvailabilitySchema } from "@planweave-ai/collaboration-protocol/canvas/runtime-availability";
import {
  workspaceConnectionMembersPageSchema,
  workspaceConnectionSelfViewSchema
} from "@planweave-ai/collaboration-protocol/connection";
import {
  canvasRuntimeInitializeOutcomeSchema,
  canvasRuntimeResetOutcomeSchema
} from "@planweave-ai/collaboration-protocol/canvas/runtime-control";
import {
  collaborationCanvasBindingInputSchema,
  collaborationInvokeChannels,
  collaborationObserverSignalChannel,
  collaborationPresenceSignalChannel,
  collaborationCanvasBindingReplicaSignalChannel,
  collaborationOperationDiagnosticsChangedChannel,
  workspaceCanvasProjectionSignalChannel,
  collaborationStatusChangedChannel,
  type CollaborationObserverSignal,
  type CollaborationOperationDiagnostics,
  type CollaborationStatus
} from "../../shared/collaboration.js";
import {
  collaborationOperationDiagnosticsSchema,
  type CollaborationStartupDiagnostic
} from "../../shared/collaborationOperationDiagnostics.js";
import {
  workspaceCanvasDownloadInputSchema,
  workspaceCanvasDownloadResultSchema,
  workspaceCanvasPublishInputSchema,
  workspaceCanvasPublishResultSchema,
  workspaceCanvasSharingCandidateSchema
} from "../../shared/workspaceCanvasSharing.js";
import { localCollaborationRegistrationInputSchema } from "../../shared/localCollaborationScopes.js";
import {
  CollaborationClient,
  type CollaborationWebSocketConstructor
} from "./CollaborationClient.js";
import { CollaborationService, type CollaborationServiceOptions } from "./collaborationService.js";
import type { CollaborationCanvasBindingReplicaSignal } from "../../shared/canvasReplicaIpc.js";
import type { WorkspaceCanvasProjection } from "../../shared/workspaceCanvasProjection.js";
import {
  workspaceCanvasRuntimeInitializeInputSchema,
  workspaceCanvasRuntimeResetInputSchema
} from "../../shared/collaborationRuntimeAvailability.js";
import { LocalCollaborationCoordinatorControl } from "./CollaborationCoordinatorControl.js";
import { DeploymentActions } from "./deploymentActions.js";
import { runCollaborationCommand } from "./collaborationCommandHandler.js";
import { createLocalCollaborationActivationCommand } from "./localCollaborationSelectionActivation.js";
import { CollaborationInvitationHandoffCoordinator } from "./CollaborationInvitationHandoffCoordinator.js";
import { getOperatorControlService } from "../operatorControl/operatorControlHandlers.js";
import { setLocalOperatorBackendPort } from "../operatorControl/localOperatorBackend.js";
import {
  collaborationDiagnosticErrorCode,
  createCollaborationCoordinationQueue,
  runCollaborationDiagnosticsNotification,
  type CollaborationCoordinationQueue
} from "./collaborationCoordinationQueue.js";
import {
  createCollaborationHandlerLifecycle,
  type CollaborationHandlerLifecycle
} from "./collaborationHandlerLifecycle.js";
import { switchLocalCollaborationExposure } from "./localCollaborationExposureSwitch.js";
import { assertRendererProfileNamespace } from "./collaborationProfileEndpoint.js";
import { restorePersistedCollaborationSession } from "./persistedCollaborationSessionRecovery.js";
import { restorePersistedDesktopServerConnection } from "./persistedDesktopServerConnection.js";
import { desktopHomePaths } from "../planweaveHomePaths.js";
import { ServerDataMigration } from "./serverDataMigration.js";

let service: CollaborationService | null = null;
let coordinator: LocalCollaborationCoordinatorControl | null = null;
let handlerLifecycle: CollaborationHandlerLifecycle | null = null;

export type CollaborationHandlerOptions = CollaborationServiceOptions & {
  coordinatorCredentialsPath?: string;
};

function publishStatusToRenderers(status: CollaborationStatus): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(collaborationStatusChangedChannel, status);
    }
  }
}

function publishOperationDiagnosticsToRenderers(
  diagnostics: CollaborationOperationDiagnostics
): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(collaborationOperationDiagnosticsChangedChannel, diagnostics);
    }
  }
}

function publishObserverSignalToRenderers(signal: CollaborationObserverSignal): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(collaborationObserverSignalChannel, signal);
    }
  }
}

function publishPresenceSignalToRenderers(
  signal: Parameters<NonNullable<CollaborationServiceOptions["onPresenceSignal"]>>[0]
): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(collaborationPresenceSignalChannel, signal);
    }
  }
}

function publishCanvasReplicaSignalToRenderers(
  signal: CollaborationCanvasBindingReplicaSignal
): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(collaborationCanvasBindingReplicaSignalChannel, signal);
    }
  }
}

function publishWorkspaceCanvasProjectionToRenderers(projection: WorkspaceCanvasProjection): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(workspaceCanvasProjectionSignalChannel, {
        type: "workspace.canvas.projection",
        projection
      });
    }
  }
}

function createDefaultService(options: CollaborationServiceOptions = {}): CollaborationService {
  const userCreateClient = options.createClient;
  return new CollaborationService({
    ...options,
    safeStorage: options.safeStorage ?? {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (value) => safeStorage.encryptString(value),
      decryptString: (value) => safeStorage.decryptString(value)
    },
    createClient:
      userCreateClient ??
      ((clientOptions) =>
        new CollaborationClient({
          ...clientOptions,
          WebSocketImpl:
            clientOptions.WebSocketImpl ??
            (WebSocket as unknown as CollaborationWebSocketConstructor)
        })),
    onStatusChange: options.onStatusChange ?? publishStatusToRenderers,
    onObserverSignal: options.onObserverSignal ?? publishObserverSignalToRenderers,
    onPresenceSignal: options.onPresenceSignal ?? publishPresenceSignalToRenderers,
    onCanvasReplicaSignal: options.onCanvasReplicaSignal ?? publishCanvasReplicaSignalToRenderers,
    onWorkspaceCanvasProjection:
      options.onWorkspaceCanvasProjection ?? publishWorkspaceCanvasProjectionToRenderers,
    bindLiveOperatorToOrigin: options.bindLiveOperatorToOrigin
  });
}

export function getCollaborationService(): CollaborationService {
  if (!service) {
    service = createDefaultService();
  }
  return service;
}

/** Test/helper override. */
export function setCollaborationServiceForTests(next: CollaborationService | null): void {
  service = next;
}

export function createCollaborationService(
  options: CollaborationServiceOptions = {}
): CollaborationService {
  return createDefaultService(options);
}

export function registerCollaborationHandlers(
  options: CollaborationHandlerOptions = {}
): CollaborationService {
  registerCollaborationCaptureHandlers();
  const { coordinatorCredentialsPath, ...serviceOptions } = options;
  const lifecycle = createCollaborationHandlerLifecycle();
  handlerLifecycle = lifecycle;
  service = createDefaultService(serviceOptions);
  const active = service;
  const credentialStorage = serviceOptions.safeStorage ?? {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (value: string) => safeStorage.encryptString(value),
    decryptString: (value: Buffer) => safeStorage.decryptString(value)
  };
  coordinator = new LocalCollaborationCoordinatorControl({
    safeStorage: credentialStorage,
    ...(coordinatorCredentialsPath ? { credentialsPath: coordinatorCredentialsPath } : {}),
    syncOperatorProfile: (input) => getOperatorControlService().ensureMainOwnedServerProfile(input)
  });
  const local = coordinator;
  const localReady = lifecycle.run(async () => {
    const remoteProfileId = await active.peekPersistedRemoteProfileId();
    if (remoteProfileId) return local.hydratePersistedExposure();
    return local.restore();
  });
  void localReady.catch((error: unknown) => {
    console.error("Failed to restore the local collaboration service.", error);
  });
  const localActivation = createLocalCollaborationActivationCommand({
    coordinator: local,
    service: active,
    coordinatorReady: localReady
  });
  const startupStartedAt = new Date().toISOString();
  let startupDiagnostics: CollaborationStartupDiagnostic = {
    phase: "restoring",
    startedAt: startupStartedAt,
    settledAt: null,
    errorCode: null
  };
  let coordinationQueue: CollaborationCoordinationQueue;
  const readOperationDiagnostics = (): CollaborationOperationDiagnostics =>
    collaborationOperationDiagnosticsSchema.parse({
      schemaVersion: "planweave.collaboration.operations/v1",
      capturedAt: new Date().toISOString(),
      startup: startupDiagnostics,
      coordinationQueue: coordinationQueue.getDiagnostics()
    });
  const publishOperationDiagnostics = (): void =>
    runCollaborationDiagnosticsNotification(() =>
      publishOperationDiagnosticsToRenderers(readOperationDiagnostics())
    );
  coordinationQueue = createCollaborationCoordinationQueue({
    onChange: publishOperationDiagnostics
  });
  const runCoordinationOperation = <T>(name: string, operation: () => Promise<T>): Promise<T> =>
    lifecycle.run(() => coordinationQueue.run(name, operation));
  const persistedWorkspaceReady = runCoordinationOperation(
    "startup.restorePersistedWorkspace",
    async () => {
      await restorePersistedDesktopServerConnection({
        peekPersistedRemoteProfileId: () => active.peekPersistedRemoteProfileId(),
        restoreLocal: async () => {
          await localReady;
          await localActivation.reconcile();
          await restorePersistedCollaborationSession(active);
        },
        restoreRemote: async (profileId) => {
          await localReady;
          await active.restorePersistedRemoteServerConnection(profileId);
        }
      });
    }
  ).then(
    () => {
      startupDiagnostics = {
        ...startupDiagnostics,
        phase: "ready",
        settledAt: new Date().toISOString()
      };
      publishOperationDiagnostics();
    },
    (error: unknown) => {
      startupDiagnostics = {
        ...startupDiagnostics,
        phase: "failed",
        settledAt: new Date().toISOString(),
        errorCode: collaborationDiagnosticErrorCode(error)
      };
      publishOperationDiagnostics();
      console.error("Failed to restore the persisted collaboration Workspace.", error);
    }
  );
  const suspendLocalSession = async (
    profileId = local.localProfile()?.profileId
  ): Promise<void> => {
    if (profileId && (await active.getStatus()).activeProfileId === profileId) {
      await active.disconnectSession();
    }
  };
  const deploymentActions = new DeploymentActions({
    writeClipboard: (value) => clipboard.writeText(value),
    resourceDirectory: resolveSelfHostServerResourceDirectory({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath
    }),
    resolveBundleSource: (target) => local.createSelfHostedDeploymentSource(target),
    showSaveDialog: (options) => dialog.showSaveDialog(options)
  });
  const invitationHandoff = new CollaborationInvitationHandoffCoordinator(active, local);
  const serverDataMigration = new ServerDataMigration({
    dataDirectory: () => desktopHomePaths().localCollaborationServerDir,
    localServerState: () => local.status().state,
    showSaveDialog: (options) => dialog.showSaveDialog(options),
    showOpenDialog: (options) => dialog.showOpenDialog(options),
    snapshotIdentity: () => active.snapshotExportedServerDataIdentity()
  });

  handleDesktopCommand(collaborationInvokeChannels.getCollaborationStatus, () =>
    lifecycle.run(async () => {
      await persistedWorkspaceReady;
      return active.getStatus();
    })
  );
  handleDesktopCommand(collaborationInvokeChannels.getCollaborationOperationDiagnostics, () =>
    lifecycle.run(async () => readOperationDiagnostics())
  );
  handleDesktopCommand(
    collaborationInvokeChannels.upsertCollaborationProfile,
    (_event, input: unknown) =>
      runCoordinationOperation("profile.upsert", () => {
        assertRendererProfileNamespace(input);
        return active.upsertProfile(input);
      })
  );
  handleDesktopCommand(
    collaborationInvokeChannels.removeCollaborationProfile,
    (_event, input: unknown) =>
      runCoordinationOperation("profile.remove", () => active.removeProfile(input))
  );
  handleDesktopCommand(
    collaborationInvokeChannels.setActiveCollaborationProfile,
    (_event, input: unknown) =>
      runCoordinationOperation("profile.setActive", () => active.setActiveProfile(input))
  );
  handleDesktopCommand(
    collaborationInvokeChannels.exportDeploymentComposeBundle,
    (_event, input: unknown) => deploymentActions.exportComposeBundle(input)
  );
  handleDesktopCommand(collaborationInvokeChannels.listServerDataExportSources, () =>
    lifecycle.run(async () => {
      await localReady;
      return serverDataMigration.listSources();
    })
  );
  handleDesktopCommand(
    collaborationInvokeChannels.exportServerDataArchive,
    (_event, input: unknown) =>
      runCoordinationOperation("serverData.export", async () => {
        await localReady;
        return serverDataMigration.exportArchive(input);
      })
  );
  handleDesktopCommand(
    collaborationInvokeChannels.restoreServerDataArchive,
    (_event, input: unknown) =>
      runCoordinationOperation("serverData.restore", async () => {
        await localReady;
        return serverDataMigration.restoreArchive(input);
      })
  );
  handleDesktopCommand(collaborationInvokeChannels.clearActiveCollaborationProfile, () =>
    runCoordinationOperation("profile.clearActive", () => active.clearActiveProfile())
  );
  handleDesktopCommand(
    collaborationInvokeChannels.importDeviceCredential,
    (_event, input: unknown) => active.importDeviceCredential(input)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.clearDeviceCredential,
    (_event, input: unknown) => active.clearDeviceCredential(input)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.bootstrapCollaborationOwner,
    (_event, input: unknown) =>
      runCoordinationOperation("owner.bootstrap", async () => {
        const handoff = await active.bootstrapOwner(input);
        const profileId =
          input && typeof input === "object" && "profileId" in input
            ? (input as { profileId: unknown }).profileId
            : null;
        if (typeof profileId === "string" && local.localProfile()?.profileId === profileId) {
          local.registerCurrentProject({ kind: "human", id: handoff.principal.humanPrincipalId });
          await active.connectSession({ profileId });
        }
        return handoff;
      })
  );
  handleDesktopCommand(
    collaborationInvokeChannels.consumeCollaborationInvitation,
    (_event, input: unknown) =>
      runCoordinationOperation("invitation.consume", () => active.consumeInvitation(input))
  );
  handleDesktopCommand(
    collaborationInvokeChannels.connectCollaborationSession,
    (_event, input: unknown) =>
      runCoordinationOperation("session.connect", () => active.connectSession(input))
  );
  handleDesktopCommand(collaborationInvokeChannels.disconnectCollaborationSession, () =>
    runCoordinationOperation("session.disconnect", () => active.disconnectSession())
  );
  handleDesktopCommand(
    collaborationInvokeChannels.redeemCollaborationSetupCode,
    (_event, input: unknown) =>
      runCoordinationOperation("workspace.redeemSetupCode", () => active.redeemSetupCode(input))
  );
  handleDesktopCommand(
    collaborationInvokeChannels.recoverCollaborationIdentities,
    (_event, input: unknown) =>
      runCoordinationOperation("workspace.recoverIdentities", () =>
        active.recoverHistoricalIdentities(input)
      )
  );
  handleDesktopCommand(
    collaborationInvokeChannels.confirmCollaborationIdentityMerge,
    (_event, input: unknown) =>
      runCoordinationOperation("workspace.confirmIdentityMerge", () =>
        active.confirmIdentityMerge(input)
      )
  );
  handleDesktopCommand(
    collaborationInvokeChannels.connectExistingServerByOrigin,
    (_event, input: unknown) =>
      runCoordinationOperation("workspace.connectByOrigin", () =>
        active.connectExistingServerByOrigin(input)
      )
  );
  handleDesktopCommand(collaborationInvokeChannels.getActiveWorkspaceConnection, () =>
    lifecycle.run(async () => {
      await persistedWorkspaceReady;
      return active.getActiveWorkspaceConnection();
    })
  );
  handleDesktopCommand(collaborationInvokeChannels.listRememberedServerConnections, () =>
    lifecycle.run(async () => {
      await persistedWorkspaceReady;
      return active.listRememberedServerConnections();
    })
  );
  handleDesktopCommand(
    collaborationInvokeChannels.forgetRememberedServerConnection,
    (_event, input: unknown) =>
      runCoordinationOperation("workspace.forgetConnection", () =>
        active.forgetRememberedServerConnection(input)
      )
  );
  handleDesktopCommand(collaborationInvokeChannels.listWorkspacePicker, (_event, input: unknown) =>
    active.listWorkspacePicker(input)
  );
  handleDesktopCommand(collaborationInvokeChannels.getWorkspaceConnectionSelf, () =>
    runCollaborationCommand(
      () => active.getWorkspaceConnectionSelf(),
      workspaceConnectionSelfViewSchema
    )
  );
  handleDesktopCommand(
    collaborationInvokeChannels.updateWorkspaceConnectionSelf,
    (_event, input: unknown) =>
      runCollaborationCommand(
        () => active.updateWorkspaceConnectionSelf(input),
        workspaceConnectionSelfViewSchema
      )
  );
  handleDesktopCommand(
    collaborationInvokeChannels.listWorkspaceConnectionMembers,
    (_event, input: unknown) =>
      runCollaborationCommand(
        () => active.listWorkspaceConnectionMembers(input),
        workspaceConnectionMembersPageSchema
      )
  );
  handleDesktopCommand(
    collaborationInvokeChannels.selectWorkspaceConnection,
    (_event, input: unknown) =>
      runCoordinationOperation("workspace.selectConnection", () =>
        active.selectWorkspaceConnection(input)
      )
  );
  handleDesktopCommand(collaborationInvokeChannels.connectWorkspaceConnection, () =>
    runCoordinationOperation("workspace.connect", () => active.connectWorkspaceConnection())
  );
  handleDesktopCommand(collaborationInvokeChannels.disconnectWorkspaceConnection, () =>
    runCoordinationOperation("workspace.disconnect", () => active.disconnectWorkspaceConnection())
  );
  handleDesktopCommand(collaborationInvokeChannels.retryWorkspaceConnection, () =>
    runCoordinationOperation("workspace.retryConnection", () => active.retryWorkspaceConnection())
  );
  handleDesktopCommand(
    collaborationInvokeChannels.getDeploymentGuidance,
    (_event, input: unknown) => deploymentActions.guidance(input)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.copyDeploymentComposeHandoff,
    (_event, input: unknown) => deploymentActions.copyComposeHandoff(input)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.validateDeploymentConnectivity,
    (_event, input: unknown) => deploymentActions.validateConnectivity(input)
  );
  handleDesktopCommand(collaborationInvokeChannels.getDesktopServerExposure, () =>
    lifecycle.run(async () => {
      await localReady;
      await local.reconcileManagementProfile();
      return local.getExposureView();
    })
  );
  handleDesktopCommand(
    collaborationInvokeChannels.setDesktopServerExposureMode,
    (_event, input: unknown) =>
      runCoordinationOperation("localServer.setExposureMode", () =>
        switchLocalCollaborationExposure(
          local,
          {
            reconcile: () => localActivation.reconcile(),
            rememberThisComputerAsLastServer: () => active.markLastServerConnectionLocal()
          },
          input
        )
      )
  );
  handleDesktopCommand(
    collaborationInvokeChannels.startCollaborationPresence,
    (_event, input: unknown) => active.startPresence(input)
  );
  handleDesktopCommand(collaborationInvokeChannels.stopCollaborationPresence, () =>
    active.stopPresence()
  );
  handleDesktopCommand(
    collaborationInvokeChannels.publishCollaborationPresence,
    (_event, input: unknown) => active.publishPresence(input)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.openWorkspaceCanvasSession,
    (_event, input: unknown) => active.openWorkspaceCanvasSession(input)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.submitWorkspaceCanvasCommand,
    (_event, input: unknown) => active.submitWorkspaceCanvasCommand(input)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.reconnectWorkspaceCanvasSession,
    (_event, input: unknown) => active.reconnectWorkspaceCanvasSession(input)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.closeWorkspaceCanvasSession,
    (_event, input: unknown) => active.closeWorkspaceCanvasSession(input)
  );
  handleDesktopCommand(collaborationInvokeChannels.getWorkspaceCanvasProjection, () =>
    active.getWorkspaceCanvasProjection()
  );
  handleDesktopCommand(
    collaborationInvokeChannels.readCollaborationCanvasBindingRuntimeAvailability,
    async (_event, input: unknown) =>
      canvasRuntimeAvailabilitySchema
        .nullable()
        .parse(
          await active.readCanvasRuntimeAvailability(
            collaborationCanvasBindingInputSchema.parse(input)
          )
        )
  );
  handleDesktopCommand(
    collaborationInvokeChannels.initializeWorkspaceCanvasRuntime,
    async (_event, input: unknown) =>
      canvasRuntimeInitializeOutcomeSchema.parse(
        await active.initializeWorkspaceCanvasRuntime(
          workspaceCanvasRuntimeInitializeInputSchema.parse(input)
        )
      )
  );
  handleDesktopCommand(
    collaborationInvokeChannels.resetWorkspaceCanvasRuntime,
    async (_event, input: unknown) =>
      canvasRuntimeResetOutcomeSchema.parse(
        await active.resetWorkspaceCanvasRuntime(
          workspaceCanvasRuntimeResetInputSchema.parse(input)
        )
      )
  );
  handleDesktopCommand(collaborationInvokeChannels.listWorkspaceCanvasSharingCandidates, () =>
    runCollaborationCommand(
      () => active.listWorkspaceCanvasSharingCandidates(),
      z.array(workspaceCanvasSharingCandidateSchema)
    )
  );
  handleDesktopCommand(
    collaborationInvokeChannels.publishWorkspaceCanvas,
    (_event, input: unknown) =>
      runCollaborationCommand(
        () => active.publishWorkspaceCanvas(workspaceCanvasPublishInputSchema.parse(input)),
        workspaceCanvasPublishResultSchema
      )
  );
  handleDesktopCommand(
    collaborationInvokeChannels.downloadWorkspaceCanvasFork,
    (_event, input: unknown) =>
      runCollaborationCommand(
        () => active.downloadWorkspaceCanvasFork(workspaceCanvasDownloadInputSchema.parse(input)),
        workspaceCanvasDownloadResultSchema
      )
  );
  handleDesktopCommand(
    collaborationInvokeChannels.getCurrentCanvasAccess,
    (_event, input: unknown) => active.getCurrentCanvasAccess(input)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.mutateCurrentCanvasAccess,
    (_event, input: unknown) => active.mutateCurrentCanvasAccess(input)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.setCollaborationCurrentSelection,
    (_event, input: unknown) =>
      runCoordinationOperation("selection.setCurrent", async () => {
        const registrationInput = localCollaborationRegistrationInputSchema.parse({
          selection: input
        });
        if (!registrationInput.selection) {
          throw new Error("local_collaboration_selection_required");
        }
        await localActivation.selectAndReconcile(registrationInput.selection);
      })
  );
  handleDesktopCommand(collaborationInvokeChannels.clearCollaborationCurrentSelection, () =>
    runCoordinationOperation("selection.clearCurrent", async () => {
      await local.clearCurrentSelection();
    })
  );
  handleDesktopCommand(collaborationInvokeChannels.getLocalCollaborationServerStatus, () =>
    lifecycle.run(async () => {
      await localReady;
      return local.status();
    })
  );
  handleDesktopCommand(collaborationInvokeChannels.getLocalCollaborationScopeCatalog, () =>
    local.getScopeCatalog()
  );
  handleDesktopCommand(
    collaborationInvokeChannels.setLocalCollaborationTrustedScopes,
    (_event, input: unknown) =>
      runCoordinationOperation("localServer.setTrustedScopes", async () => {
        const catalog = await local.setTrustedScopes(input);
        await localActivation.reconcile();
        return catalog;
      })
  );
  handleDesktopCommand(collaborationInvokeChannels.startLocalCollaborationServer, () =>
    runCoordinationOperation("localServer.start", async () => {
      const status = await local.start();
      if (status.state !== "running") return status;
      await active.markLastServerConnectionLocal();
      await localActivation.reconcile();
      return status;
    })
  );
  handleDesktopCommand(collaborationInvokeChannels.stopLocalCollaborationServer, () =>
    runCoordinationOperation("localServer.stop", async () => {
      const previousProfileId = local.localProfile()?.profileId;
      const status = await local.stop();
      await suspendLocalSession(previousProfileId);
      return status;
    })
  );
  handleDesktopCommand(
    collaborationInvokeChannels.setLocalCollaborationLanSharing,
    (_event, input: unknown) =>
      runCoordinationOperation("localServer.setLanSharing", async () => {
        const status = await local.setLanSharing(input);
        await localActivation.reconcile();
        return status;
      })
  );
  handleDesktopCommand(collaborationInvokeChannels.listLocalCollaborationTrustedScopes, () =>
    local.listActiveTrustedScopes()
  );
  handleDesktopCommand(
    collaborationInvokeChannels.registerLocalCollaborationCurrentProject,
    (_event, input: unknown) =>
      runCoordinationOperation("localServer.registerCurrentProject", async () => {
        const registrationInput = localCollaborationRegistrationInputSchema.parse(input ?? {});
        return localActivation.activate(registrationInput);
      })
  );
  handleDesktopCommand(
    collaborationInvokeChannels.listCollaborationMembers,
    (_event, input: unknown) =>
      runCollaborationCommand(() => active.listMembers(input), humanMemberPageSchema)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.updateOwnCollaborationDisplayName,
    (_event, input: unknown) =>
      runCollaborationCommand(() => active.updateOwnDisplayName(input), humanPrincipalViewSchema)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.listCollaborationDevices,
    (_event, input: unknown) =>
      runCollaborationCommand(() => active.listDevices(input), humanDevicePageSchema)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.listCollaborationInvitations,
    (_event, input: unknown) =>
      runCollaborationCommand(() => active.listInvitations(input), humanInvitationPageSchema)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.createCollaborationInvitation,
    (_event, input: unknown) =>
      runCollaborationCommand(
        () => active.createInvitation(input),
        humanCreateInvitationResponseSchema
      )
  );
  handleDesktopCommand(
    collaborationInvokeChannels.createCollaborationInvitationHandoff,
    (_event, input: unknown) =>
      runCollaborationCommand(
        () =>
          runCoordinationOperation("invitation.createHandoff", () =>
            invitationHandoff.create(input)
          ),
        collaborationInvitationHandoffResponseSchema
      )
  );
  handleDesktopCommand(
    collaborationInvokeChannels.getCollaborationInvitationSecret,
    (_event, input: unknown) =>
      runCollaborationCommand(
        () => active.getInvitationSecret(input),
        humanCreateInvitationResponseSchema
      )
  );
  handleDesktopCommand(
    collaborationInvokeChannels.getCollaborationInvitationHandoff,
    (_event, input: unknown) =>
      runCollaborationCommand(
        () => runCoordinationOperation("invitation.getHandoff", () => invitationHandoff.get(input)),
        collaborationInvitationHandoffResponseSchema
      )
  );
  handleDesktopCommand(
    collaborationInvokeChannels.revokeCollaborationInvitation,
    (_event, input: unknown) =>
      runCollaborationCommand(() => active.revokeInvitation(input), humanInvitationViewSchema)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.revokeCollaborationInvitations,
    (_event, input: unknown) =>
      runCollaborationCommand(
        () => active.revokeInvitations(input),
        humanRevokeInvitationsResponseSchema
      )
  );
  handleDesktopCommand(
    collaborationInvokeChannels.removeCollaborationMember,
    (_event, input: unknown) =>
      runCollaborationCommand(() => active.removeMember(input), z.undefined())
  );
  handleDesktopCommand(
    collaborationInvokeChannels.promoteCollaborationOwner,
    (_event, input: unknown) =>
      runCollaborationCommand(() => active.promoteOwner(input), z.undefined())
  );
  handleDesktopCommand(
    collaborationInvokeChannels.demoteCollaborationOwner,
    (_event, input: unknown) =>
      runCollaborationCommand(() => active.demoteOwner(input), z.undefined())
  );
  handleDesktopCommand(
    collaborationInvokeChannels.revokeCollaborationDevice,
    (_event, input: unknown) =>
      runCollaborationCommand(() => active.revokeDevice(input), z.undefined())
  );
  handleDesktopCommand(
    collaborationInvokeChannels.listCollaborationAssignments,
    (_event, input: unknown) => active.listAssignments(input)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.getCollaborationAssignment,
    (_event, input: unknown) => active.getAssignment(input)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.listCollaborationEligibleAssignees,
    (_event, input: unknown) => active.listEligibleAssignees(input)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.listCollaborationEligibleHostsBatch,
    (_event, input: unknown) => active.listEligibleHostsBatch(input)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.getCollaborationWorkAuthority,
    (_event, input: unknown) => active.getWorkAuthority(input)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.updateCollaborationResponsibility,
    (_event, input: unknown) => active.updateResponsibility(input)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.updateCollaborationReviewer,
    (_event, input: unknown) => active.updateReviewer(input)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.listCollaborationComments,
    (_event, input: unknown) => active.listComments(input)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.listCollaborationActivity,
    (_event, input: unknown) => active.listActivity(input)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.listCollaborationAuthorizedProjects,
    (_event, input: unknown) => active.registry().listAuthorizedProjects(input)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.listCollaborationAuthorizedCanvases,
    (_event, input: unknown) => active.registry().listAuthorizedCanvases(input)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.readCollaborationPackageSnapshot,
    (_event, input: unknown) => active.registry().readSnapshot(input)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.createCollaborationPackageSnapshot,
    (_event, input: unknown) => active.registry().createSnapshot(input)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.restoreCollaborationPackageSnapshot,
    (_event, input: unknown) => active.registry().restoreSnapshot(input)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.updateCollaborationAssignment,
    (_event, input: unknown) => active.updateAssignment(input)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.createCollaborationComment,
    (_event, input: unknown) => active.createComment(input)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.editCollaborationComment,
    (_event, input: unknown) => active.editComment(input)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.tombstoneCollaborationComment,
    (_event, input: unknown) => active.tombstoneComment(input)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.createCollaborationPendingAttachment,
    (_event, input: unknown) => active.createPendingAttachment(input)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.uploadCollaborationPendingAttachment,
    (_event, input: unknown) => active.uploadPendingAttachment(input)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.finalizeCollaborationPendingAttachment,
    (_event, input: unknown) => active.finalizePendingAttachment(input)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.readCollaborationCommentAttachment,
    (_event, input: unknown) => active.readCommentAttachment(input)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.listCollaborationAgentEndpoints,
    (_event, input: unknown) => active.listAgentEndpoints(input)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.observeCollaborationRemoteOperation,
    (_event, input: unknown) => active.observeRemoteOperation(input)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.lookupCollaborationRemoteOperation,
    (_event, input: unknown) => active.lookupRemoteOperation(input)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.lookupWorkspaceRemoteOperation,
    (_event, input: unknown) => active.lookupWorkspaceRemoteOperation(input)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.observeWorkspaceRemoteOperation,
    (_event, input: unknown) => active.observeWorkspaceRemoteOperation(input)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.replayCollaborationRemoteOperationEvents,
    (_event, input: unknown) => active.replayRemoteOperationEvents(input)
  );
  handleDesktopCommand(
    collaborationInvokeChannels.replayWorkspaceRemoteOperationEvents,
    (_event, input: unknown) => active.replayWorkspaceRemoteOperationEvents(input)
  );

  return active;
}

export async function shutdownCollaborationHandlers(): Promise<void> {
  const activeLifecycle = handlerLifecycle;
  handlerLifecycle = null;
  await activeLifecycle?.closeAndDrain();

  const activeService = service;
  service = null;
  await activeService?.shutdown();

  const activeCoordinator = coordinator;
  coordinator = null;
  setLocalOperatorBackendPort(null);
  await activeCoordinator?.stop();
}
