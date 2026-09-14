import type {
  DispatchResult as ProtocolDispatchResult,
  HostEvent,
  HistoricalHostEvent,
  NormalizedFailure as ProtocolDispatchFailure,
  ServerEvent
} from "../protocol.js";
import type { AgentHostRemoteExecutionIdentity } from "../execution/remoteAcpPorts.js";
import type { HostReadinessObservation } from "@planweave-ai/agent-host-protocol";
import type {
  AgentHostExecution,
  AgentHostExecutionEvidence,
  CancelExecutionCommand
} from "./agentHostStateRecords.js";

export type AgentHostExecutionSettlement = "applied" | "stale" | "lease_lost";

export type AgentHostCancellation = {
  sequence: number;
  messageId: string;
  command: CancelExecutionCommand;
};

export type AgentHostResumption = {
  execution: AgentHostExecution;
  sessionId: string;
};

export type AgentHostStateLimits = {
  readonly maxPendingCommands: number;
  readonly maxPendingEvents: number;
  readonly maxCapabilitiesBytes: number;
  readonly maxActionsPerExecution: number;
  readonly maxArtifactsPerExecution: number;
  readonly maxRemoteRecordsPerExecution: number;
  readonly maxRemoteRecordBytes: number;
};

export const DEFAULT_AGENT_HOST_STATE_LIMITS: AgentHostStateLimits = {
  maxPendingCommands: 1_024,
  maxPendingEvents: 2_048,
  maxCapabilitiesBytes: 64 * 1_024,
  maxActionsPerExecution: 256,
  maxArtifactsPerExecution: 256,
  maxRemoteRecordsPerExecution: 4_096,
  maxRemoteRecordBytes: 1_048_576
};

export interface AgentHostStateRepository {
  setRemoteRunnerEventProtocolVersion(version: 2): void;
  close(): void;
  receive(input: ServerEvent): { stored: boolean; acknowledgement: HostEvent };
  lastAcknowledgedSequence(): number;
  pendingEvents(limit?: number): HistoricalHostEvent[];
  pendingEventCount(): number;
  queueHeartbeat(
    activeLeases: ReadonlyArray<{
      dispatchId: string;
      leaseId: string;
      executionAttemptId: string;
    }>,
    readiness?: HostReadinessObservation
  ): HostEvent;
  acknowledgeEvent(messageId: string): boolean;
  recoverInterruptedExecutions(): number;
  recoverableExecutionCount(): number;
  pendingExecutions(limit: number): AgentHostExecution[];
  executionEvidence(sequence: number): AgentHostExecutionEvidence | undefined;
  recordArtifactTransfer(sequence: number, leaseId: string, input: unknown): boolean;
  activeLeases(): Array<{
    dispatchId: string;
    leaseId: string;
    executionAttemptId: string;
  }>;
  nextLeaseExpiresAt(): string | undefined;
  renewLease(
    dispatchId: string,
    leaseId: string,
    executionAttemptId: string,
    leaseExpiresAt: string,
    now?: Date
  ): boolean;
  abandonExpiredExecutions(now: Date): AgentHostExecution[];
  pendingCancellations(): AgentHostCancellation[];
  applyCancellation(sequence: number): { shouldAbort: boolean };
  pendingResumptions(limit: number): AgentHostExecution[];
  startResumption(sequence: number, now?: Date): AgentHostResumption | undefined;
  failResumption(
    sequence: number,
    expected: AgentHostRemoteExecutionIdentity,
    now?: Date
  ): AgentHostExecutionSettlement;
  startExecution(sequence: number, now?: Date): AgentHostExecution | undefined;
  completeExecution(
    sequence: number,
    expected: AgentHostRemoteExecutionIdentity,
    result: ProtocolDispatchResult,
    now?: Date
  ): AgentHostExecutionSettlement;
  failExecution(
    sequence: number,
    expected: AgentHostRemoteExecutionIdentity,
    failure: ProtocolDispatchFailure,
    now?: Date
  ): AgentHostExecutionSettlement;
}
