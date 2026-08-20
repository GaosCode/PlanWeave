import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage } from "electron";
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
  collaborationCanvasBindingInputSchema,
  collaborationContentBootstrapCandidateSchema,
  collaborationInvokeChannels,
  collaborationObserverSignalChannel,
  collaborationPresenceSignalChannel,
  collaborationCanvasLiveSyncSignalChannel,
  collaborationCanvasBindingReplicaSignalChannel,
  collaborationStatusChangedChannel,
  type CollaborationObserverSignal,
  type CollaborationStatus
} from "../../shared/collaboration.js";
import { localCollaborationRegistrationInputSchema } from "../../shared/localCollaborationScopes.js";
import {
  CollaborationClient,
  type CollaborationWebSocketConstructor
} from "./CollaborationClient.js";
import { CollaborationService, type CollaborationServiceOptions } from "./collaborationService.js";
import type { CollaborationCanvasBindingReplicaSignal } from "../../shared/canvasReplicaIpc.js";
import { LocalCollaborationCoordinatorControl } from "./CollaborationCoordinatorControl.js";
import { DeploymentActions } from "./deploymentActions.js";
import { runCollaborationCommand } from "./collaborationCommandHandler.js";
import { createLocalCollaborationActivationCommand } from "./localCollaborationSelectionActivation.js";
import { CollaborationInvitationHandoffCoordinator } from "./CollaborationInvitationHandoffCoordinator.js";
import { getOperatorControlService } from "../operatorControl/operatorControlHandlers.js";
import { setLocalOperatorBackendPort } from "../operatorControl/localOperatorBackend.js";
import { createCollaborationCoordinationQueue } from "./collaborationCoordinationQueue.js";
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

function publishCanvasLiveSyncSignalToRenderers(
  signal: Parameters<NonNullable<CollaborationServiceOptions["onCanvasLiveSyncSignal"]>>[0]
): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(collaborationCanvasLiveSyncSignalChannel, signal);
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
    onCanvasLiveSyncSignal:
      options.onCanvasLiveSyncSignal ?? publishCanvasLiveSyncSignalToRenderers,
    onCanvasReplicaSignal: options.onCanvasReplicaSignal ?? publishCanvasReplicaSignalToRenderers,
    bindLiveOperatorToOrigin:
      options.bindLiveOperatorToOrigin ??
      (async (serverBaseUrl) => {
        await getOperatorControlService().bindActiveProfileToLiveOrigin(serverBaseUrl);
      })
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
  const coordinationQueue = createCollaborationCoordinationQueue();
  const runCoordinationOperation = <T>(operation: () => Promise<T>): Promise<T> =>
    lifecycle.run(() => coordinationQueue(operation));
  const persistedWorkspaceReady = runCoordinationOperation(async () => {
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
  }).catch((error: unknown) => {
    console.error("Failed to restore the persisted collaboration Workspace.", error);
  });
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
    onExported: () => active.snapshotExportedServerDataIdentity()
  });

  ipcMain.handle(collaborationInvokeChannels.getCollaborationStatus, () =>
    lifecycle.run(async () => {
      await persistedWorkspaceReady;
      return active.getStatus();
    })
  );
  ipcMain.handle(collaborationInvokeChannels.upsertCollaborationProfile, (_event, input: unknown) =>
    runCoordinationOperation(() => {
      assertRendererProfileNamespace(input);
      return active.upsertProfile(input);
    })
  );
  ipcMain.handle(collaborationInvokeChannels.removeCollaborationProfile, (_event, input: unknown) =>
    runCoordinationOperation(() => active.removeProfile(input))
  );
  ipcMain.handle(
    collaborationInvokeChannels.setActiveCollaborationProfile,
    (_event, input: unknown) => runCoordinationOperation(() => active.setActiveProfile(input))
  );
  ipcMain.handle(
    collaborationInvokeChannels.exportDeploymentComposeBundle,
    (_event, input: unknown) => deploymentActions.exportComposeBundle(input)
  );
  ipcMain.handle(collaborationInvokeChannels.listServerDataExportSources, () =>
    lifecycle.run(async () => {
      await localReady;
      return serverDataMigration.listSources();
    })
  );
  ipcMain.handle(collaborationInvokeChannels.exportServerDataArchive, (_event, input: unknown) =>
    runCoordinationOperation(async () => {
      await localReady;
      return serverDataMigration.exportArchive(input);
    })
  );
  ipcMain.handle(collaborationInvokeChannels.restoreServerDataArchive, (_event, input: unknown) =>
    runCoordinationOperation(async () => {
      await localReady;
      return serverDataMigration.restoreArchive(input);
    })
  );
  ipcMain.handle(collaborationInvokeChannels.clearActiveCollaborationProfile, () =>
    runCoordinationOperation(() => active.clearActiveProfile())
  );
  ipcMain.handle(collaborationInvokeChannels.importDeviceCredential, (_event, input: unknown) =>
    active.importDeviceCredential(input)
  );
  ipcMain.handle(collaborationInvokeChannels.clearDeviceCredential, (_event, input: unknown) =>
    active.clearDeviceCredential(input)
  );
  ipcMain.handle(
    collaborationInvokeChannels.bootstrapCollaborationOwner,
    (_event, input: unknown) =>
      runCoordinationOperation(async () => {
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
  ipcMain.handle(
    collaborationInvokeChannels.consumeCollaborationInvitation,
    (_event, input: unknown) => runCoordinationOperation(() => active.consumeInvitation(input))
  );
  ipcMain.handle(
    collaborationInvokeChannels.connectCollaborationSession,
    (_event, input: unknown) => runCoordinationOperation(() => active.connectSession(input))
  );
  ipcMain.handle(collaborationInvokeChannels.disconnectCollaborationSession, () =>
    runCoordinationOperation(() => active.disconnectSession())
  );
  ipcMain.handle(
    collaborationInvokeChannels.redeemCollaborationSetupCode,
    (_event, input: unknown) => runCoordinationOperation(() => active.redeemSetupCode(input))
  );
  ipcMain.handle(
    collaborationInvokeChannels.connectExistingServerByOrigin,
    (_event, input: unknown) =>
      runCoordinationOperation(() => active.connectExistingServerByOrigin(input))
  );
  ipcMain.handle(collaborationInvokeChannels.getActiveWorkspaceConnection, () =>
    lifecycle.run(async () => {
      await persistedWorkspaceReady;
      return active.getActiveWorkspaceConnection();
    })
  );
  ipcMain.handle(collaborationInvokeChannels.listRememberedServerConnections, () =>
    lifecycle.run(async () => {
      await persistedWorkspaceReady;
      return active.listRememberedServerConnections();
    })
  );
  ipcMain.handle(
    collaborationInvokeChannels.forgetRememberedServerConnection,
    (_event, input: unknown) =>
      runCoordinationOperation(() => active.forgetRememberedServerConnection(input))
  );
  ipcMain.handle(collaborationInvokeChannels.listWorkspacePicker, (_event, input: unknown) =>
    active.listWorkspacePicker(input)
  );
  ipcMain.handle(collaborationInvokeChannels.selectWorkspaceConnection, (_event, input: unknown) =>
    runCoordinationOperation(() => active.selectWorkspaceConnection(input))
  );
  ipcMain.handle(collaborationInvokeChannels.connectWorkspaceConnection, () =>
    runCoordinationOperation(() => active.connectWorkspaceConnection())
  );
  ipcMain.handle(collaborationInvokeChannels.disconnectWorkspaceConnection, () =>
    runCoordinationOperation(() => active.disconnectWorkspaceConnection())
  );
  ipcMain.handle(collaborationInvokeChannels.retryWorkspaceConnection, () =>
    runCoordinationOperation(() => active.retryWorkspaceConnection())
  );
  ipcMain.handle(collaborationInvokeChannels.getDeploymentGuidance, (_event, input: unknown) =>
    deploymentActions.guidance(input)
  );
  ipcMain.handle(
    collaborationInvokeChannels.copyDeploymentComposeHandoff,
    (_event, input: unknown) => deploymentActions.copyComposeHandoff(input)
  );
  ipcMain.handle(
    collaborationInvokeChannels.validateDeploymentConnectivity,
    (_event, input: unknown) => deploymentActions.validateConnectivity(input)
  );
  ipcMain.handle(collaborationInvokeChannels.getDesktopServerExposure, () =>
    lifecycle.run(async () => {
      await localReady;
      await local.reconcileManagementProfile();
      return local.getExposureView();
    })
  );
  ipcMain.handle(
    collaborationInvokeChannels.setDesktopServerExposureMode,
    (_event, input: unknown) =>
      runCoordinationOperation(() =>
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
  ipcMain.handle(collaborationInvokeChannels.startCollaborationPresence, (_event, input: unknown) =>
    active.startPresence(input)
  );
  ipcMain.handle(collaborationInvokeChannels.stopCollaborationPresence, () =>
    active.stopPresence()
  );
  ipcMain.handle(
    collaborationInvokeChannels.startCollaborationCanvasBindingLiveSync,
    (_event, input: unknown) =>
      active.startCanvasLiveSync(collaborationCanvasBindingInputSchema.parse(input))
  );
  ipcMain.handle(collaborationInvokeChannels.stopCollaborationCanvasLiveSync, () =>
    active.stopCanvasLiveSync()
  );
  ipcMain.handle(
    collaborationInvokeChannels.publishCollaborationPresence,
    (_event, input: unknown) => active.publishPresence(input)
  );
  ipcMain.handle(
    collaborationInvokeChannels.submitCollaborationCanvasCommand,
    (_event, input: unknown) => active.submitCanvasCommand(input)
  );
  ipcMain.handle(
    collaborationInvokeChannels.reconnectCollaborationCanvas,
    (_event, input: unknown) => active.reconnectCanvas(input)
  );
  ipcMain.handle(
    collaborationInvokeChannels.bindCollaborationCanvasBindingSession,
    (_event, input: unknown) =>
      active.bindCanvasCommandSession(collaborationCanvasBindingInputSchema.parse(input))
  );
  ipcMain.handle(collaborationInvokeChannels.getCollaborationCanvasCommandSession, () =>
    active.getCanvasCommandSession()
  );
  ipcMain.handle(collaborationInvokeChannels.flushCollaborationCanvasReplicaMaterialization, () =>
    active.flushCanvasReplicaMaterialization()
  );
  ipcMain.handle(
    collaborationInvokeChannels.resolveCollaborationCanvasBindingScope,
    (_event, input: unknown) =>
      active.resolveCanvasScope(collaborationCanvasBindingInputSchema.parse(input))
  );
  ipcMain.handle(
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
  ipcMain.handle(
    collaborationInvokeChannels.getCollaborationCanvasBindingReplicaProjection,
    (_event, input: unknown) =>
      active.getCanvasReplicaProjection(collaborationCanvasBindingInputSchema.parse(input))
  );
  ipcMain.handle(
    collaborationInvokeChannels.bindCollaborationCanvasBindingContentAuthority,
    (_event, input: unknown) =>
      active.bindContentAuthority(collaborationCanvasBindingInputSchema.parse(input))
  );
  ipcMain.handle(collaborationInvokeChannels.getCollaborationContentAuthority, () =>
    active.getContentAuthority()
  );
  ipcMain.handle(collaborationInvokeChannels.refreshCollaborationContentAuthority, () =>
    active.refreshContentAuthority()
  );
  ipcMain.handle(collaborationInvokeChannels.publishCollaborationInitialContent, () =>
    active.publishInitialContent()
  );
  ipcMain.handle(collaborationInvokeChannels.materializeCollaborationContentHead, () =>
    active.materializeContentHead()
  );
  ipcMain.handle(collaborationInvokeChannels.listCollaborationContentBootstrapCandidates, () =>
    runCollaborationCommand(
      () => active.listContentBootstrapCandidates(),
      z.array(collaborationContentBootstrapCandidateSchema)
    )
  );
  ipcMain.handle(
    collaborationInvokeChannels.bootstrapCollaborationContent,
    (_event, input: unknown) => active.bootstrapContent(input)
  );
  ipcMain.handle(collaborationInvokeChannels.getCurrentCanvasAccess, (_event, input: unknown) =>
    active.getCurrentCanvasAccess(input)
  );
  ipcMain.handle(collaborationInvokeChannels.mutateCurrentCanvasAccess, (_event, input: unknown) =>
    active.mutateCurrentCanvasAccess(input)
  );
  ipcMain.handle(
    collaborationInvokeChannels.setCollaborationCurrentSelection,
    (_event, input: unknown) =>
      runCoordinationOperation(async () => {
        const registrationInput = localCollaborationRegistrationInputSchema.parse({
          selection: input
        });
        if (!registrationInput.selection) {
          throw new Error("local_collaboration_selection_required");
        }
        await localActivation.selectAndReconcile(registrationInput.selection);
      })
  );
  ipcMain.handle(collaborationInvokeChannels.clearCollaborationCurrentSelection, () =>
    runCoordinationOperation(async () => {
      await local.clearCurrentSelection();
    })
  );
  ipcMain.handle(collaborationInvokeChannels.getLocalCollaborationServerStatus, () =>
    lifecycle.run(async () => {
      await localReady;
      return local.status();
    })
  );
  ipcMain.handle(collaborationInvokeChannels.getLocalCollaborationScopeCatalog, () =>
    local.getScopeCatalog()
  );
  ipcMain.handle(
    collaborationInvokeChannels.setLocalCollaborationTrustedScopes,
    (_event, input: unknown) =>
      runCoordinationOperation(async () => {
        const catalog = await local.setTrustedScopes(input);
        await localActivation.reconcile();
        return catalog;
      })
  );
  ipcMain.handle(collaborationInvokeChannels.startLocalCollaborationServer, () =>
    runCoordinationOperation(async () => {
      const status = await local.start();
      if (status.state !== "running") return status;
      await active.markLastServerConnectionLocal();
      await localActivation.reconcile();
      return status;
    })
  );
  ipcMain.handle(collaborationInvokeChannels.stopLocalCollaborationServer, () =>
    runCoordinationOperation(async () => {
      const previousProfileId = local.localProfile()?.profileId;
      const status = await local.stop();
      await suspendLocalSession(previousProfileId);
      return status;
    })
  );
  ipcMain.handle(
    collaborationInvokeChannels.setLocalCollaborationLanSharing,
    (_event, input: unknown) =>
      runCoordinationOperation(async () => {
        const status = await local.setLanSharing(input);
        await localActivation.reconcile();
        return status;
      })
  );
  ipcMain.handle(collaborationInvokeChannels.listLocalCollaborationTrustedScopes, () =>
    local.listActiveTrustedScopes()
  );
  ipcMain.handle(
    collaborationInvokeChannels.registerLocalCollaborationCurrentProject,
    (_event, input: unknown) =>
      runCoordinationOperation(async () => {
        const registrationInput = localCollaborationRegistrationInputSchema.parse(input ?? {});
        return localActivation.activate(registrationInput);
      })
  );
  ipcMain.handle(collaborationInvokeChannels.listCollaborationMembers, (_event, input: unknown) =>
    runCollaborationCommand(() => active.listMembers(input), humanMemberPageSchema)
  );
  ipcMain.handle(
    collaborationInvokeChannels.updateOwnCollaborationDisplayName,
    (_event, input: unknown) =>
      runCollaborationCommand(() => active.updateOwnDisplayName(input), humanPrincipalViewSchema)
  );
  ipcMain.handle(collaborationInvokeChannels.listCollaborationDevices, (_event, input: unknown) =>
    runCollaborationCommand(() => active.listDevices(input), humanDevicePageSchema)
  );
  ipcMain.handle(
    collaborationInvokeChannels.listCollaborationInvitations,
    (_event, input: unknown) =>
      runCollaborationCommand(() => active.listInvitations(input), humanInvitationPageSchema)
  );
  ipcMain.handle(
    collaborationInvokeChannels.createCollaborationInvitation,
    (_event, input: unknown) =>
      runCollaborationCommand(
        () => active.createInvitation(input),
        humanCreateInvitationResponseSchema
      )
  );
  ipcMain.handle(
    collaborationInvokeChannels.createCollaborationInvitationHandoff,
    (_event, input: unknown) =>
      runCollaborationCommand(
        () => runCoordinationOperation(() => invitationHandoff.create(input)),
        collaborationInvitationHandoffResponseSchema
      )
  );
  ipcMain.handle(
    collaborationInvokeChannels.getCollaborationInvitationSecret,
    (_event, input: unknown) =>
      runCollaborationCommand(
        () => active.getInvitationSecret(input),
        humanCreateInvitationResponseSchema
      )
  );
  ipcMain.handle(
    collaborationInvokeChannels.getCollaborationInvitationHandoff,
    (_event, input: unknown) =>
      runCollaborationCommand(
        () => runCoordinationOperation(() => invitationHandoff.get(input)),
        collaborationInvitationHandoffResponseSchema
      )
  );
  ipcMain.handle(
    collaborationInvokeChannels.revokeCollaborationInvitation,
    (_event, input: unknown) =>
      runCollaborationCommand(() => active.revokeInvitation(input), humanInvitationViewSchema)
  );
  ipcMain.handle(
    collaborationInvokeChannels.revokeCollaborationInvitations,
    (_event, input: unknown) =>
      runCollaborationCommand(
        () => active.revokeInvitations(input),
        humanRevokeInvitationsResponseSchema
      )
  );
  ipcMain.handle(collaborationInvokeChannels.removeCollaborationMember, (_event, input: unknown) =>
    runCollaborationCommand(() => active.removeMember(input), z.undefined())
  );
  ipcMain.handle(collaborationInvokeChannels.promoteCollaborationOwner, (_event, input: unknown) =>
    runCollaborationCommand(() => active.promoteOwner(input), z.undefined())
  );
  ipcMain.handle(collaborationInvokeChannels.demoteCollaborationOwner, (_event, input: unknown) =>
    runCollaborationCommand(() => active.demoteOwner(input), z.undefined())
  );
  ipcMain.handle(collaborationInvokeChannels.revokeCollaborationDevice, (_event, input: unknown) =>
    runCollaborationCommand(() => active.revokeDevice(input), z.undefined())
  );
  ipcMain.handle(
    collaborationInvokeChannels.listCollaborationAssignments,
    (_event, input: unknown) => active.listAssignments(input)
  );
  ipcMain.handle(collaborationInvokeChannels.getCollaborationAssignment, (_event, input: unknown) =>
    active.getAssignment(input)
  );
  ipcMain.handle(
    collaborationInvokeChannels.listCollaborationEligibleAssignees,
    (_event, input: unknown) => active.listEligibleAssignees(input)
  );
  ipcMain.handle(
    collaborationInvokeChannels.listCollaborationEligibleHostsBatch,
    (_event, input: unknown) => active.listEligibleHostsBatch(input)
  );
  ipcMain.handle(
    collaborationInvokeChannels.getCollaborationWorkAuthority,
    (_event, input: unknown) => active.getWorkAuthority(input)
  );
  ipcMain.handle(
    collaborationInvokeChannels.updateCollaborationResponsibility,
    (_event, input: unknown) => active.updateResponsibility(input)
  );
  ipcMain.handle(
    collaborationInvokeChannels.updateCollaborationReviewer,
    (_event, input: unknown) => active.updateReviewer(input)
  );
  ipcMain.handle(collaborationInvokeChannels.listCollaborationComments, (_event, input: unknown) =>
    active.listComments(input)
  );
  ipcMain.handle(collaborationInvokeChannels.listCollaborationActivity, (_event, input: unknown) =>
    active.listActivity(input)
  );
  ipcMain.handle(
    collaborationInvokeChannels.listCollaborationAuthorizedProjects,
    (_event, input: unknown) => active.registry().listAuthorizedProjects(input)
  );
  ipcMain.handle(
    collaborationInvokeChannels.listCollaborationAuthorizedCanvases,
    (_event, input: unknown) => active.registry().listAuthorizedCanvases(input)
  );
  ipcMain.handle(
    collaborationInvokeChannels.readCollaborationPackageSnapshot,
    (_event, input: unknown) => active.registry().readSnapshot(input)
  );
  ipcMain.handle(
    collaborationInvokeChannels.createCollaborationPackageSnapshot,
    (_event, input: unknown) => active.registry().createSnapshot(input)
  );
  ipcMain.handle(
    collaborationInvokeChannels.restoreCollaborationPackageSnapshot,
    (_event, input: unknown) => active.registry().restoreSnapshot(input)
  );
  ipcMain.handle(
    collaborationInvokeChannels.updateCollaborationAssignment,
    (_event, input: unknown) => active.updateAssignment(input)
  );
  ipcMain.handle(collaborationInvokeChannels.createCollaborationComment, (_event, input: unknown) =>
    active.createComment(input)
  );
  ipcMain.handle(collaborationInvokeChannels.editCollaborationComment, (_event, input: unknown) =>
    active.editComment(input)
  );
  ipcMain.handle(
    collaborationInvokeChannels.tombstoneCollaborationComment,
    (_event, input: unknown) => active.tombstoneComment(input)
  );
  ipcMain.handle(
    collaborationInvokeChannels.createCollaborationPendingAttachment,
    (_event, input: unknown) => active.createPendingAttachment(input)
  );
  ipcMain.handle(
    collaborationInvokeChannels.uploadCollaborationPendingAttachment,
    (_event, input: unknown) => active.uploadPendingAttachment(input)
  );
  ipcMain.handle(
    collaborationInvokeChannels.finalizeCollaborationPendingAttachment,
    (_event, input: unknown) => active.finalizePendingAttachment(input)
  );
  ipcMain.handle(
    collaborationInvokeChannels.readCollaborationCommentAttachment,
    (_event, input: unknown) => active.readCommentAttachment(input)
  );
  ipcMain.handle(collaborationInvokeChannels.listCollaborationAgentEndpoints, () =>
    active.listAgentEndpoints()
  );
  ipcMain.handle(
    collaborationInvokeChannels.dispatchCollaborationRemoteOperation,
    (_event, input: unknown) => active.dispatchRemoteOperation(input)
  );
  ipcMain.handle(
    collaborationInvokeChannels.observeCollaborationRemoteOperation,
    (_event, input: unknown) => active.observeRemoteOperation(input)
  );
  ipcMain.handle(
    collaborationInvokeChannels.executeCollaborationRemoteOperationAction,
    (_event, input: unknown) => active.executeRemoteOperationAction(input)
  );
  ipcMain.handle(
    collaborationInvokeChannels.replayCollaborationRemoteOperationEvents,
    (_event, input: unknown) => active.replayRemoteOperationEvents(input)
  );
  ipcMain.handle(
    collaborationInvokeChannels.listCollaborationRemoteOperationInteractions,
    (_event, input: unknown) => active.listRemoteOperationInteractions(input)
  );
  ipcMain.handle(
    collaborationInvokeChannels.settleCollaborationRemoteOperationInteraction,
    (_event, input: unknown) => active.settleRemoteOperationInteraction(input)
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
