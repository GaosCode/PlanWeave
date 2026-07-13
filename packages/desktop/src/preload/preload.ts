import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type {
  DesktopAutoRunEvent,
  DesktopBridgeApi,
  DesktopPackageFileChangeEvent,
  DesktopRuntimeStateChangeEvent
} from "@planweave-ai/runtime";
import type { AppUpdateState, PlanWeaveAppUpdateApi } from "../shared/appUpdate.js";
import { appUpdateChangedChannel, appUpdateInvokeChannels } from "../shared/appUpdate.js";
import type { PlanWeaveDesktopSettingsApi } from "../shared/desktopSettings.js";
import { desktopSettingsInvokeChannels } from "../shared/desktopSettings.js";
import { autoRunChangedChannel, packageFileChangedChannel, runtimeStateChangedChannel } from "../shared/ipcChannels.js";
import type { McpTunnelStatus, PlanWeaveMcpTunnelApi } from "../shared/mcpTunnel.js";
import { mcpTunnelChangedChannel, mcpTunnelInvokeChannels } from "../shared/mcpTunnel.js";
import { windowAppearanceInvokeChannels, type PlanWeaveWindowApi } from "../shared/windowAppearance.js";
import { remoteCollaborationInvokeChannels, remoteConnectChannel, remoteEventChannel, type PlanWeaveRemoteApi } from "../shared/remoteTypes.js";
import { gitIntegrationInvokeChannels, type PlanWeaveGitIntegrationApi } from "../shared/gitIntegration.js";
import { createDesktopBridgeInvokeApi } from "./bridgeInvocation.js";

const invokeApi = createDesktopBridgeInvokeApi((channel, ...args) => ipcRenderer.invoke(channel, ...args));
let lastSmokeRevealPath: string | null = null;

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
    const listener = (_event: IpcRendererEvent, payload: DesktopPackageFileChangeEvent) => callback(payload);
    ipcRenderer.on(packageFileChangedChannel, listener);
    return () => ipcRenderer.off(packageFileChangedChannel, listener);
  },
  onRuntimeStateChanged: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: DesktopRuntimeStateChangeEvent) => callback(payload);
    ipcRenderer.on(runtimeStateChangedChannel, listener);
    return () => ipcRenderer.off(runtimeStateChangedChannel, listener);
  },
  onAutoRunChanged: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: DesktopAutoRunEvent) => callback(payload);
    ipcRenderer.on(autoRunChangedChannel, listener);
    return () => ipcRenderer.off(autoRunChangedChannel, listener);
  }
};

contextBridge.exposeInMainWorld("planweave", api);

const desktopSettingsApi: PlanWeaveDesktopSettingsApi = {
  getDesktopSettings: async () => ipcRenderer.invoke(desktopSettingsInvokeChannels.getDesktopSettings),
  saveDesktopSettings: async (patch) => ipcRenderer.invoke(desktopSettingsInvokeChannels.saveDesktopSettings, patch),
  migrateLegacyDesktopSettings: async (payload) => ipcRenderer.invoke(desktopSettingsInvokeChannels.migrateLegacyDesktopSettings, payload)
};

contextBridge.exposeInMainWorld("planweaveDesktopSettings", desktopSettingsApi);

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
  downloadTunnelClient: async () => ipcRenderer.invoke(mcpTunnelInvokeChannels.downloadTunnelClient),
  setTunnelClientPath: async (path) => ipcRenderer.invoke(mcpTunnelInvokeChannels.setTunnelClientPath, path),
  setTunnelAutoStart: async (enabled) => ipcRenderer.invoke(mcpTunnelInvokeChannels.setTunnelAutoStart, enabled),
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

const remoteApi: PlanWeaveRemoteApi = {
  createRemoteProfile: async (input) => ipcRenderer.invoke(remoteCollaborationInvokeChannels.createRemoteProfile, input),
  startLocalTeamHost: async (input) => ipcRenderer.invoke(remoteCollaborationInvokeChannels.startLocalTeamHost, input),
  updateRemoteProfile: async (id, input) => ipcRenderer.invoke(remoteCollaborationInvokeChannels.updateRemoteProfile, id, input),
  deleteRemoteProfile: async (id) => ipcRenderer.invoke(remoteCollaborationInvokeChannels.deleteRemoteProfile, id),
  getRemoteProfile: async (id) => ipcRenderer.invoke(remoteCollaborationInvokeChannels.getRemoteProfile, id),
  listRemoteProfiles: async () => ipcRenderer.invoke(remoteCollaborationInvokeChannels.listRemoteProfiles),
  connectProfile: async (profileId, projectId) => ipcRenderer.invoke(remoteCollaborationInvokeChannels.connectProfile, profileId, projectId),
  disconnectProfile: async (profileId) => ipcRenderer.invoke(remoteCollaborationInvokeChannels.disconnectProfile, profileId),
  getRemoteConnectionStatus: async (profileId) => ipcRenderer.invoke(remoteCollaborationInvokeChannels.getRemoteConnectionStatus, profileId),
  getRemoteProjectSnapshot: async (profileId, projectId) => ipcRenderer.invoke(remoteCollaborationInvokeChannels.getRemoteProjectSnapshot, profileId, projectId),
  getRemotePlanningRooms: async (profileId, projectId) => ipcRenderer.invoke(remoteCollaborationInvokeChannels.getRemotePlanningRooms, profileId, projectId),
  getRemoteMessages: async (profileId, projectId, roomId) => ipcRenderer.invoke(remoteCollaborationInvokeChannels.getRemoteMessages, profileId, projectId, roomId),
  sendRemoteMessage: async (profileId, projectId, roomId, body) => ipcRenderer.invoke(remoteCollaborationInvokeChannels.sendRemoteMessage, profileId, projectId, roomId, body),
  getRemoteProposals: async (profileId, projectId) => ipcRenderer.invoke(remoteCollaborationInvokeChannels.getRemoteProposals, profileId, projectId),
  approveRemoteProposal: async (profileId, projectId, proposalId, decision, reason) => ipcRenderer.invoke(remoteCollaborationInvokeChannels.approveRemoteProposal, profileId, projectId, proposalId, decision, reason),
  getRemoteMembers: async (profileId, projectId) => ipcRenderer.invoke(remoteCollaborationInvokeChannels.getRemoteMembers, profileId, projectId),
  getRemoteTasks: async (profileId, projectId) => ipcRenderer.invoke(remoteCollaborationInvokeChannels.getRemoteTasks, profileId, projectId),
  claimRemoteTask: async (profileId, projectId, taskId, branchName, baseCommit) => ipcRenderer.invoke(remoteCollaborationInvokeChannels.claimRemoteTask, profileId, projectId, taskId, branchName, baseCommit),
  getRemoteMergeStatus: async (profileId, projectId) => ipcRenderer.invoke(remoteCollaborationInvokeChannels.getRemoteMergeStatus, profileId, projectId),
  getRemoteCoordination: async (profileId, projectId) => ipcRenderer.invoke(remoteCollaborationInvokeChannels.getRemoteCoordination, profileId, projectId),
  createRemoteBaseline: async (profileId, projectId, input) => ipcRenderer.invoke(remoteCollaborationInvokeChannels.createRemoteBaseline, profileId, projectId, input),
  decideRemoteBaseline: async (profileId, projectId, baselineId, decision, reason) => ipcRenderer.invoke(remoteCollaborationInvokeChannels.decideRemoteBaseline, profileId, projectId, baselineId, decision, reason),
  freezeRemoteBaseline: async (profileId, projectId, baselineId) => ipcRenderer.invoke(remoteCollaborationInvokeChannels.freezeRemoteBaseline, profileId, projectId, baselineId),
  uploadRemoteAttachment: async (profileId, projectId, filePath) => ipcRenderer.invoke(remoteCollaborationInvokeChannels.uploadRemoteAttachment, profileId, projectId, filePath),
  registerRemoteAgent: async (profileId, projectId) => ipcRenderer.invoke(remoteCollaborationInvokeChannels.registerRemoteAgent, profileId, projectId),
  preferRemoteTask: async (profileId, projectId, taskId, note) => ipcRenderer.invoke(remoteCollaborationInvokeChannels.preferRemoteTask, profileId, projectId, taskId, note),
  getRemoteAssignments: async (profileId, projectId) => ipcRenderer.invoke(remoteCollaborationInvokeChannels.getRemoteAssignments, profileId, projectId),
  heartbeatRemoteAssignment: async (profileId, projectId, assignmentId, expectedVersion) => ipcRenderer.invoke(remoteCollaborationInvokeChannels.heartbeatRemoteAssignment, profileId, projectId, assignmentId, expectedVersion),
  validateRemoteAssignmentLocally: async (profileId, projectId, assignmentId, repositoryPath) => ipcRenderer.invoke(remoteCollaborationInvokeChannels.validateRemoteAssignmentLocally, profileId, projectId, assignmentId, repositoryPath),
  submitRemoteAssignment: async (profileId, projectId, assignmentId, repositoryPath, validation) => ipcRenderer.invoke(remoteCollaborationInvokeChannels.submitRemoteAssignment, profileId, projectId, assignmentId, repositoryPath, validation),
  getRemoteMergeQueue: async (profileId, projectId) => ipcRenderer.invoke(remoteCollaborationInvokeChannels.getRemoteMergeQueue, profileId, projectId),
  reviewRemoteMerge: async (profileId, projectId, entryId, decision, repositoryPath) => ipcRenderer.invoke(remoteCollaborationInvokeChannels.reviewRemoteMerge, profileId, projectId, entryId, decision, repositoryPath),
  generateRemoteBaseline: async (profileId, projectId, repositoryPath) => ipcRenderer.invoke(remoteCollaborationInvokeChannels.generateRemoteBaseline, profileId, projectId, repositoryPath),
  generateRemoteTasks: async (profileId, projectId, repositoryPath) => ipcRenderer.invoke(remoteCollaborationInvokeChannels.generateRemoteTasks, profileId, projectId, repositoryPath),
  onRemoteEvent: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: Parameters<typeof callback>[0]) => callback(payload)
    ipcRenderer.on(remoteEventChannel, listener)
    return () => ipcRenderer.off(remoteEventChannel, listener)
  },
  onRemoteConnect: (callback) => {
    const listener = (_event: IpcRendererEvent, payload: Parameters<typeof callback>[0]) => callback(payload)
    ipcRenderer.on(remoteConnectChannel, listener)
    return () => ipcRenderer.off(remoteConnectChannel, listener)
  }
}

contextBridge.exposeInMainWorld("planweaveRemote", remoteApi);

const gitIntegrationApi: PlanWeaveGitIntegrationApi = {
  getGitStatus: async (projectId) => ipcRenderer.invoke(gitIntegrationInvokeChannels.getGitStatus, projectId),
  getGitHubAuthStatus: async () => ipcRenderer.invoke(gitIntegrationInvokeChannels.getGitHubAuthStatus),
  gitHubLogin: async (token) => ipcRenderer.invoke(gitIntegrationInvokeChannels.gitHubLogin, token),
  gitHubLogout: async () => ipcRenderer.invoke(gitIntegrationInvokeChannels.gitHubLogout)
};

contextBridge.exposeInMainWorld("planweaveGitIntegration", gitIntegrationApi);

if (process.env.PLANWEAVE_DESKTOP_SMOKE === "1") {
  contextBridge.exposeInMainWorld("planweaveSmoke", {
    clearLastRevealPath: () => {
      lastSmokeRevealPath = null;
    },
    getLastRevealPath: () => lastSmokeRevealPath
  });
}
