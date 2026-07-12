/* @vitest-environment jsdom */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PlanWeaveRemoteApi, RemoteConnectEventPayload, RemoteEventPayload } from "../shared/remoteTypes"

const { mockConnectCallbacks, mockEventCallbacks, mockRemoteApi } = vi.hoisted(() => {
  const mockConnectCallbacks: Array<(payload: RemoteConnectEventPayload) => void> = []
  const mockEventCallbacks: Array<(payload: RemoteEventPayload) => void> = []

  const mockRemoteApi: PlanWeaveRemoteApi = {
    createRemoteProfile: vi.fn(),
    updateRemoteProfile: vi.fn(),
    deleteRemoteProfile: vi.fn(),
    getRemoteProfile: vi.fn(),
    listRemoteProfiles: vi.fn(),
    connectProfile: vi.fn(),
    disconnectProfile: vi.fn(),
    getRemoteConnectionStatus: vi.fn(),
    getRemoteProjectSnapshot: vi.fn(),
    getRemotePlanningRooms: vi.fn(),
    getRemoteMessages: vi.fn(),
    sendRemoteMessage: vi.fn(),
    getRemoteProposals: vi.fn(),
    approveRemoteProposal: vi.fn(),
    getRemoteMembers: vi.fn(),
    getRemoteMergeStatus: vi.fn(),
    onRemoteEvent: (callback) => {
      mockEventCallbacks.push(callback)
      return () => {
        const idx = mockEventCallbacks.indexOf(callback)
        if (idx >= 0) mockEventCallbacks.splice(idx, 1)
      }
    },
    onRemoteConnect: (callback) => {
      mockConnectCallbacks.push(callback)
      return () => {
        const idx = mockConnectCallbacks.indexOf(callback)
        if (idx >= 0) mockConnectCallbacks.splice(idx, 1)
      }
    }
  }

  return { mockConnectCallbacks, mockEventCallbacks, mockRemoteApi }
})

vi.mock("../renderer/bridge.js", () => ({
  bridge: null,
  settingsBridge: null,
  remoteBridge: mockRemoteApi,
  desktopCanvasReference: vi.fn()
}))

import { useRemoteConnection } from "../renderer/hooks/useRemoteConnection"

beforeEach(() => {
  mockConnectCallbacks.length = 0
  mockEventCallbacks.length = 0
  ;(mockRemoteApi.connectProfile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
  ;(mockRemoteApi.disconnectProfile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("useRemoteConnection", () => {
  it("starts disconnected", () => {
    const { result } = renderHook(() => useRemoteConnection())
    expect(result.current.connectionStatus).toBe("disconnected")
    expect(result.current.isConnected).toBe(false)
    expect(result.current.activeProfileId).toBeNull()
  })

  it("connects to a remote profile", async () => {
    const { result } = renderHook(() => useRemoteConnection())

    await act(async () => {
      await result.current.connect("profile-1", "project-1")
    })

    expect(result.current.connectionStatus).toBe("connected")
    expect(result.current.isConnected).toBe(true)
    expect(result.current.activeProfileId).toBe("profile-1")
    expect(result.current.activeProjectId).toBe("project-1")
    expect(mockRemoteApi.connectProfile).toHaveBeenCalledWith("profile-1", "project-1")
  })

  it("updates status on connect event", async () => {
    const { result } = renderHook(() => useRemoteConnection())

    act(() => {
      const cb = mockConnectCallbacks[0]
      if (cb) {
        cb({
          profileId: "profile-2",
          status: "connected",
          projectId: "project-2",
          lastEventId: "evt-001"
        })
      }
    })

    await waitFor(() => {
      expect(result.current.connectionStatus).toBe("connected")
    })
    expect(result.current.activeProfileId).toBe("profile-2")
    expect(result.current.activeProjectId).toBe("project-2")
    expect(result.current.lastEventId).toBe("evt-001")
  })

  it("disconnects from a remote profile", async () => {
    const { result } = renderHook(() => useRemoteConnection())

    await act(async () => {
      await result.current.connect("profile-3", "project-3")
    })

    expect(result.current.isConnected).toBe(true)

    await act(async () => {
      await result.current.disconnect()
    })

    expect(result.current.connectionStatus).toBe("disconnected")
    expect(result.current.isConnected).toBe(false)
    expect(mockRemoteApi.disconnectProfile).toHaveBeenCalledWith("profile-3")
  })

  it("handles connection errors", async () => {
    ;(mockRemoteApi.connectProfile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Connection refused"))

    const { result } = renderHook(() => useRemoteConnection())

    await act(async () => {
      try {
        await result.current.connect("profile-err", "project-err")
      } catch {
        /* expected */
      }
    })

    expect(result.current.connectionStatus).toBe("error")
    expect(result.current.isConnected).toBe(false)
  })
})
