export const workflowPhases = ["planning", "consensus", "execution", "review", "completed"] as const;
export type WorkflowPhase = (typeof workflowPhases)[number];

export const baselineStatuses = ["draft", "frozen", "superseded"] as const;
export type BaselineStatus = (typeof baselineStatuses)[number];

export type BaselineCitation = { kind: "message" | "attachment"; id: string };

export type ConsensusBaseline = {
  id: string;
  projectId: string;
  revision: number;
  status: BaselineStatus;
  title: string;
  summary: string;
  requirements: string[];
  constraints: string[];
  decisions: string[];
  acceptanceCriteria: string[];
  risks: string[];
  openQuestions: string[];
  citations: BaselineCitation[];
  createdByUserId: string;
  createdAt: string;
  frozenAt: string | null;
};

export type BaselineApproval = {
  baselineId: string;
  userId: string;
  decision: "approve" | "reject";
  reason: string | null;
  createdAt: string;
};

export type TaskPreference = {
  projectId: string;
  taskId: string;
  userId: string;
  note: string;
  createdAt: string;
};

export type MemberAgentProfile = {
  projectId: string;
  userId: string;
  deviceId: string;
  kind: "codex" | "claude-code" | "opencode" | "pi" | "manual";
  name: string;
  version: string | null;
  capabilities: string[];
  updatedAt: string;
};

export type SubmissionEvidence = {
  submissionId: string;
  projectId: string;
  submittedByUserId: string;
  localChecks: Array<{ name: string; passed: boolean; output?: string }>;
  agentReport: string | null;
  bundleDigest: string | null;
  bundleSize: number | null;
  bundleStatus: "missing" | "imported" | "failed";
  createdAt: string;
  updatedAt: string;
};

export type CoordinationSnapshot = {
  phase: WorkflowPhase;
  version: number;
  activeBaselineId: string | null;
  baselines: ConsensusBaseline[];
  approvals: BaselineApproval[];
  preferences: TaskPreference[];
  agentProfiles: MemberAgentProfile[];
  submissionEvidence: SubmissionEvidence[];
};
