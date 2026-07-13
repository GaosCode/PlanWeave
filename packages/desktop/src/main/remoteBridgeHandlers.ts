import { ipcMain, BrowserWindow } from "electron"
import {
  remoteCollaborationInvokeChannels,
  remoteConnectChannel,
  remoteEventChannel,
  type RemoteEventPayload,
  type RemoteConnectEventPayload
} from "../shared/remoteTypes.js"
import { getRemoteProfileWithCredentials } from "./remoteProfiles.js"
import {
  connectRemote,
  disconnectRemote,
  getRemoteConnectionStatus,
  getRemoteProjectSnapshot,
  getRemotePlanningRooms,
  getRemoteMessages,
  sendRemoteMessage,
  getRemoteProposals,
  approveRemoteProposal,
  getRemoteMembers,
  getRemoteTasks,
  claimRemoteTask,
  getRemoteMergeStatus,
  getRemoteCoordination,
  createRemoteBaseline,
  decideRemoteBaseline,
  freezeRemoteBaseline,
  uploadRemoteAttachment,
  registerRemoteAgent,
  preferRemoteTask,
  getRemoteAssignments,
  heartbeatRemoteAssignment,
  getRemoteMergeQueue
} from "./remoteClient.js"
import { detectAgentTools } from "./agentTools.js"
import { DesktopSettingsStore } from "./desktopSettingsStore.js"
import { desktopHomePaths } from "./planweaveHomePaths.js"
import { join } from "node:path"
import { generateConsensusBaselineWithAgent, generateTaskGraphWithAgent, repositoryHead, reviewMergeWithHostAgent, submitAssignment, validateAssignmentLocally } from "./teamWork.js"
import {
  registerRemoteEventSync,
  handleRemoteEvent,
  unregisterRemoteEventSync
} from "./remoteEventSync.js"

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    const { webContents } = window
    if (!webContents.isDestroyed()) {
      webContents.send(channel, payload)
    }
  }
}

export function registerRemoteBridgeHandlers(): void {
  const channels = remoteCollaborationInvokeChannels

  ipcMain.handle(channels.createRemoteProfile, async (_event, input: Parameters<typeof import("./remoteProfiles.js").createRemoteProfile>[0]) => {
    const { createRemoteProfile } = await import("./remoteProfiles.js")
    return createRemoteProfile(input)
  })

  ipcMain.handle(channels.startLocalTeamHost, async (_event, input: Parameters<typeof import("./localTeamHost.js").startLocalTeamHost>[0]) => {
    const { startLocalTeamHost } = await import("./localTeamHost.js")
    return startLocalTeamHost(input)
  })

  ipcMain.handle(channels.updateRemoteProfile, async (_event, id: string, input: Parameters<typeof import("./remoteProfiles.js").updateRemoteProfile>[1]) => {
    const { updateRemoteProfile } = await import("./remoteProfiles.js")
    return updateRemoteProfile(id, input)
  })

  ipcMain.handle(channels.deleteRemoteProfile, async (_event, id: string) => {
    const { deleteRemoteProfile } = await import("./remoteProfiles.js")
    return deleteRemoteProfile(id)
  })

  ipcMain.handle(channels.getRemoteProfile, async (_event, id: string) => {
    const { getRemoteProfile } = await import("./remoteProfiles.js")
    return getRemoteProfile(id)
  })

  ipcMain.handle(channels.listRemoteProfiles, async () => {
    const { listRemoteProfiles } = await import("./remoteProfiles.js")
    return listRemoteProfiles()
  })

  ipcMain.handle(channels.connectProfile, async (_event, profileId: string, projectId: string) => {
    const profile = await getRemoteProfileWithCredentials(profileId)
    if (!profile) {
      throw new Error(`Remote profile '${profileId}' not found`)
    }

    registerRemoteEventSync(profileId, projectId)

    await connectRemote(profile, projectId, (payload: RemoteEventPayload) => {
      handleRemoteEvent(payload)
      broadcast(remoteEventChannel, payload)
    })

    const connectPayload: RemoteConnectEventPayload = {
      profileId,
      status: "connected",
      projectId,
      lastEventId: null
    }
    broadcast(remoteConnectChannel, connectPayload)
  })

  ipcMain.handle(channels.disconnectProfile, async (_event, profileId: string) => {
    await disconnectRemote(profileId)
  })

  ipcMain.handle(channels.getRemoteConnectionStatus, (_event, profileId: string) => {
    return getRemoteConnectionStatus(profileId)
  })

  ipcMain.handle(channels.getRemoteProjectSnapshot, async (_event, profileId: string, projectId: string) => {
    const profile = await getRemoteProfileWithCredentials(profileId)
    if (!profile) {
      throw new Error(`Remote profile '${profileId}' not found`)
    }
    return getRemoteProjectSnapshot(profile, projectId)
  })

  ipcMain.handle(channels.getRemotePlanningRooms, async (_event, profileId: string, projectId: string) => {
    const profile = await getRemoteProfileWithCredentials(profileId)
    if (!profile) {
      throw new Error(`Remote profile '${profileId}' not found`)
    }
    return getRemotePlanningRooms(profile, projectId)
  })

  ipcMain.handle(channels.getRemoteMessages, async (_event, profileId: string, projectId: string, roomId: string) => {
    const profile = await getRemoteProfileWithCredentials(profileId)
    if (!profile) {
      throw new Error(`Remote profile '${profileId}' not found`)
    }
    return getRemoteMessages(profile, projectId, roomId)
  })

  ipcMain.handle(channels.sendRemoteMessage, async (_event, profileId: string, projectId: string, roomId: string, body: string) => {
    const profile = await getRemoteProfileWithCredentials(profileId)
    if (!profile) {
      throw new Error(`Remote profile '${profileId}' not found`)
    }
    return sendRemoteMessage(profile, projectId, roomId, body)
  })

  ipcMain.handle(channels.getRemoteProposals, async (_event, profileId: string, projectId: string) => {
    const profile = await getRemoteProfileWithCredentials(profileId)
    if (!profile) {
      throw new Error(`Remote profile '${profileId}' not found`)
    }
    return getRemoteProposals(profile, projectId)
  })

  ipcMain.handle(channels.approveRemoteProposal, async (_event, profileId: string, projectId: string, proposalId: string, decision: string, reason?: string) => {
    const profile = await getRemoteProfileWithCredentials(profileId)
    if (!profile) {
      throw new Error(`Remote profile '${profileId}' not found`)
    }
    if (decision !== "approve" && decision !== "reject") {
      throw new Error(`Invalid decision: ${decision}`)
    }
    return approveRemoteProposal(profile, projectId, proposalId, decision, reason)
  })

  ipcMain.handle(channels.getRemoteMembers, async (_event, profileId: string, projectId: string) => {
    const profile = await getRemoteProfileWithCredentials(profileId)
    if (!profile) {
      throw new Error(`Remote profile '${profileId}' not found`)
    }
    return getRemoteMembers(profile, projectId)
  })

  ipcMain.handle(channels.getRemoteMergeStatus, async (_event, profileId: string, projectId: string) => {
    const profile = await getRemoteProfileWithCredentials(profileId)
    if (!profile) {
      throw new Error(`Remote profile '${profileId}' not found`)
    }
    return getRemoteMergeStatus(profile, projectId)
  })

  ipcMain.handle(channels.getRemoteTasks, async (_event, profileId: string, projectId: string) => {
    const profile = await getRemoteProfileWithCredentials(profileId)
    if (!profile) throw new Error(`Remote profile '${profileId}' not found`)
    return getRemoteTasks(profile, projectId)
  })

  ipcMain.handle(channels.claimRemoteTask, async (_event, profileId: string, projectId: string, taskId: string, branchName: string, repositoryPath: string) => {
    const profile = await getRemoteProfileWithCredentials(profileId)
    if (!profile) throw new Error(`Remote profile '${profileId}' not found`)
    return claimRemoteTask(profile, projectId, taskId, branchName, await repositoryHead(repositoryPath))
  })

  ipcMain.handle(channels.getRemoteCoordination, async (_event, profileId: string, projectId: string) => {
    const profile = await getRemoteProfileWithCredentials(profileId); if (!profile) throw new Error(`Remote profile '${profileId}' not found`)
    return getRemoteCoordination(profile, projectId)
  })
  ipcMain.handle(channels.createRemoteBaseline, async (_event, profileId: string, projectId: string, input: Parameters<typeof createRemoteBaseline>[2]) => {
    const profile = await getRemoteProfileWithCredentials(profileId); if (!profile) throw new Error(`Remote profile '${profileId}' not found`)
    return createRemoteBaseline(profile, projectId, input)
  })
  ipcMain.handle(channels.decideRemoteBaseline, async (_event, profileId: string, projectId: string, baselineId: string, decision: "approve" | "reject", reason?: string) => {
    const profile = await getRemoteProfileWithCredentials(profileId); if (!profile) throw new Error(`Remote profile '${profileId}' not found`)
    return decideRemoteBaseline(profile, projectId, baselineId, decision, reason)
  })
  ipcMain.handle(channels.freezeRemoteBaseline, async (_event, profileId: string, projectId: string, baselineId: string) => {
    const profile = await getRemoteProfileWithCredentials(profileId); if (!profile) throw new Error(`Remote profile '${profileId}' not found`)
    return freezeRemoteBaseline(profile, projectId, baselineId)
  })
  ipcMain.handle(channels.uploadRemoteAttachment, async (_event, profileId: string, projectId: string, filePath: string) => {
    const profile = await getRemoteProfileWithCredentials(profileId); if (!profile) throw new Error(`Remote profile '${profileId}' not found`)
    return uploadRemoteAttachment(profile, projectId, filePath)
  })
  ipcMain.handle(channels.registerRemoteAgent, async (_event, profileId: string, projectId: string) => {
    const profile = await getRemoteProfileWithCredentials(profileId); if (!profile) throw new Error(`Remote profile '${profileId}' not found`)
    const settings = await new DesktopSettingsStore().read(); const detections = await detectAgentTools(); const agent = detections.find((item) => item.installed && settings.agents[item.kind]?.enabled)
    if (!agent) throw new Error("请先在设置中启用一个已安装的 Agent")
    return registerRemoteAgent(profile, projectId, { kind: agent.kind, name: agent.name, version: agent.version, capabilities: ["requirements", "implementation", "local-review"] })
  })
  ipcMain.handle(channels.preferRemoteTask, async (_event, profileId: string, projectId: string, taskId: string, note: string) => {
    const profile = await getRemoteProfileWithCredentials(profileId); if (!profile) throw new Error(`Remote profile '${profileId}' not found`)
    return preferRemoteTask(profile, projectId, taskId, note)
  })
  ipcMain.handle(channels.getRemoteAssignments, async (_event, profileId: string, projectId: string) => {
    const profile = await getRemoteProfileWithCredentials(profileId); if (!profile) throw new Error(`Remote profile '${profileId}' not found`)
    return getRemoteAssignments(profile, projectId)
  })
  ipcMain.handle(channels.heartbeatRemoteAssignment, async (_event, profileId: string, projectId: string, assignmentId: string, expectedVersion: number) => {
    const profile = await getRemoteProfileWithCredentials(profileId); if (!profile) throw new Error(`Remote profile '${profileId}' not found`)
    return heartbeatRemoteAssignment(profile, projectId, assignmentId, expectedVersion)
  })
  ipcMain.handle(channels.validateRemoteAssignmentLocally, async (_event, profileId: string, projectId: string, assignmentId: string, repositoryPath: string) => {
    const profile = await getRemoteProfileWithCredentials(profileId); if (!profile) throw new Error(`Remote profile '${profileId}' not found`)
    return validateAssignmentLocally(profile, projectId, assignmentId, repositoryPath)
  })
  ipcMain.handle(channels.submitRemoteAssignment, async (_event, profileId: string, projectId: string, assignmentId: string, repositoryPath: string, validation: Parameters<typeof submitAssignment>[4]) => {
    const profile = await getRemoteProfileWithCredentials(profileId); if (!profile) throw new Error(`Remote profile '${profileId}' not found`)
    return submitAssignment(profile, projectId, assignmentId, repositoryPath, validation)
  })
  ipcMain.handle(channels.getRemoteMergeQueue, async (_event, profileId: string, projectId: string) => {
    const profile = await getRemoteProfileWithCredentials(profileId); if (!profile) throw new Error(`Remote profile '${profileId}' not found`)
    return getRemoteMergeQueue(profile, projectId)
  })
  ipcMain.handle(channels.reviewRemoteMerge, async (_event, profileId: string, projectId: string, entryId: string, decision: "approve" | "reject", repositoryPath: string) => {
    const profile = await getRemoteProfileWithCredentials(profileId); if (!profile) throw new Error(`Remote profile '${profileId}' not found`)
    const bareRepoPath = join(desktopHomePaths().planweaveHome, "desktop", "team-server", "integration.git")
    return reviewMergeWithHostAgent(profile, projectId, entryId, decision, repositoryPath, bareRepoPath)
  })
  ipcMain.handle(channels.generateRemoteBaseline, async (_event, profileId: string, projectId: string, repositoryPath: string) => {
    const profile = await getRemoteProfileWithCredentials(profileId); if (!profile) throw new Error(`Remote profile '${profileId}' not found`)
    return generateConsensusBaselineWithAgent(profile, projectId, repositoryPath)
  })
  ipcMain.handle(channels.generateRemoteTasks, async (_event, profileId: string, projectId: string, repositoryPath: string) => {
    const profile = await getRemoteProfileWithCredentials(profileId); if (!profile) throw new Error(`Remote profile '${profileId}' not found`)
    return generateTaskGraphWithAgent(profile, projectId, repositoryPath)
  })
}
