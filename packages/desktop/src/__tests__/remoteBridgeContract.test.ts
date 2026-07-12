import { describe, expect, it } from "vitest"
import { REMOTE_ROLES, remoteCollaborationInvokeChannels, type PlanWeaveRemoteApi, type RemoteProfile, type RemoteConnectionStatus, type RemoteProjectSnapshot } from "../shared/remoteTypes"

describe("remote bridge contract", () => {
  it("defines all required invoke channels", () => {
    const channels = remoteCollaborationInvokeChannels
    expect(channels.createRemoteProfile).toBe("planweave-remote:createRemoteProfile")
    expect(channels.startLocalTeamHost).toBe("planweave-remote:startLocalTeamHost")
    expect(channels.connectProfile).toBe("planweave-remote:connectProfile")
    expect(channels.disconnectProfile).toBe("planweave-remote:disconnectProfile")
    expect(channels.getRemoteProjectSnapshot).toBe("planweave-remote:getRemoteProjectSnapshot")
    expect(channels.approveRemoteProposal).toBe("planweave-remote:approveRemoteProposal")
    expect(channels.getRemoteMergeStatus).toBe("planweave-remote:getRemoteMergeStatus")
  })

  it("defines all remote API surface methods", () => {
    const apiMethods: Array<keyof PlanWeaveRemoteApi> = [
      "createRemoteProfile",
      "startLocalTeamHost",
      "updateRemoteProfile",
      "deleteRemoteProfile",
      "getRemoteProfile",
      "listRemoteProfiles",
      "connectProfile",
      "disconnectProfile",
      "getRemoteConnectionStatus",
      "getRemoteProjectSnapshot",
      "getRemotePlanningRooms",
      "getRemoteMessages",
      "sendRemoteMessage",
      "getRemoteProposals",
      "approveRemoteProposal",
      "getRemoteMembers",
      "getRemoteMergeStatus",
      "onRemoteEvent",
      "onRemoteConnect"
    ]

    const channelMethodMap: Record<string, string> = {
      createRemoteProfile: remoteCollaborationInvokeChannels.createRemoteProfile,
      startLocalTeamHost: remoteCollaborationInvokeChannels.startLocalTeamHost,
      updateRemoteProfile: remoteCollaborationInvokeChannels.updateRemoteProfile,
      deleteRemoteProfile: remoteCollaborationInvokeChannels.deleteRemoteProfile,
      getRemoteProfile: remoteCollaborationInvokeChannels.getRemoteProfile,
      listRemoteProfiles: remoteCollaborationInvokeChannels.listRemoteProfiles,
      connectProfile: remoteCollaborationInvokeChannels.connectProfile,
      disconnectProfile: remoteCollaborationInvokeChannels.disconnectProfile,
      getRemoteConnectionStatus: remoteCollaborationInvokeChannels.getRemoteConnectionStatus,
      getRemoteProjectSnapshot: remoteCollaborationInvokeChannels.getRemoteProjectSnapshot,
      getRemotePlanningRooms: remoteCollaborationInvokeChannels.getRemotePlanningRooms,
      getRemoteMessages: remoteCollaborationInvokeChannels.getRemoteMessages,
      sendRemoteMessage: remoteCollaborationInvokeChannels.sendRemoteMessage,
      getRemoteProposals: remoteCollaborationInvokeChannels.getRemoteProposals,
      approveRemoteProposal: remoteCollaborationInvokeChannels.approveRemoteProposal,
      getRemoteMembers: remoteCollaborationInvokeChannels.getRemoteMembers,
      getRemoteMergeStatus: remoteCollaborationInvokeChannels.getRemoteMergeStatus
    }

    for (const method of apiMethods) {
      if (method in channelMethodMap) {
        expect(channelMethodMap[method]).toContain("planweave-remote:")
      }
    }

    for (const channel of Object.values(remoteCollaborationInvokeChannels)) {
      expect(channel).toContain("planweave-remote:")
    }
  })

  it("RemoteRole values match server roles", () => {
    expect(REMOTE_ROLES).toEqual(["viewer", "contributor", "maintainer", "owner"])
  })
})
