import { invokeDesktopCommand } from "./invokeDesktopCommand.js";
import { contextBridge, ipcRenderer } from "electron";
import { exposeCollaborationCapture } from "./collaborationCapture.js";
import type { IpcRendererEvent } from "electron";
import { z } from "zod";
import {
  workspaceConnectionSelfViewSchema,
  workspaceConnectionMembersPageSchema
} from "@planweave-ai/collaboration-protocol/connection";
import { canvasRuntimeAvailabilitySchema } from "@planweave-ai/collaboration-protocol/canvas/runtime-availability";
import {
  canvasRuntimeInitializeOutcomeSchema,
  canvasRuntimeResetOutcomeSchema
} from "@planweave-ai/collaboration-protocol/canvas/runtime-control";
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
  type CollaborationObserverSignal,
  type CollaborationOperationDiagnostics,
  type CollaborationPresenceSignal,
  type CollaborationStatus,
  type PlanWeaveCollaborationApi
} from "../shared/collaboration.js";
import { collaborationOperationDiagnosticsSchema } from "../shared/collaborationOperationDiagnostics.js";
import {
  workspaceCanvasDownloadInputSchema,
  workspaceCanvasDownloadResultSchema,
  workspaceCanvasPublishInputSchema,
  workspaceCanvasPublishResultSchema,
  workspaceCanvasSharingCandidateSchema
} from "../shared/workspaceCanvasSharing.js";
import {
  workspaceCanvasProjectionSchema,
  workspaceCanvasProjectionSignalSchema
} from "../shared/workspaceCanvasProjection.js";
import {
  collaborationInvokeChannels,
  collaborationObserverSignalChannel,
  collaborationOperationDiagnosticsChangedChannel,
  workspaceCanvasProjectionSignalChannel,
  collaborationPresenceSignalChannel,
  collaborationStatusChangedChannel
} from "../shared/collaborationIpc.js";
import {
  workspaceCanvasRuntimeInitializeInputSchema,
  workspaceCanvasRuntimeResetInputSchema
} from "../shared/collaborationRuntimeAvailability.js";
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
import { createWorkspaceExecutionPreloadApi } from "./workspaceExecutionPreloadBridge.js";

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

const workspaceExecutionApi = createWorkspaceExecutionPreloadApi((channel, input) =>
  ipcRenderer.invoke(channel, input)
);

contextBridge.exposeInMainWorld("planweaveWorkspaceExecution", workspaceExecutionApi);

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
    invokeDesktopCommand(collaborationInvokeChannels.getCollaborationStatus),
  getCollaborationOperationDiagnostics: async () =>
    collaborationOperationDiagnosticsSchema.parse(
      await invokeDesktopCommand(collaborationInvokeChannels.getCollaborationOperationDiagnostics)
    ),
  upsertCollaborationProfile: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.upsertCollaborationProfile, input),
  removeCollaborationProfile: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.removeCollaborationProfile, input),
  setActiveCollaborationProfile: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.setActiveCollaborationProfile, input),
  clearActiveCollaborationProfile: async () =>
    invokeDesktopCommand(collaborationInvokeChannels.clearActiveCollaborationProfile),
  importDeviceCredential: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.importDeviceCredential, input),
  clearDeviceCredential: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.clearDeviceCredential, input),
  bootstrapCollaborationOwner: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.bootstrapCollaborationOwner, input),
  consumeCollaborationInvitation: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.consumeCollaborationInvitation, input),
  connectCollaborationSession: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.connectCollaborationSession, input),
  disconnectCollaborationSession: async () =>
    invokeDesktopCommand(collaborationInvokeChannels.disconnectCollaborationSession),
  redeemCollaborationSetupCode: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.redeemCollaborationSetupCode, input),
  recoverCollaborationIdentities: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.recoverCollaborationIdentities, input),
  confirmCollaborationIdentityMerge: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.confirmCollaborationIdentityMerge, input),
  connectExistingServerByOrigin: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.connectExistingServerByOrigin, input),
  getActiveWorkspaceConnection: async () =>
    invokeDesktopCommand(collaborationInvokeChannels.getActiveWorkspaceConnection),
  listRememberedServerConnections: async () =>
    invokeDesktopCommand(collaborationInvokeChannels.listRememberedServerConnections),
  forgetRememberedServerConnection: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.forgetRememberedServerConnection, input),
  listWorkspacePicker: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.listWorkspacePicker, input),
  getWorkspaceConnectionSelf: async () =>
    unwrapCollaborationCommandResult(
      await invokeDesktopCommand(collaborationInvokeChannels.getWorkspaceConnectionSelf),
      workspaceConnectionSelfViewSchema
    ),
  updateWorkspaceConnectionSelf: async (input) =>
    unwrapCollaborationCommandResult(
      await invokeDesktopCommand(collaborationInvokeChannels.updateWorkspaceConnectionSelf, input),
      workspaceConnectionSelfViewSchema
    ),
  listWorkspaceConnectionMembers: async (input) =>
    unwrapCollaborationCommandResult(
      await invokeDesktopCommand(collaborationInvokeChannels.listWorkspaceConnectionMembers, input),
      workspaceConnectionMembersPageSchema
    ),
  selectWorkspaceConnection: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.selectWorkspaceConnection, input),
  connectWorkspaceConnection: async () =>
    invokeDesktopCommand(collaborationInvokeChannels.connectWorkspaceConnection),
  disconnectWorkspaceConnection: async () =>
    invokeDesktopCommand(collaborationInvokeChannels.disconnectWorkspaceConnection),
  retryWorkspaceConnection: async () =>
    invokeDesktopCommand(collaborationInvokeChannels.retryWorkspaceConnection),
  getDeploymentGuidance: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.getDeploymentGuidance, input),
  copyDeploymentComposeHandoff: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.copyDeploymentComposeHandoff, input),
  exportDeploymentComposeBundle: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.exportDeploymentComposeBundle, input),
  listServerDataExportSources: async () =>
    invokeDesktopCommand(collaborationInvokeChannels.listServerDataExportSources),
  exportServerDataArchive: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.exportServerDataArchive, input),
  restoreServerDataArchive: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.restoreServerDataArchive, input),
  validateDeploymentConnectivity: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.validateDeploymentConnectivity, input),
  getDesktopServerExposure: async () =>
    invokeDesktopCommand(collaborationInvokeChannels.getDesktopServerExposure),
  setDesktopServerExposureMode: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.setDesktopServerExposureMode, input),
  startCollaborationPresence: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.startCollaborationPresence, input),
  stopCollaborationPresence: async () =>
    invokeDesktopCommand(collaborationInvokeChannels.stopCollaborationPresence),
  publishCollaborationPresence: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.publishCollaborationPresence, input),
  openWorkspaceCanvasSession: async (input) =>
    workspaceCanvasProjectionSchema.parse(
      await invokeDesktopCommand(collaborationInvokeChannels.openWorkspaceCanvasSession, input)
    ),
  submitWorkspaceCanvasCommand: async (input) =>
    workspaceCanvasProjectionSchema.parse(
      await invokeDesktopCommand(collaborationInvokeChannels.submitWorkspaceCanvasCommand, input)
    ),
  reconnectWorkspaceCanvasSession: async (input) =>
    workspaceCanvasProjectionSchema.parse(
      await invokeDesktopCommand(collaborationInvokeChannels.reconnectWorkspaceCanvasSession, input)
    ),
  closeWorkspaceCanvasSession: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.closeWorkspaceCanvasSession, input),
  getWorkspaceCanvasProjection: async () =>
    workspaceCanvasProjectionSchema
      .nullable()
      .parse(await invokeDesktopCommand(collaborationInvokeChannels.getWorkspaceCanvasProjection)),
  readCollaborationCanvasBindingRuntimeAvailability: async (input) => {
    if (input.kind !== "remote") throw new Error("workspace_canvas_remote_binding_required");
    return canvasRuntimeAvailabilitySchema
      .nullable()
      .parse(
        await invokeDesktopCommand(
          collaborationInvokeChannels.readCollaborationCanvasBindingRuntimeAvailability,
          input
        )
      );
  },
  initializeWorkspaceCanvasRuntime: async (input) =>
    canvasRuntimeInitializeOutcomeSchema.parse(
      await invokeDesktopCommand(
        collaborationInvokeChannels.initializeWorkspaceCanvasRuntime,
        workspaceCanvasRuntimeInitializeInputSchema.parse(input)
      )
    ),
  resetWorkspaceCanvasRuntime: async (input) =>
    canvasRuntimeResetOutcomeSchema.parse(
      await invokeDesktopCommand(
        collaborationInvokeChannels.resetWorkspaceCanvasRuntime,
        workspaceCanvasRuntimeResetInputSchema.parse(input)
      )
    ),
  listWorkspaceCanvasSharingCandidates: async () =>
    unwrapCollaborationCommandResult(
      await invokeDesktopCommand(collaborationInvokeChannels.listWorkspaceCanvasSharingCandidates),
      z.array(workspaceCanvasSharingCandidateSchema)
    ),
  publishWorkspaceCanvas: async (input) =>
    unwrapCollaborationCommandResult(
      await invokeDesktopCommand(
        collaborationInvokeChannels.publishWorkspaceCanvas,
        workspaceCanvasPublishInputSchema.parse(input)
      ),
      workspaceCanvasPublishResultSchema
    ),
  downloadWorkspaceCanvasFork: async (input) =>
    unwrapCollaborationCommandResult(
      await invokeDesktopCommand(
        collaborationInvokeChannels.downloadWorkspaceCanvasFork,
        workspaceCanvasDownloadInputSchema.parse(input)
      ),
      workspaceCanvasDownloadResultSchema
    ),
  getCurrentCanvasAccess: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.getCurrentCanvasAccess, input),
  mutateCurrentCanvasAccess: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.mutateCurrentCanvasAccess, input),
  getLocalCollaborationServerStatus: async () =>
    invokeDesktopCommand(collaborationInvokeChannels.getLocalCollaborationServerStatus),
  getLocalCollaborationScopeCatalog: async () =>
    invokeDesktopCommand(collaborationInvokeChannels.getLocalCollaborationScopeCatalog),
  setLocalCollaborationTrustedScopes: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.setLocalCollaborationTrustedScopes, input),
  startLocalCollaborationServer: async () =>
    invokeDesktopCommand(collaborationInvokeChannels.startLocalCollaborationServer),
  stopLocalCollaborationServer: async () =>
    invokeDesktopCommand(collaborationInvokeChannels.stopLocalCollaborationServer),
  setLocalCollaborationLanSharing: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.setLocalCollaborationLanSharing, input),
  listLocalCollaborationTrustedScopes: async () =>
    invokeDesktopCommand(collaborationInvokeChannels.listLocalCollaborationTrustedScopes),
  registerLocalCollaborationCurrentProject: async (input) =>
    invokeDesktopCommand(
      collaborationInvokeChannels.registerLocalCollaborationCurrentProject,
      input
    ),
  listCollaborationMembers: async (input) =>
    unwrapCollaborationCommandResult(
      await invokeDesktopCommand(collaborationInvokeChannels.listCollaborationMembers, input),
      humanMemberPageSchema
    ),
  updateOwnCollaborationDisplayName: async (input) =>
    unwrapCollaborationCommandResult(
      await invokeDesktopCommand(
        collaborationInvokeChannels.updateOwnCollaborationDisplayName,
        input
      ),
      humanPrincipalViewSchema
    ),
  listCollaborationDevices: async (input) =>
    unwrapCollaborationCommandResult(
      await invokeDesktopCommand(collaborationInvokeChannels.listCollaborationDevices, input),
      humanDevicePageSchema
    ),
  listCollaborationInvitations: async (input) =>
    unwrapCollaborationCommandResult(
      await invokeDesktopCommand(collaborationInvokeChannels.listCollaborationInvitations, input),
      humanInvitationPageSchema
    ),
  createCollaborationInvitation: async (input) =>
    unwrapCollaborationCommandResult(
      await invokeDesktopCommand(collaborationInvokeChannels.createCollaborationInvitation, input),
      humanCreateInvitationResponseSchema
    ),
  createCollaborationInvitationHandoff: async (input) =>
    unwrapCollaborationCommandResult(
      await invokeDesktopCommand(
        collaborationInvokeChannels.createCollaborationInvitationHandoff,
        input
      ),
      collaborationInvitationHandoffResponseSchema
    ),
  getCollaborationInvitationSecret: async (input) =>
    unwrapCollaborationCommandResult(
      await invokeDesktopCommand(
        collaborationInvokeChannels.getCollaborationInvitationSecret,
        input
      ),
      humanCreateInvitationResponseSchema
    ),
  getCollaborationInvitationHandoff: async (input) =>
    unwrapCollaborationCommandResult(
      await invokeDesktopCommand(
        collaborationInvokeChannels.getCollaborationInvitationHandoff,
        input
      ),
      collaborationInvitationHandoffResponseSchema
    ),
  revokeCollaborationInvitation: async (input) =>
    unwrapCollaborationCommandResult(
      await invokeDesktopCommand(collaborationInvokeChannels.revokeCollaborationInvitation, input),
      humanInvitationViewSchema
    ),
  revokeCollaborationInvitations: async (input) =>
    unwrapCollaborationCommandResult(
      await invokeDesktopCommand(collaborationInvokeChannels.revokeCollaborationInvitations, input),
      humanRevokeInvitationsResponseSchema
    ),
  removeCollaborationMember: async (input) =>
    unwrapCollaborationCommandResult(
      await invokeDesktopCommand(collaborationInvokeChannels.removeCollaborationMember, input),
      z.undefined()
    ),
  promoteCollaborationOwner: async (input) =>
    unwrapCollaborationCommandResult(
      await invokeDesktopCommand(collaborationInvokeChannels.promoteCollaborationOwner, input),
      z.undefined()
    ),
  demoteCollaborationOwner: async (input) =>
    unwrapCollaborationCommandResult(
      await invokeDesktopCommand(collaborationInvokeChannels.demoteCollaborationOwner, input),
      z.undefined()
    ),
  revokeCollaborationDevice: async (input) =>
    unwrapCollaborationCommandResult(
      await invokeDesktopCommand(collaborationInvokeChannels.revokeCollaborationDevice, input),
      z.undefined()
    ),
  listCollaborationAssignments: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.listCollaborationAssignments, input),
  getCollaborationAssignment: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.getCollaborationAssignment, input),
  listCollaborationEligibleAssignees: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.listCollaborationEligibleAssignees, input),
  listCollaborationEligibleHostsBatch: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.listCollaborationEligibleHostsBatch, input),
  getCollaborationWorkAuthority: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.getCollaborationWorkAuthority, input),
  updateCollaborationResponsibility: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.updateCollaborationResponsibility, input),
  updateCollaborationReviewer: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.updateCollaborationReviewer, input),
  listCollaborationComments: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.listCollaborationComments, input),
  listCollaborationActivity: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.listCollaborationActivity, input),
  listCollaborationAuthorizedProjects: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.listCollaborationAuthorizedProjects, input),
  listCollaborationAuthorizedCanvases: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.listCollaborationAuthorizedCanvases, input),
  readCollaborationPackageSnapshot: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.readCollaborationPackageSnapshot, input),
  createCollaborationPackageSnapshot: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.createCollaborationPackageSnapshot, input),
  restoreCollaborationPackageSnapshot: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.restoreCollaborationPackageSnapshot, input),
  updateCollaborationAssignment: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.updateCollaborationAssignment, input),
  createCollaborationComment: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.createCollaborationComment, input),
  editCollaborationComment: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.editCollaborationComment, input),
  tombstoneCollaborationComment: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.tombstoneCollaborationComment, input),
  createCollaborationPendingAttachment: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.createCollaborationPendingAttachment, input),
  uploadCollaborationPendingAttachment: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.uploadCollaborationPendingAttachment, input),
  finalizeCollaborationPendingAttachment: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.finalizeCollaborationPendingAttachment, input),
  readCollaborationCommentAttachment: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.readCollaborationCommentAttachment, input),
  listCollaborationAgentEndpoints: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.listCollaborationAgentEndpoints, input),
  observeCollaborationRemoteOperation: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.observeCollaborationRemoteOperation, input),
  lookupCollaborationRemoteOperation: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.lookupCollaborationRemoteOperation, input),
  lookupWorkspaceRemoteOperation: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.lookupWorkspaceRemoteOperation, input),
  observeWorkspaceRemoteOperation: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.observeWorkspaceRemoteOperation, input),
  replayCollaborationRemoteOperationEvents: async (input) =>
    invokeDesktopCommand(
      collaborationInvokeChannels.replayCollaborationRemoteOperationEvents,
      input
    ),
  replayWorkspaceRemoteOperationEvents: async (input) =>
    invokeDesktopCommand(collaborationInvokeChannels.replayWorkspaceRemoteOperationEvents, input),
  onCollaborationStatusChanged: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: CollaborationStatus) => callback(payload);
    ipcRenderer.on(collaborationStatusChangedChannel, listener);
    return () => ipcRenderer.off(collaborationStatusChangedChannel, listener);
  },
  onCollaborationOperationDiagnosticsChanged: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: CollaborationOperationDiagnostics) =>
      callback(collaborationOperationDiagnosticsSchema.parse(payload));
    ipcRenderer.on(collaborationOperationDiagnosticsChangedChannel, listener);
    return () => ipcRenderer.off(collaborationOperationDiagnosticsChangedChannel, listener);
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
  onWorkspaceCanvasProjectionSignal: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: unknown) =>
      callback(workspaceCanvasProjectionSignalSchema.parse(payload));
    ipcRenderer.on(workspaceCanvasProjectionSignalChannel, listener);
    return () => ipcRenderer.off(workspaceCanvasProjectionSignalChannel, listener);
  }
};

contextBridge.exposeInMainWorld("planweaveCollaboration", collaborationApi);
exposeCollaborationCapture();

const operatorControlApi: PlanWeaveOperatorControlApi = {
  getOperatorControlStatus: async () =>
    invokeDesktopCommand(operatorControlInvokeChannels.getStatus),
  upsertOperatorProfile: async (input) =>
    invokeDesktopCommand(operatorControlInvokeChannels.upsertProfile, input),
  removeOperatorProfile: async (input) =>
    invokeDesktopCommand(operatorControlInvokeChannels.removeProfile, input),
  setActiveOperatorProfile: async (input) =>
    invokeDesktopCommand(operatorControlInvokeChannels.setActiveProfile, input),
  clearActiveOperatorProfile: async () =>
    invokeDesktopCommand(operatorControlInvokeChannels.clearActiveProfile),
  importOperatorCredential: async (input) =>
    invokeDesktopCommand(operatorControlInvokeChannels.importCredential, input),
  clearOperatorCredential: async (input) =>
    invokeDesktopCommand(operatorControlInvokeChannels.clearCredential, input),
  listOperatorHosts: async (input) =>
    invokeDesktopCommand(operatorControlInvokeChannels.listHosts, input),
  listOperatorAgentEndpoints: async (input) =>
    invokeDesktopCommand(operatorControlInvokeChannels.listAgentEndpoints, input),
  copyOperatorHostBootstrapHandoff: async (input) =>
    invokeDesktopCommand(operatorControlInvokeChannels.copyHostBootstrapHandoff, input),
  copyOperatorMemberSetupCode: async (input) =>
    invokeDesktopCommand(operatorControlInvokeChannels.copyMemberSetupCode, input),
  revokeOperatorHost: async (input) =>
    invokeDesktopCommand(operatorControlInvokeChannels.revokeHost, input),
  renewOperatorHostCredential: async (input) =>
    invokeDesktopCommand(operatorControlInvokeChannels.renewHostCredential, input),
  getOperatorLocalAgentHostStatus: async (input) =>
    invokeDesktopCommand(operatorControlInvokeChannels.getLocalAgentHostStatus, input),
  repairOperatorLocalAgentHost: async (input) =>
    invokeDesktopCommand(operatorControlInvokeChannels.repairLocalAgentHost, input),
  registerOperatorLocalAgentHost: async (input) =>
    invokeDesktopCommand(operatorControlInvokeChannels.registerLocalAgentHost, input),
  enrollOperatorLocalAgentHost: async (input) =>
    invokeDesktopCommand(operatorControlInvokeChannels.enrollLocalAgentHost, input),
  observeOwnerFleetRemoteOperation: async (input) =>
    invokeDesktopCommand(operatorControlInvokeChannels.observeOwnerFleetRemoteOperation, input),
  replayOwnerFleetRemoteOperationEvents: async (input) =>
    invokeDesktopCommand(
      operatorControlInvokeChannels.replayOwnerFleetRemoteOperationEvents,
      input
    ),
  listOperatorRemoteAgents: async (input) =>
    invokeDesktopCommand(operatorControlInvokeChannels.listRemoteAgents, input),
  setOperatorRemoteAgentAccessMode: async (input) =>
    invokeDesktopCommand(operatorControlInvokeChannels.setRemoteAgentAccessMode, input),
  grantOperatorRemoteAgentWorkspace: async (input) =>
    invokeDesktopCommand(operatorControlInvokeChannels.grantRemoteAgentWorkspace, input),
  revokeOperatorRemoteAgentGrant: async (input) =>
    invokeDesktopCommand(operatorControlInvokeChannels.revokeRemoteAgentGrant, input),
  revokeOperatorRemoteAgent: async (input) =>
    invokeDesktopCommand(operatorControlInvokeChannels.revokeRemoteAgent, input),
  repairOperatorRemoteAgentOwnership: async (input) =>
    invokeDesktopCommand(operatorControlInvokeChannels.repairRemoteAgentOwnership, input),
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
