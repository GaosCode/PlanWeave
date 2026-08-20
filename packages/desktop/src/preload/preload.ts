import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import { z } from "zod";
import { canvasRuntimeAvailabilitySchema } from "@planweave-ai/collaboration-protocol/canvas/runtime-availability";
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
import type {
  DesktopAutoRunEvent,
  DesktopBridgeApi,
  DesktopPackageFileChangeEvent,
  DesktopRunnerRecordSubscriptionInput,
  DesktopRunnerRecordSubscriptionPush,
  DesktopRuntimeStateChangeEvent
} from "@planweave-ai/runtime";
import type { AppUpdateState, PlanWeaveAppUpdateApi } from "../shared/appUpdate.js";
import { appUpdateChangedChannel, appUpdateInvokeChannels } from "../shared/appUpdate.js";
import type { PlanWeaveDesktopSettingsApi } from "../shared/desktopSettings.js";
import { desktopSettingsInvokeChannels } from "../shared/desktopSettings.js";
import type { PlanWeaveCredentialStorageSettingsApi } from "../shared/credentialStorageSettings.js";
import { credentialStorageSettingsInvokeChannels } from "../shared/credentialStorageSettings.js";
import {
  autoRunChangedChannel,
  packageFileChangedChannel,
  runnerRecordEventChannel,
  runnerRecordSubscribeChannel,
  runnerRecordUnsubscribeChannel,
  runtimeStateChangedChannel
} from "../shared/ipcChannels.js";
import {
  collaborationContentBootstrapCandidateSchema,
  type CollaborationObserverSignal,
  type CollaborationCanvasLiveSyncSignal,
  type CollaborationPresenceSignal,
  type CollaborationStatus,
  type PlanWeaveCollaborationApi
} from "../shared/collaboration.js";
import {
  collaborationCanvasReplicaProjectionSchema,
  collaborationCanvasReplicaSignalSchema
} from "../shared/canvasReplicaIpc.js";
import {
  collaborationInvokeChannels,
  collaborationObserverSignalChannel,
  collaborationCanvasLiveSyncSignalChannel,
  collaborationCanvasReplicaSignalChannel,
  collaborationPresenceSignalChannel,
  collaborationStatusChangedChannel
} from "../shared/collaborationIpc.js";
import { unwrapCollaborationCommandResult } from "../shared/collaborationCommandIpc.js";
import type {
  PlanWeaveOperatorControlApi,
  OperatorControlStatus
} from "../shared/operatorControl.js";
import {
  operatorControlInvokeChannels,
  operatorControlStatusChangedChannel
} from "../shared/operatorControlIpc.js";
import type { McpTunnelStatus, PlanWeaveMcpTunnelApi } from "../shared/mcpTunnel.js";
import { mcpTunnelChangedChannel, mcpTunnelInvokeChannels } from "../shared/mcpTunnel.js";
import {
  windowAppearanceInvokeChannels,
  type PlanWeaveWindowApi
} from "../shared/windowAppearance.js";
import { createDesktopBridgeInvokeApi } from "./bridgeInvocation.js";

const invokeApi = createDesktopBridgeInvokeApi((channel, ...args) =>
  ipcRenderer.invoke(channel, ...args)
);
let lastSmokeRevealPath: string | null = null;
let runnerRecordSubscriptionSequence = 0;

function runnerRecordSubscriptionIsTerminal(
  snapshot: Extract<DesktopRunnerRecordSubscriptionPush, { kind: "snapshot" }>["snapshot"]
): boolean {
  return (
    snapshot.terminal &&
    !snapshot.intervention.prompt.available &&
    !snapshot.intervention.prompt.inFlight
  );
}

const api: DesktopBridgeApi = {
  ...invokeApi,
  revealPathInFinder: async (path) => {
    if (process.env.PLANWEAVE_DESKTOP_SMOKE === "1") {
      lastSmokeRevealPath = path;
      return;
    }
    await invokeApi.revealPathInFinder(path);
  },
  onPackageFileChanged: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: DesktopPackageFileChangeEvent) =>
      callback(payload);
    ipcRenderer.on(packageFileChangedChannel, listener);
    return () => ipcRenderer.off(packageFileChangedChannel, listener);
  },
  onRuntimeStateChanged: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: DesktopRuntimeStateChangeEvent) =>
      callback(payload);
    ipcRenderer.on(runtimeStateChangedChannel, listener);
    return () => ipcRenderer.off(runtimeStateChangedChannel, listener);
  },
  onAutoRunChanged: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: DesktopAutoRunEvent) => callback(payload);
    ipcRenderer.on(autoRunChangedChannel, listener);
    return () => ipcRenderer.off(autoRunChangedChannel, listener);
  },
  subscribeRunnerRecord: async (input, callback) => {
    runnerRecordSubscriptionSequence += 1;
    const subscriptionId = `renderer-${runnerRecordSubscriptionSequence}`;
    let active = true;
    const listener = (_event: IpcRendererEvent, payload: DesktopRunnerRecordSubscriptionPush) => {
      if (!active || payload.subscriptionId !== subscriptionId) return;
      if (payload.kind === "closed") {
        active = false;
        ipcRenderer.off(runnerRecordEventChannel, listener);
        callback({
          kind: "closed",
          updateSequence: payload.updateSequence,
          close: payload.close
        });
        return;
      }
      callback({
        kind: "snapshot",
        updateSequence: payload.updateSequence,
        snapshot: payload.snapshot
      });
      if (runnerRecordSubscriptionIsTerminal(payload.snapshot)) {
        active = false;
        ipcRenderer.off(runnerRecordEventChannel, listener);
      }
    };
    ipcRenderer.on(runnerRecordEventChannel, listener);
    const request: DesktopRunnerRecordSubscriptionInput = {
      ...input,
      subscriptionId
    };
    try {
      const start = await ipcRenderer.invoke(runnerRecordSubscribeChannel, request);
      if (start.snapshot && runnerRecordSubscriptionIsTerminal(start.snapshot)) {
        active = false;
        ipcRenderer.off(runnerRecordEventChannel, listener);
      }
      return {
        ...start,
        unsubscribe: async () => {
          if (!active) return;
          active = false;
          ipcRenderer.off(runnerRecordEventChannel, listener);
          await ipcRenderer.invoke(runnerRecordUnsubscribeChannel, subscriptionId);
        }
      };
    } catch (error) {
      active = false;
      ipcRenderer.off(runnerRecordEventChannel, listener);
      throw error;
    }
  }
};

contextBridge.exposeInMainWorld("planweave", api);

const desktopSettingsApi: PlanWeaveDesktopSettingsApi = {
  getDesktopSettings: async () =>
    ipcRenderer.invoke(desktopSettingsInvokeChannels.getDesktopSettings),
  saveDesktopSettings: async (patch) =>
    ipcRenderer.invoke(desktopSettingsInvokeChannels.saveDesktopSettings, patch),
  migrateLegacyDesktopSettings: async (payload) =>
    ipcRenderer.invoke(desktopSettingsInvokeChannels.migrateLegacyDesktopSettings, payload)
};

contextBridge.exposeInMainWorld("planweaveDesktopSettings", desktopSettingsApi);

const credentialStorageSettingsApi: PlanWeaveCredentialStorageSettingsApi = {
  getCredentialStorageSettings: async () =>
    ipcRenderer.invoke(credentialStorageSettingsInvokeChannels.getStatus),
  configureCredentialStorage: async (input) =>
    ipcRenderer.invoke(credentialStorageSettingsInvokeChannels.configure, input)
};

contextBridge.exposeInMainWorld("planweaveCredentialStorageSettings", credentialStorageSettingsApi);

const windowApi: PlanWeaveWindowApi = {
  getWindowMaterialCapabilities: async () =>
    ipcRenderer.invoke(windowAppearanceInvokeChannels.getWindowMaterialCapabilities),
  setWindowMaterial: async (settings) => {
    await ipcRenderer.invoke(windowAppearanceInvokeChannels.setWindowMaterial, settings);
  }
};

contextBridge.exposeInMainWorld("planweaveWindow", windowApi);

const appUpdateApi: PlanWeaveAppUpdateApi = {
  checkForAppUpdate: async () => ipcRenderer.invoke(appUpdateInvokeChannels.checkForAppUpdate),
  downloadAppUpdate: async () => ipcRenderer.invoke(appUpdateInvokeChannels.downloadAppUpdate),
  getAppUpdateState: async () => ipcRenderer.invoke(appUpdateInvokeChannels.getAppUpdateState),
  installAppUpdate: async () => ipcRenderer.invoke(appUpdateInvokeChannels.installAppUpdate),
  onAppUpdateChanged: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: AppUpdateState) => callback(payload);
    ipcRenderer.on(appUpdateChangedChannel, listener);
    return () => ipcRenderer.off(appUpdateChangedChannel, listener);
  }
};

contextBridge.exposeInMainWorld("planweaveAppUpdate", appUpdateApi);

const mcpTunnelApi: PlanWeaveMcpTunnelApi = {
  getMcpTunnelStatus: async () => ipcRenderer.invoke(mcpTunnelInvokeChannels.getMcpTunnelStatus),
  downloadTunnelClient: async () =>
    ipcRenderer.invoke(mcpTunnelInvokeChannels.downloadTunnelClient),
  setTunnelClientPath: async (path) =>
    ipcRenderer.invoke(mcpTunnelInvokeChannels.setTunnelClientPath, path),
  setTunnelAutoStart: async (enabled) =>
    ipcRenderer.invoke(mcpTunnelInvokeChannels.setTunnelAutoStart, enabled),
  startLocalMcp: async (input) => ipcRenderer.invoke(mcpTunnelInvokeChannels.startLocalMcp, input),
  stopLocalMcp: async () => ipcRenderer.invoke(mcpTunnelInvokeChannels.stopLocalMcp),
  startTunnel: async (input) => ipcRenderer.invoke(mcpTunnelInvokeChannels.startTunnel, input),
  stopTunnel: async () => ipcRenderer.invoke(mcpTunnelInvokeChannels.stopTunnel),
  onMcpTunnelChanged: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: McpTunnelStatus) => callback(payload);
    ipcRenderer.on(mcpTunnelChangedChannel, listener);
    return () => ipcRenderer.off(mcpTunnelChangedChannel, listener);
  }
};

contextBridge.exposeInMainWorld("planweaveMcpTunnel", mcpTunnelApi);

const collaborationApi: PlanWeaveCollaborationApi = {
  getCollaborationStatus: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.getCollaborationStatus),
  upsertCollaborationProfile: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.upsertCollaborationProfile, input),
  removeCollaborationProfile: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.removeCollaborationProfile, input),
  setActiveCollaborationProfile: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.setActiveCollaborationProfile, input),
  clearActiveCollaborationProfile: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.clearActiveCollaborationProfile),
  importDeviceCredential: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.importDeviceCredential, input),
  clearDeviceCredential: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.clearDeviceCredential, input),
  bootstrapCollaborationOwner: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.bootstrapCollaborationOwner, input),
  consumeCollaborationInvitation: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.consumeCollaborationInvitation, input),
  connectCollaborationSession: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.connectCollaborationSession, input),
  disconnectCollaborationSession: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.disconnectCollaborationSession),
  redeemCollaborationSetupCode: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.redeemCollaborationSetupCode, input),
  connectExistingServerByOrigin: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.connectExistingServerByOrigin, input),
  getActiveWorkspaceConnection: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.getActiveWorkspaceConnection),
  listRememberedServerConnections: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.listRememberedServerConnections),
  forgetRememberedServerConnection: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.forgetRememberedServerConnection, input),
  listWorkspacePicker: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.listWorkspacePicker, input),
  selectWorkspaceConnection: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.selectWorkspaceConnection, input),
  connectWorkspaceConnection: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.connectWorkspaceConnection),
  disconnectWorkspaceConnection: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.disconnectWorkspaceConnection),
  retryWorkspaceConnection: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.retryWorkspaceConnection),
  getDeploymentGuidance: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.getDeploymentGuidance, input),
  copyDeploymentComposeHandoff: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.copyDeploymentComposeHandoff, input),
  exportDeploymentComposeBundle: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.exportDeploymentComposeBundle, input),
  listServerDataExportSources: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.listServerDataExportSources),
  exportServerDataArchive: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.exportServerDataArchive, input),
  restoreServerDataArchive: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.restoreServerDataArchive, input),
  validateDeploymentConnectivity: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.validateDeploymentConnectivity, input),
  getDesktopServerExposure: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.getDesktopServerExposure),
  setDesktopServerExposureMode: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.setDesktopServerExposureMode, input),
  startCollaborationPresence: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.startCollaborationPresence, input),
  stopCollaborationPresence: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.stopCollaborationPresence),
  startCollaborationCanvasLiveSync: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.startCollaborationCanvasLiveSync, input),
  stopCollaborationCanvasLiveSync: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.stopCollaborationCanvasLiveSync),
  publishCollaborationPresence: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.publishCollaborationPresence, input),
  submitCollaborationCanvasCommand: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.submitCollaborationCanvasCommand, input),
  reconnectCollaborationCanvas: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.reconnectCollaborationCanvas, input),
  bindCollaborationCanvasCommandSession: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.bindCollaborationCanvasCommandSession, input),
  getCollaborationCanvasCommandSession: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.getCollaborationCanvasCommandSession),
  flushCollaborationCanvasReplicaMaterialization: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.flushCollaborationCanvasReplicaMaterialization),
  resolveCollaborationCanvasScope: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.resolveCollaborationCanvasScope, input),
  readCollaborationCanvasRuntimeStatus: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.readCollaborationCanvasRuntimeStatus, input),
  readCollaborationCanvasRuntimeAvailability: async (input) =>
    canvasRuntimeAvailabilitySchema
      .nullable()
      .parse(
        await ipcRenderer.invoke(
          collaborationInvokeChannels.readCollaborationCanvasRuntimeAvailability,
          input
        )
      ),
  getCollaborationCanvasReplicaProjection: async (input) =>
    z
      .union([collaborationCanvasReplicaProjectionSchema, z.null()])
      .parse(
        await ipcRenderer.invoke(
          collaborationInvokeChannels.getCollaborationCanvasReplicaProjection,
          input
        )
      ),
  bindCollaborationContentAuthority: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.bindCollaborationContentAuthority, input),
  getCollaborationContentAuthority: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.getCollaborationContentAuthority),
  refreshCollaborationContentAuthority: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.refreshCollaborationContentAuthority),
  publishCollaborationInitialContent: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.publishCollaborationInitialContent),
  materializeCollaborationContentHead: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.materializeCollaborationContentHead),
  listCollaborationContentBootstrapCandidates: async () =>
    unwrapCollaborationCommandResult(
      await ipcRenderer.invoke(
        collaborationInvokeChannels.listCollaborationContentBootstrapCandidates
      ),
      z.array(collaborationContentBootstrapCandidateSchema)
    ),
  bootstrapCollaborationContent: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.bootstrapCollaborationContent, input),
  getCurrentCanvasAccess: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.getCurrentCanvasAccess, input),
  mutateCurrentCanvasAccess: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.mutateCurrentCanvasAccess, input),
  setCollaborationCurrentSelection: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.setCollaborationCurrentSelection, input),
  clearCollaborationCurrentSelection: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.clearCollaborationCurrentSelection),
  getLocalCollaborationServerStatus: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.getLocalCollaborationServerStatus),
  getLocalCollaborationScopeCatalog: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.getLocalCollaborationScopeCatalog),
  setLocalCollaborationTrustedScopes: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.setLocalCollaborationTrustedScopes, input),
  startLocalCollaborationServer: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.startLocalCollaborationServer),
  stopLocalCollaborationServer: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.stopLocalCollaborationServer),
  setLocalCollaborationLanSharing: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.setLocalCollaborationLanSharing, input),
  listLocalCollaborationTrustedScopes: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.listLocalCollaborationTrustedScopes),
  registerLocalCollaborationCurrentProject: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.registerLocalCollaborationCurrentProject, input),
  listCollaborationMembers: async (input) =>
    unwrapCollaborationCommandResult(
      await ipcRenderer.invoke(collaborationInvokeChannels.listCollaborationMembers, input),
      humanMemberPageSchema
    ),
  updateOwnCollaborationDisplayName: async (input) =>
    unwrapCollaborationCommandResult(
      await ipcRenderer.invoke(
        collaborationInvokeChannels.updateOwnCollaborationDisplayName,
        input
      ),
      humanPrincipalViewSchema
    ),
  listCollaborationDevices: async (input) =>
    unwrapCollaborationCommandResult(
      await ipcRenderer.invoke(collaborationInvokeChannels.listCollaborationDevices, input),
      humanDevicePageSchema
    ),
  listCollaborationInvitations: async (input) =>
    unwrapCollaborationCommandResult(
      await ipcRenderer.invoke(collaborationInvokeChannels.listCollaborationInvitations, input),
      humanInvitationPageSchema
    ),
  createCollaborationInvitation: async (input) =>
    unwrapCollaborationCommandResult(
      await ipcRenderer.invoke(collaborationInvokeChannels.createCollaborationInvitation, input),
      humanCreateInvitationResponseSchema
    ),
  createCollaborationInvitationHandoff: async (input) =>
    unwrapCollaborationCommandResult(
      await ipcRenderer.invoke(
        collaborationInvokeChannels.createCollaborationInvitationHandoff,
        input
      ),
      collaborationInvitationHandoffResponseSchema
    ),
  getCollaborationInvitationSecret: async (input) =>
    unwrapCollaborationCommandResult(
      await ipcRenderer.invoke(collaborationInvokeChannels.getCollaborationInvitationSecret, input),
      humanCreateInvitationResponseSchema
    ),
  getCollaborationInvitationHandoff: async (input) =>
    unwrapCollaborationCommandResult(
      await ipcRenderer.invoke(
        collaborationInvokeChannels.getCollaborationInvitationHandoff,
        input
      ),
      collaborationInvitationHandoffResponseSchema
    ),
  revokeCollaborationInvitation: async (input) =>
    unwrapCollaborationCommandResult(
      await ipcRenderer.invoke(collaborationInvokeChannels.revokeCollaborationInvitation, input),
      humanInvitationViewSchema
    ),
  revokeCollaborationInvitations: async (input) =>
    unwrapCollaborationCommandResult(
      await ipcRenderer.invoke(collaborationInvokeChannels.revokeCollaborationInvitations, input),
      humanRevokeInvitationsResponseSchema
    ),
  removeCollaborationMember: async (input) =>
    unwrapCollaborationCommandResult(
      await ipcRenderer.invoke(collaborationInvokeChannels.removeCollaborationMember, input),
      z.undefined()
    ),
  promoteCollaborationOwner: async (input) =>
    unwrapCollaborationCommandResult(
      await ipcRenderer.invoke(collaborationInvokeChannels.promoteCollaborationOwner, input),
      z.undefined()
    ),
  demoteCollaborationOwner: async (input) =>
    unwrapCollaborationCommandResult(
      await ipcRenderer.invoke(collaborationInvokeChannels.demoteCollaborationOwner, input),
      z.undefined()
    ),
  revokeCollaborationDevice: async (input) =>
    unwrapCollaborationCommandResult(
      await ipcRenderer.invoke(collaborationInvokeChannels.revokeCollaborationDevice, input),
      z.undefined()
    ),
  listCollaborationAssignments: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.listCollaborationAssignments, input),
  getCollaborationAssignment: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.getCollaborationAssignment, input),
  listCollaborationEligibleAssignees: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.listCollaborationEligibleAssignees, input),
  listCollaborationEligibleHostsBatch: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.listCollaborationEligibleHostsBatch, input),
  getCollaborationWorkAuthority: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.getCollaborationWorkAuthority, input),
  updateCollaborationResponsibility: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.updateCollaborationResponsibility, input),
  updateCollaborationReviewer: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.updateCollaborationReviewer, input),
  listCollaborationComments: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.listCollaborationComments, input),
  listCollaborationActivity: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.listCollaborationActivity, input),
  listCollaborationAuthorizedProjects: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.listCollaborationAuthorizedProjects, input),
  listCollaborationAuthorizedCanvases: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.listCollaborationAuthorizedCanvases, input),
  readCollaborationPackageSnapshot: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.readCollaborationPackageSnapshot, input),
  createCollaborationPackageSnapshot: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.createCollaborationPackageSnapshot, input),
  restoreCollaborationPackageSnapshot: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.restoreCollaborationPackageSnapshot, input),
  updateCollaborationAssignment: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.updateCollaborationAssignment, input),
  createCollaborationComment: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.createCollaborationComment, input),
  editCollaborationComment: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.editCollaborationComment, input),
  tombstoneCollaborationComment: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.tombstoneCollaborationComment, input),
  createCollaborationPendingAttachment: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.createCollaborationPendingAttachment, input),
  uploadCollaborationPendingAttachment: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.uploadCollaborationPendingAttachment, input),
  finalizeCollaborationPendingAttachment: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.finalizeCollaborationPendingAttachment, input),
  readCollaborationCommentAttachment: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.readCollaborationCommentAttachment, input),
  listCollaborationAgentEndpoints: async () =>
    ipcRenderer.invoke(collaborationInvokeChannels.listCollaborationAgentEndpoints),
  dispatchCollaborationRemoteOperation: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.dispatchCollaborationRemoteOperation, input),
  observeCollaborationRemoteOperation: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.observeCollaborationRemoteOperation, input),
  executeCollaborationRemoteOperationAction: async (input) =>
    ipcRenderer.invoke(
      collaborationInvokeChannels.executeCollaborationRemoteOperationAction,
      input
    ),
  replayCollaborationRemoteOperationEvents: async (input) =>
    ipcRenderer.invoke(collaborationInvokeChannels.replayCollaborationRemoteOperationEvents, input),
  listCollaborationRemoteOperationInteractions: async (input) =>
    ipcRenderer.invoke(
      collaborationInvokeChannels.listCollaborationRemoteOperationInteractions,
      input
    ),
  settleCollaborationRemoteOperationInteraction: async (input) =>
    ipcRenderer.invoke(
      collaborationInvokeChannels.settleCollaborationRemoteOperationInteraction,
      input
    ),
  onCollaborationStatusChanged: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: CollaborationStatus) => callback(payload);
    ipcRenderer.on(collaborationStatusChangedChannel, listener);
    return () => ipcRenderer.off(collaborationStatusChangedChannel, listener);
  },
  onCollaborationObserverSignal: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: CollaborationObserverSignal) =>
      callback(payload);
    ipcRenderer.on(collaborationObserverSignalChannel, listener);
    return () => ipcRenderer.off(collaborationObserverSignalChannel, listener);
  },
  onCollaborationPresenceSignal: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: CollaborationPresenceSignal) =>
      callback(payload);
    ipcRenderer.on(collaborationPresenceSignalChannel, listener);
    return () => ipcRenderer.off(collaborationPresenceSignalChannel, listener);
  },
  onCollaborationCanvasLiveSyncSignal: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: CollaborationCanvasLiveSyncSignal) =>
      callback(payload);
    ipcRenderer.on(collaborationCanvasLiveSyncSignalChannel, listener);
    return () => ipcRenderer.off(collaborationCanvasLiveSyncSignalChannel, listener);
  },
  onCollaborationCanvasReplicaSignal: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: unknown) =>
      callback(collaborationCanvasReplicaSignalSchema.parse(payload));
    ipcRenderer.on(collaborationCanvasReplicaSignalChannel, listener);
    return () => ipcRenderer.off(collaborationCanvasReplicaSignalChannel, listener);
  }
};

contextBridge.exposeInMainWorld("planweaveCollaboration", collaborationApi);

const operatorControlApi: PlanWeaveOperatorControlApi = {
  getOperatorControlStatus: async () => ipcRenderer.invoke(operatorControlInvokeChannels.getStatus),
  upsertOperatorProfile: async (input) =>
    ipcRenderer.invoke(operatorControlInvokeChannels.upsertProfile, input),
  removeOperatorProfile: async (input) =>
    ipcRenderer.invoke(operatorControlInvokeChannels.removeProfile, input),
  setActiveOperatorProfile: async (input) =>
    ipcRenderer.invoke(operatorControlInvokeChannels.setActiveProfile, input),
  clearActiveOperatorProfile: async () =>
    ipcRenderer.invoke(operatorControlInvokeChannels.clearActiveProfile),
  importOperatorCredential: async (input) =>
    ipcRenderer.invoke(operatorControlInvokeChannels.importCredential, input),
  clearOperatorCredential: async (input) =>
    ipcRenderer.invoke(operatorControlInvokeChannels.clearCredential, input),
  listOperatorHosts: async (input) =>
    ipcRenderer.invoke(operatorControlInvokeChannels.listHosts, input),
  listOperatorAgentEndpoints: async (input) =>
    ipcRenderer.invoke(operatorControlInvokeChannels.listAgentEndpoints, input),
  copyOperatorHostBootstrapHandoff: async (input) =>
    ipcRenderer.invoke(operatorControlInvokeChannels.copyHostBootstrapHandoff, input),
  copyOperatorMemberSetupCode: async (input) =>
    ipcRenderer.invoke(operatorControlInvokeChannels.copyMemberSetupCode, input),
  revokeOperatorHost: async (input) =>
    ipcRenderer.invoke(operatorControlInvokeChannels.revokeHost, input),
  renewOperatorHostCredential: async (input) =>
    ipcRenderer.invoke(operatorControlInvokeChannels.renewHostCredential, input),
  getOperatorLocalAgentHostStatus: async (input) =>
    ipcRenderer.invoke(operatorControlInvokeChannels.getLocalAgentHostStatus, input),
  repairOperatorLocalAgentHost: async (input) =>
    ipcRenderer.invoke(operatorControlInvokeChannels.repairLocalAgentHost, input),
  registerOperatorLocalAgentHost: async (input) =>
    ipcRenderer.invoke(operatorControlInvokeChannels.registerLocalAgentHost, input),
  enrollOperatorLocalAgentHost: async (input) =>
    ipcRenderer.invoke(operatorControlInvokeChannels.enrollLocalAgentHost, input),
  dispatchOwnerFleetRemoteOperation: async (input) =>
    ipcRenderer.invoke(operatorControlInvokeChannels.dispatchOwnerFleetRemoteOperation, input),
  observeOwnerFleetRemoteOperation: async (input) =>
    ipcRenderer.invoke(operatorControlInvokeChannels.observeOwnerFleetRemoteOperation, input),
  replayOwnerFleetRemoteOperationEvents: async (input) =>
    ipcRenderer.invoke(operatorControlInvokeChannels.replayOwnerFleetRemoteOperationEvents, input),
  executeOwnerFleetRemoteOperationAction: async (input) =>
    ipcRenderer.invoke(operatorControlInvokeChannels.executeOwnerFleetRemoteOperationAction, input),
  onOperatorControlStatusChanged: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: OperatorControlStatus) =>
      callback(payload);
    ipcRenderer.on(operatorControlStatusChangedChannel, listener);
    return () => ipcRenderer.off(operatorControlStatusChangedChannel, listener);
  }
};

contextBridge.exposeInMainWorld("planweaveOperatorControl", operatorControlApi);

if (process.env.PLANWEAVE_DESKTOP_SMOKE === "1") {
  contextBridge.exposeInMainWorld("planweaveSmoke", {
    clearLastRevealPath: () => {
      lastSmokeRevealPath = null;
    },
    getLastRevealPath: () => lastSmokeRevealPath
  });
}
