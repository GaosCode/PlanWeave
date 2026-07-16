import {
  RUNNER_EVENT_MAX_ENCODED_BYTES,
  RUNNER_EVENT_RETENTION_MAX_BYTES,
  RUNNER_EVENT_RETENTION_MAX_EVENTS,
  type NormalizedRunnerEvent
} from "./normalizedEventContract.js";
import type { RunnerEventReplayDiagnostic } from "./runnerEventReplay.js";

export const ACP_EVENT_RETENTION_RESERVE_EVENTS = 1024;
export const ACP_EVENT_RETENTION_RESERVE_BYTES = 1 * 1024 * 1024;
export const ACP_PROTOCOL_RETENTION_RESERVE_BYTES = 256 * 1024;

export type AcpRetentionBudgetSnapshot = {
  eventCount: number;
  byteCount: number;
  ordinaryEventCount: number;
  ordinaryByteCount: number;
  boundaryWritten: boolean;
  hasArtifact: boolean;
  hasTerminal: boolean;
};

export type AcpEventAdmissionDecision =
  | { action: "persist" }
  | { action: "drop_ordinary"; reason: string; shouldWriteBoundary: boolean }
  | { action: "hard_reject"; reason: string };

export type AcpProtocolAdmissionDecision =
  | { action: "persist" }
  | { action: "drop"; shouldWriteBoundary: boolean; markSoftExceeded: true };
export type AcpBoundaryAdmissionDecision =
  | { action: "persist" }
  | { action: "skip"; reason: "already_written" | "hard_exhausted" };

type AcpFinalEvidenceBudget = {
  eventCount: number;
  byteCount: number;
};

export interface AcpEventRetentionPolicy {
  readonly maxEvents: number;
  readonly maxBytes: number;
  readonly reserveEvents: number;
  readonly reserveBytes: number;
  readonly protocolReserveBytes: number;

  classify(body: NormalizedRunnerEvent["body"]): "ordinary" | "control";
  getOrdinaryEventLimit(): number;
  getOrdinaryByteLimit(): number;
  getProtocolByteLimit(maxProtocolBytes?: number): number;
  decideEventAdmission(
    body: NormalizedRunnerEvent["body"],
    encodedLen: number,
    budget: AcpRetentionBudgetSnapshot
  ): AcpEventAdmissionDecision;

  decideProtocolAdmission(
    protocolBytes: number,
    encodedLen: number,
    flags: { boundaryWritten: boolean; protocolSoftExceeded: boolean },
    maxProtocolBytes?: number
  ): AcpProtocolAdmissionDecision;

  decideBoundaryAdmission(
    encodedLen: number,
    budget: AcpRetentionBudgetSnapshot
  ): AcpBoundaryAdmissionDecision;
}

export type AcpEventRetentionPolicyOverrides = {
  maxEvents?: number;
  maxBytes?: number;
  reserveEvents?: number;
  reserveBytes?: number;
  protocolReserveBytes?: number;
};

export class DefaultAcpEventRetentionPolicy implements AcpEventRetentionPolicy {
  readonly maxEvents: number;
  readonly maxBytes: number;
  readonly reserveEvents: number;
  readonly reserveBytes: number;
  readonly protocolReserveBytes: number;

  constructor(overrides?: AcpEventRetentionPolicyOverrides) {
    this.maxEvents = overrides?.maxEvents ?? RUNNER_EVENT_RETENTION_MAX_EVENTS;
    this.maxBytes = overrides?.maxBytes ?? RUNNER_EVENT_RETENTION_MAX_BYTES;
    this.reserveEvents =
      overrides?.reserveEvents ?? Math.min(ACP_EVENT_RETENTION_RESERVE_EVENTS, this.maxEvents);
    this.reserveBytes =
      overrides?.reserveBytes ?? Math.min(ACP_EVENT_RETENTION_RESERVE_BYTES, this.maxBytes);
    this.protocolReserveBytes =
      overrides?.protocolReserveBytes ?? ACP_PROTOCOL_RETENTION_RESERVE_BYTES;
    this.assertValidConfiguration();
  }

  classify(body: NormalizedRunnerEvent["body"]): "ordinary" | "control" {
    switch (body.kind) {
      case "message":
      case "tool_update":
      case "output":
      case "usage_update":
      case "tool_call":
      case "plan_update":
      case "terminal_output":
        return "ordinary";
      case "lifecycle":
      case "session_configuration_snapshot":
      case "session_mode_update":
      case "session_config_options_update":
      case "interaction":
      case "interaction_result":
      case "artifact":
      case "terminal":
      case "diagnostic":
        return "control";
      default: {
        // New runner event kinds require explicit retention classification.
        const _exhaustive: never = body;
        throw new Error(
          `unclassified ACP runner event kind (policy must be updated explicitly): ${(body as { kind?: string }).kind ?? "unknown"}`
        );
      }
    }
  }

  getOrdinaryEventLimit(): number {
    return Math.max(0, this.maxEvents - this.reserveEvents);
  }

  getOrdinaryByteLimit(): number {
    return Math.max(0, this.maxBytes - this.reserveBytes);
  }

  getProtocolByteLimit(maxProtocolBytes?: number): number {
    const hard = maxProtocolBytes ?? RUNNER_EVENT_RETENTION_MAX_BYTES;
    return Math.max(0, hard - this.protocolReserveBytes);
  }

  decideEventAdmission(
    body: NormalizedRunnerEvent["body"],
    encodedLen: number,
    budget: AcpRetentionBudgetSnapshot
  ): AcpEventAdmissionDecision {
    const category = this.classify(body);
    const projectedEvents = budget.eventCount + 1;
    const projectedBytes = budget.byteCount + encodedLen;

    if (category === "ordinary") {
      const ordinaryEventLimit = this.getOrdinaryEventLimit();
      const ordinaryByteLimit = this.getOrdinaryByteLimit();
      const ordinarySoftExceeded =
        budget.ordinaryEventCount >= ordinaryEventLimit ||
        budget.ordinaryByteCount >= ordinaryByteLimit ||
        budget.ordinaryEventCount + 1 > ordinaryEventLimit ||
        budget.ordinaryByteCount + encodedLen > ordinaryByteLimit;
      const futureEvidence = this.missingEvidenceBudget(budget);
      // The first drop must still have room to persist its boundary.
      const hardExceeded =
        projectedEvents + futureEvidence.eventCount > this.maxEvents ||
        projectedBytes + futureEvidence.byteCount > this.maxBytes;

      if (ordinarySoftExceeded || hardExceeded) {
        return {
          action: "drop_ordinary",
          reason: hardExceeded
            ? "total hard budget after control usage"
            : budget.ordinaryByteCount + encodedLen > ordinaryByteLimit ||
                budget.ordinaryByteCount >= ordinaryByteLimit
              ? "ordinary event bytes"
              : "ordinary event budget",
          shouldWriteBoundary: !budget.boundaryWritten
        };
      }
      return { action: "persist" };
    }

    // Non-final controls cannot consume missing final evidence budget.
    const futureEvidence =
      body.kind === "terminal"
        ? { eventCount: 0, byteCount: 0 }
        : this.missingEvidenceBudget(budget, body.kind === "artifact" ? "artifact" : undefined);
    if (
      projectedEvents + futureEvidence.eventCount > this.maxEvents ||
      projectedBytes + futureEvidence.byteCount > this.maxBytes
    ) {
      return {
        action: "hard_reject",
        reason:
          "ACP control evidence retention reserve exhausted; terminal or artifact reference cannot be persisted."
      };
    }
    return { action: "persist" };
  }

  decideProtocolAdmission(
    protocolBytes: number,
    encodedLen: number,
    flags: { boundaryWritten: boolean; protocolSoftExceeded: boolean },
    maxProtocolBytes?: number
  ): AcpProtocolAdmissionDecision {
    const soft = this.getProtocolByteLimit(maxProtocolBytes);
    if (flags.boundaryWritten || flags.protocolSoftExceeded || protocolBytes + encodedLen > soft) {
      return {
        action: "drop",
        shouldWriteBoundary: !flags.boundaryWritten,
        markSoftExceeded: true
      };
    }
    return { action: "persist" };
  }

  decideBoundaryAdmission(
    encodedLen: number,
    budget: AcpRetentionBudgetSnapshot
  ): AcpBoundaryAdmissionDecision {
    if (budget.boundaryWritten) {
      return { action: "skip", reason: "already_written" };
    }
    const futureEvidence = this.missingEvidenceBudget(budget, "boundary");
    if (
      budget.eventCount + 1 + futureEvidence.eventCount > this.maxEvents ||
      budget.byteCount + encodedLen + futureEvidence.byteCount > this.maxBytes
    ) {
      return { action: "skip", reason: "hard_exhausted" };
    }
    return { action: "persist" };
  }

  private assertValidConfiguration(): void {
    for (const [name, value] of [
      ["maxEvents", this.maxEvents],
      ["maxBytes", this.maxBytes],
      ["reserveEvents", this.reserveEvents],
      ["reserveBytes", this.reserveBytes],
      ["protocolReserveBytes", this.protocolReserveBytes]
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`ACP retention ${name} must be a non-negative safe integer.`);
      }
    }
    if (this.reserveEvents < 3 || this.reserveEvents > this.maxEvents) {
      throw new Error(
        "ACP event retention reserveEvents must fit within maxEvents and reserve boundary, artifact, and terminal slots."
      );
    }
    if (this.reserveBytes < 3 || this.reserveBytes > this.maxBytes) {
      throw new Error(
        "ACP event retention reserveBytes must fit within maxBytes and reserve boundary, artifact, and terminal bytes."
      );
    }
    if (this.evidenceByteBudgets().some((budget) => budget < RUNNER_EVENT_MAX_ENCODED_BYTES)) {
      throw new Error(
        `ACP event retention reserveBytes must provide at least ${RUNNER_EVENT_MAX_ENCODED_BYTES} encoded bytes each for boundary, artifact, and terminal evidence under the normalized event line contract.`
      );
    }
  }

  private missingEvidenceBudget(
    budget: AcpRetentionBudgetSnapshot,
    admitting?: "boundary" | "artifact"
  ): AcpFinalEvidenceBudget {
    const [boundaryBytes, artifactBytes, terminalBytes] = this.evidenceByteBudgets();
    const missingBoundary = !budget.boundaryWritten && admitting !== "boundary";
    const missingArtifact = !budget.hasArtifact && admitting !== "artifact";
    const missingTerminal = !budget.hasTerminal;
    return {
      eventCount: Number(missingBoundary) + Number(missingArtifact) + Number(missingTerminal),
      byteCount:
        (missingBoundary ? boundaryBytes : 0) +
        (missingArtifact ? artifactBytes : 0) +
        (missingTerminal ? terminalBytes : 0)
    };
  }

  private evidenceByteBudgets(): readonly [number, number, number] {
    const base = Math.floor(this.reserveBytes / 3);
    return [base, base, this.reserveBytes - base * 2];
  }
}

export function createDefaultAcpEventRetentionPolicy(
  overrides?: AcpEventRetentionPolicyOverrides
): AcpEventRetentionPolicy {
  return new DefaultAcpEventRetentionPolicy(overrides);
}

export function projectPersistedRetentionDiagnostics(
  events: readonly NormalizedRunnerEvent[]
): RunnerEventReplayDiagnostic[] {
  const diagnostics: RunnerEventReplayDiagnostic[] = [];
  for (const event of events) {
    if (event.body.kind === "diagnostic" && event.body.code === "retention_boundary") {
      diagnostics.push({
        code: "retention_boundary",
        line: null,
        message: event.body.message
      });
    }
  }
  return diagnostics;
}
