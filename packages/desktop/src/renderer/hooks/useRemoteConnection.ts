import { useCallback, useEffect, useState } from "react"
import type { RemoteConnectionStatus, RemoteConnectEventPayload, RemoteEventPayload } from "../../shared/remoteTypes.js"
import { remoteBridge } from "../bridge.js"

export function useRemoteConnection() {
  const [connectionStatus, setConnectionStatus] = useState<RemoteConnectionStatus>("disconnected")
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null)
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [lastEventId, setLastEventId] = useState<string | null>(null)

  useEffect(() => {
    if (!remoteBridge) return

    const removeEventListener = remoteBridge.onRemoteConnect((payload: RemoteConnectEventPayload) => {
      setConnectionStatus(payload.status)
      setActiveProfileId(payload.profileId)
      setActiveProjectId(payload.projectId)
      setLastEventId(payload.lastEventId)
    })

    return removeEventListener
  }, [])

  const connect = useCallback(async (profileId: string, projectId: string) => {
    if (!remoteBridge) {
      throw new Error("Remote bridge unavailable")
    }
    setConnectionStatus("connecting")
    setActiveProfileId(profileId)
    setActiveProjectId(projectId)
    try {
      await remoteBridge.connectProfile(profileId, projectId)
      setConnectionStatus("connected")
    } catch (error) {
      setConnectionStatus("error")
      throw error
    }
  }, [])

  const disconnect = useCallback(async () => {
    if (!remoteBridge || !activeProfileId) return
    await remoteBridge.disconnectProfile(activeProfileId)
    setConnectionStatus("disconnected")
    setActiveProfileId(null)
    setActiveProjectId(null)
    setLastEventId(null)
  }, [activeProfileId])

  return {
    connectionStatus,
    activeProfileId,
    activeProjectId,
    lastEventId,
    connect,
    disconnect,
    isConnected: connectionStatus === "connected"
  }
}
