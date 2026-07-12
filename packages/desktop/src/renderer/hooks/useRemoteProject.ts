import { useCallback, useState } from "react"
import type { RemoteProjectSnapshot, RemoteProposal, RemoteApproval, RemoteMember, RemoteMergeStatus } from "../../shared/remoteTypes.js"
import { remoteBridge } from "../bridge.js"

export function useRemoteProject(profileId: string | null, projectId: string | null) {
  const [snapshot, setSnapshot] = useState<RemoteProjectSnapshot | null>(null)
  const [loading, setLoading] = useState(false)

  const loadSnapshot = useCallback(async () => {
    if (!remoteBridge || !profileId || !projectId) return
    setLoading(true)
    try {
      const result = await remoteBridge.getRemoteProjectSnapshot(profileId, projectId)
      setSnapshot(result)
    } finally {
      setLoading(false)
    }
  }, [profileId, projectId])

  const approveProposal = useCallback(async (proposalId: string, decision: "approve" | "reject", reason?: string) => {
    if (!remoteBridge || !profileId || !projectId) {
      throw new Error("Not connected to remote project")
    }
    return remoteBridge.approveRemoteProposal(profileId, projectId, proposalId, decision, reason)
  }, [profileId, projectId])

  return {
    snapshot,
    loading,
    loadSnapshot,
    approveProposal,
    proposals: snapshot?.proposals ?? [],
    members: snapshot?.members ?? [],
    mergeStatus: snapshot?.mergeStatus ?? { aheadCount: 0, behindCount: 0, hasConflicts: false, lastSyncedEventId: null }
  }
}
