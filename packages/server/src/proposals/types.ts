export const PROPOSAL_STATUSES = ["draft", "open", "approved", "rejected", "withdrawn"] as const;
export type ProposalStatus = typeof PROPOSAL_STATUSES[number];
export function isProposalStatus(value: unknown): value is ProposalStatus {
  return typeof value === "string" && (PROPOSAL_STATUSES as readonly string[]).includes(value);
}

export const APPROVAL_DECISIONS = ["approve", "reject"] as const;
export type ApprovalDecision = typeof APPROVAL_DECISIONS[number];
export function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return value === "approve" || value === "reject";
}

export type Citation = { kind: "message" | "attachment"; id: string };
export function isCitation(value: unknown): value is Citation {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (obj.kind === "message" || obj.kind === "attachment") && typeof obj.id === "string" && obj.id.length > 0;
}

export type Proposal = { id: string; projectId: string; title: string; body: string; status: ProposalStatus; currentRevisionId: string | null; version: number; createdByUserId: string; createdAt: string; updatedAt: string };
export type ProposalRevision = { id: string; proposalId: string; revisionNumber: number; title: string; body: string; citations: Citation[]; createdByUserId: string; createdAt: string };
export type Approval = { id: string; proposalId: string; revisionId: string; approverUserId: string; decision: ApprovalDecision; reason: string | null; createdAt: string };

export type ApprovalPolicy = { requiredRole: "maintainer" | "owner"; requiredCount: number };
export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = { requiredRole: "owner", requiredCount: 1 };
