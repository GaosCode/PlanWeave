import { ipcMain, BrowserWindow } from "electron"
import {
  remoteCollaborationInvokeChannels,
  remoteConnectChannel,
  remoteEventChannel,
  type RemoteEventPayload,
  type RemoteConnectEventPayload
} from "../shared/remoteTypes.js"
import { getRemoteProfile } from "./remoteProfiles.js"
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
  getRemoteMergeStatus
} from "./remoteClient.js"
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
    const profile = await getRemoteProfile(profileId)
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
    const profile = await getRemoteProfile(profileId)
    if (!profile) {
      throw new Error(`Remote profile '${profileId}' not found`)
    }
    return getRemoteProjectSnapshot(profile, projectId)
  })

  ipcMain.handle(channels.getRemotePlanningRooms, async (_event, profileId: string, projectId: string) => {
    const profile = await getRemoteProfile(profileId)
    if (!profile) {
      throw new Error(`Remote profile '${profileId}' not found`)
    }
    return getRemotePlanningRooms(profile, projectId)
  })

  ipcMain.handle(channels.getRemoteMessages, async (_event, profileId: string, projectId: string, roomId: string) => {
    const profile = await getRemoteProfile(profileId)
    if (!profile) {
      throw new Error(`Remote profile '${profileId}' not found`)
    }
    return getRemoteMessages(profile, projectId, roomId)
  })

  ipcMain.handle(channels.sendRemoteMessage, async (_event, profileId: string, projectId: string, roomId: string, body: string) => {
    const profile = await getRemoteProfile(profileId)
    if (!profile) {
      throw new Error(`Remote profile '${profileId}' not found`)
    }
    return sendRemoteMessage(profile, projectId, roomId, body)
  })

  ipcMain.handle(channels.getRemoteProposals, async (_event, profileId: string, projectId: string) => {
    const profile = await getRemoteProfile(profileId)
    if (!profile) {
      throw new Error(`Remote profile '${profileId}' not found`)
    }
    return getRemoteProposals(profile, projectId)
  })

  ipcMain.handle(channels.approveRemoteProposal, async (_event, profileId: string, projectId: string, proposalId: string, decision: string, reason?: string) => {
    const profile = await getRemoteProfile(profileId)
    if (!profile) {
      throw new Error(`Remote profile '${profileId}' not found`)
    }
    if (decision !== "approve" && decision !== "reject") {
      throw new Error(`Invalid decision: ${decision}`)
    }
    return approveRemoteProposal(profile, projectId, proposalId, decision, reason)
  })

  ipcMain.handle(channels.getRemoteMembers, async (_event, profileId: string, projectId: string) => {
    const profile = await getRemoteProfile(profileId)
    if (!profile) {
      throw new Error(`Remote profile '${profileId}' not found`)
    }
    return getRemoteMembers(profile, projectId)
  })

  ipcMain.handle(channels.getRemoteMergeStatus, async (_event, profileId: string, projectId: string) => {
    const profile = await getRemoteProfile(profileId)
    if (!profile) {
      throw new Error(`Remote profile '${profileId}' not found`)
    }
    return getRemoteMergeStatus(profile, projectId)
  })

  ipcMain.handle(channels.getRemoteTasks, async (_event, profileId: string, projectId: string) => {
    const profile = await getRemoteProfile(profileId)
    if (!profile) throw new Error(`Remote profile '${profileId}' not found`)
    return getRemoteTasks(profile, projectId)
  })

  ipcMain.handle(channels.claimRemoteTask, async (_event, profileId: string, projectId: string, taskId: string, branchName: string, baseCommit: string) => {
    const profile = await getRemoteProfile(profileId)
    if (!profile) throw new Error(`Remote profile '${profileId}' not found`)
    return claimRemoteTask(profile, projectId, taskId, branchName, baseCommit)
  })
}
