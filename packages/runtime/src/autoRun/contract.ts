import type { ClaimResult } from "../types.js";

type BlockClaim = Extract<ClaimResult, { kind: "block" }>;
type FeedbackClaim = Extract<ClaimResult, { kind: "feedback" }>;

export type AutoRunBlockArtifact =
  | {
      kind: "block_report";
      ref: string;
      artifactPath: string;
    }
  | {
      kind: "review_result";
      ref: string;
      artifactPath: string;
    };

export type AutoRunFeedbackArtifact = {
  kind: "feedback_report";
  artifactPath: string;
};

export type AutoRunExecutorAdapter = {
  executeBlock(claim: BlockClaim): Promise<AutoRunBlockArtifact>;
  handleFeedback(claim: FeedbackClaim): Promise<AutoRunFeedbackArtifact>;
};

export type AutoRunDecision =
  | {
      kind: "submit_result";
      ref: string;
      reportPath: string;
    }
  | {
      kind: "submit_review";
      ref: string;
      resultPath: string;
    }
  | {
      kind: "submit_feedback";
      reportPath: string;
    }
  | {
      kind: "stop";
      reason?: string;
    }
  | {
      kind: "blocked";
      ref?: string;
      reason: string;
    };

export async function consumeAutoRunClaim(claim: ClaimResult, adapter: AutoRunExecutorAdapter): Promise<AutoRunDecision> {
  if (claim.kind === "block") {
    const artifact = await adapter.executeBlock(claim);
    if (artifact.kind === "review_result") {
      return { kind: "submit_review", ref: artifact.ref, resultPath: artifact.artifactPath };
    }
    return { kind: "submit_result", ref: artifact.ref, reportPath: artifact.artifactPath };
  }
  if (claim.kind === "feedback") {
    const artifact = await adapter.handleFeedback(claim);
    return { kind: "submit_feedback", reportPath: artifact.artifactPath };
  }
  if (claim.kind === "blocked") {
    return { kind: "blocked", ref: claim.ref, reason: claim.reason };
  }
  return { kind: "stop", reason: claim.kind === "none" ? claim.reason : "batch_claim_requires_external orchestration" };
}
