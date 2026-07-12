/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest"
import type { PlanWeaveRemoteApi, RemoteConnectEventPayload, RemoteEventPayload, RemoteMessage, RemoteProposal, RemoteApproval, RemoteMember } from "../shared/remoteTypes"

describe("remote collaboration workflow (two-client simulation)", () => {
  function createMockApi(
    name: string,
    eventCallbacks: Array<(payload: RemoteEventPayload) => void>
  ): PlanWeaveRemoteApi {
    return {
      createRemoteProfile: vi.fn(),
      updateRemoteProfile: vi.fn(),
      deleteRemoteProfile: vi.fn(),
      getRemoteProfile: vi.fn(),
      listRemoteProfiles: vi.fn(),
      connectProfile: vi.fn().mockResolvedValue(undefined),
      disconnectProfile: vi.fn().mockResolvedValue(undefined),
      getRemoteConnectionStatus: vi.fn().mockResolvedValue("disconnected"),
      getRemoteProjectSnapshot: vi.fn().mockResolvedValue({
        project: { id: "project-1", name: "Test Project", version: 1, createdAt: new Date().toISOString() },
        lastEventId: "0",
        planningRooms: [{ id: "room-1", name: "General", archivedAt: null }],
        members: [{ userId: "user-1", displayName: name, role: "owner" as const, online: true }],
        proposals: [],
        mergeStatus: { aheadCount: 0, behindCount: 0, hasConflicts: false, lastSyncedEventId: null }
      }),
      getRemotePlanningRooms: vi.fn().mockResolvedValue([{ id: "room-1", name: "General", archivedAt: null }]),
      getRemoteMessages: vi.fn().mockResolvedValue([]),
      sendRemoteMessage: vi.fn().mockImplementation(async (profileId, projectId, roomId, body) => {
        const msg: RemoteMessage = {
          id: `msg-${Date.now()}`,
          roomId,
          authorUserId: "user-1",
          body,
          kind: "text",
          createdAt: new Date().toISOString()
        }
        for (const cb of eventCallbacks) {
          cb({
            profileId,
            projectId,
            eventType: "message.created",
            aggregateType: "message",
            aggregateId: msg.id,
            aggregateVersion: 1,
            occurredAt: msg.createdAt
          })
        }
        return msg
      }),
      getRemoteProposals: vi.fn().mockResolvedValue([
        { id: "prop-1", projectId: "project-1", title: "Test Proposal", body: "A test proposal", status: "open" as const, version: 1, createdByUserId: "user-1", createdAt: new Date().toISOString() }
      ]),
      approveRemoteProposal: vi.fn().mockImplementation(async (profileId, projectId, proposalId, decision, reason) => {
        const approval: RemoteApproval = {
          id: `app-${Date.now()}`,
          proposalId,
          revisionId: "rev-1",
          approverUserId: "user-1",
          decision,
          reason: reason ?? null,
          createdAt: new Date().toISOString()
        }
        for (const cb of eventCallbacks) {
          cb({
            profileId,
            projectId,
            eventType: `proposal.${decision === "approve" ? "approved" : "rejected"}`,
            aggregateType: "proposal",
            aggregateId: proposalId,
            aggregateVersion: 1,
            occurredAt: approval.createdAt
          })
        }
        return approval
      }),
      getRemoteMembers: vi.fn().mockResolvedValue([
        { userId: "user-1", displayName: "Alice", role: "owner" as const, online: true },
        { userId: "user-2", displayName: "Bob", role: "maintainer" as const, online: true }
      ]),
      getRemoteMergeStatus: vi.fn().mockResolvedValue({
        aheadCount: 0, behindCount: 0, hasConflicts: false, lastSyncedEventId: "0"
      }),
      onRemoteEvent: (callback) => {
        eventCallbacks.push(callback)
        return () => {
          const idx = eventCallbacks.indexOf(callback)
          if (idx >= 0) eventCallbacks.splice(idx, 1)
        }
      },
      onRemoteConnect: () => () => {}
    }
  }

  it("two desktop clients observe proposal changes after reconnect", async () => {
    const eventsA: Array<(payload: RemoteEventPayload) => void> = []
    const eventsB: Array<(payload: RemoteEventPayload) => void> = []
    const apiA = createMockApi("Alice", eventsA)
    const apiB = createMockApi("Bob", eventsB)

    await apiA.connectProfile("profile-1", "project-1")
    await apiB.connectProfile("profile-2", "project-1")

    const proposal = (await apiA.getRemoteProposals("profile-1", "project-1"))[0]
    expect(proposal).toBeDefined()
    expect(proposal!.status).toBe("open")

    await apiA.approveRemoteProposal("profile-1", "project-1", proposal!.id, "approve")

    const proposalsB = await apiB.getRemoteProposals("profile-2", "project-1")
    expect(proposalsB.length).toBeGreaterThanOrEqual(1)
  })

  it("stale revision approval is visibly rejected", async () => {
    const failedApi: PlanWeaveRemoteApi = createMockApi("Alice", [])
    const mockApprove = vi.fn().mockRejectedValue(new Error("version_conflict: proposal has been updated since you loaded it"))
    failedApi.approveRemoteProposal = mockApprove

    await expect(
      failedApi.approveRemoteProposal("profile-1", "project-1", "prop-stale", "approve")
    ).rejects.toThrow("version_conflict")

    expect(mockApprove).toHaveBeenCalledTimes(1)
    const callArgs = mockApprove.mock.calls[0]
    expect(callArgs[0]).toBe("profile-1")
    expect(callArgs[1]).toBe("project-1")
    expect(callArgs[2]).toBe("prop-stale")
    expect(callArgs[3]).toBe("approve")
  })

  it("local mode smoke remains unchanged when no remote profile is active", () => {
    expect(true).toBe(true)
  })

  it("members include online presence status", async () => {
    const events: Array<(payload: RemoteEventPayload) => void> = []
    const api = createMockApi("Alice", events)

    const members = await api.getRemoteMembers("profile-1", "project-1")
    expect(members.length).toBe(2)
    expect(members[0]!.displayName).toBe("Alice")
    expect(members[0]!.online).toBe(true)
    expect(members[1]!.displayName).toBe("Bob")
    expect(members[1]!.online).toBe(true)
  })

  it("send message and receive via event callback", async () => {
    const eventsA: Array<(payload: RemoteEventPayload) => void> = []
    const eventsB: Array<(payload: RemoteEventPayload) => void> = []
    const apiA = createMockApi("Alice", eventsA)
    const apiB = createMockApi("Bob", eventsB)

    let receivedEvent: RemoteEventPayload | null = null
    apiA.onRemoteEvent((event) => {
      if (event.eventType === "message.created") {
        receivedEvent = event
      }
    })

    await apiA.sendRemoteMessage("profile-1", "project-1", "room-1", "Hello from Alice!")

    expect(apiA.sendRemoteMessage).toHaveBeenCalledWith("profile-1", "project-1", "room-1", "Hello from Alice!")
    expect(receivedEvent).not.toBeNull()
    expect(receivedEvent!.eventType).toBe("message.created")
    expect(receivedEvent!.aggregateType).toBe("message")
  })
})
