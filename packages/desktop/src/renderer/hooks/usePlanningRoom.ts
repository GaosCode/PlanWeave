import { useCallback, useState } from "react"
import type { RemoteMessage } from "../../shared/remoteTypes.js"
import { remoteBridge } from "../bridge.js"

export function usePlanningRoom(profileId: string | null, projectId: string | null) {
  const [messages, setMessages] = useState<RemoteMessage[]>([])
  const [loading, setLoading] = useState(false)

  const loadMessages = useCallback(async (roomId: string) => {
    if (!remoteBridge || !profileId || !projectId) return
    setLoading(true)
    try {
      const result = await remoteBridge.getRemoteMessages(profileId, projectId, roomId)
      setMessages(result)
    } catch (error) {
      throw error
    } finally {
      setLoading(false)
    }
  }, [profileId, projectId])

  const sendMessage = useCallback(async (roomId: string, body: string) => {
    if (!remoteBridge || !profileId || !projectId) {
      throw new Error("Not connected to remote project")
    }
    const message = await remoteBridge.sendRemoteMessage(profileId, projectId, roomId, body)
    setMessages((prev) => [...prev, message])
    return message
  }, [profileId, projectId])

  return {
    messages,
    loading,
    loadMessages,
    sendMessage
  }
}
