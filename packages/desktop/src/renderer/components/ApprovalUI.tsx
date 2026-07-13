import { useState } from "react"
import type { RemoteProposal } from "../../shared/remoteTypes.js"

type ApprovalUIProps = {
  proposals: RemoteProposal[]
  onApprove: (proposalId: string, decision: "approve" | "reject", reason?: string) => Promise<void>
}

export function ApprovalUI({ proposals, onApprove }: ApprovalUIProps) {
  const [reasonInputs, setReasonInputs] = useState<Record<string, string>>({})
  const [errorInputs, setErrorInputs] = useState<Record<string, string | null>>({})

  if (proposals.length === 0) {
    return null
  }

  const openProposals = proposals.filter((p) => p.status === "open" || p.status === "draft")

  async function handleAction(proposalId: string, decision: "approve" | "reject") {
    setErrorInputs((prev) => ({ ...prev, [proposalId]: null }))
    try {
      await onApprove(proposalId, decision, reasonInputs[proposalId] || undefined)
      setReasonInputs((prev) => {
        const next = { ...prev }
        delete next[proposalId]
        return next
      })
    } catch (caught: unknown) {
      setErrorInputs((prev) => ({ ...prev, [proposalId]: caught instanceof Error ? caught.message : String(caught) }))
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-foreground">Proposals</h3>
      {openProposals.map((proposal) => (
        <div key={proposal.id} className="flex flex-col gap-1 rounded-md border border-input bg-muted/30 p-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-foreground">{proposal.title}</span>
            <span className={`text-xs ${proposal.status === "open" ? "text-amber-500" : "text-muted-foreground"}`}>
              {proposal.status}
            </span>
          </div>
          {proposal.body && (
            <p className="text-xs text-muted-foreground line-clamp-2">{proposal.body}</p>
          )}
          {errorInputs[proposal.id] && (
            <div className="text-xs text-destructive rounded bg-destructive/10 px-2 py-1">{errorInputs[proposal.id]}</div>
          )}
          <input
            type="text"
            className="rounded-md border border-input bg-transparent px-2 py-0.5 text-xs text-foreground placeholder:text-muted-foreground"
            placeholder="Reason (optional)"
            value={reasonInputs[proposal.id] || ""}
            onChange={(e) => setReasonInputs((prev) => ({ ...prev, [proposal.id]: e.target.value }))}
          />
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded bg-green-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-green-700"
              onClick={() => { void handleAction(proposal.id, "approve") }}
            >
              Approve
            </button>
            <button
              type="button"
              className="rounded bg-destructive px-2 py-0.5 text-xs font-medium text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { void handleAction(proposal.id, "reject") }}
            >
              Reject
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
