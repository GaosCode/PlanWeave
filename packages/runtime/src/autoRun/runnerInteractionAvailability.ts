import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  runnerInteractionSnapshotSchema,
  type RunnerInteractionSnapshot
} from "./runnerInteractionContract.js";
import { PersistentRunnerInteractionStore } from "./runnerInteractionStore.js";
import {
  runnerInteractionAvailabilityReasonSchema,
  runnerInteractionContractDiagnosticIssueSchema,
  runnerInteractionContractDiagnosticSchema,
  type RunnerInteractionAvailabilityReason,
  type RunnerInteractionContractDiagnostic
} from "./runnerInteractionAvailabilityContract.js";

export {
  runnerInteractionAvailabilityReasonSchema,
  runnerInteractionContractDiagnosticIssueSchema,
  runnerInteractionContractDiagnosticSchema
} from "./runnerInteractionAvailabilityContract.js";
export type {
  RunnerInteractionAvailabilityReason,
  RunnerInteractionContractDiagnostic
} from "./runnerInteractionAvailabilityContract.js";
import { agentRunControlAvailabilitySummarySchema } from "./agentRunControlAvailability.js";

export const RUNNER_OWNER_FRESHNESS_THRESHOLD_MS = 15_000;

export const runnerInteractionRunMetadataSchema = z
  .object({
    runnerKind: z.literal("acp"),
    runId: z.string().min(1),
    executorRunId: z.string().min(1).nullable().optional(),
    claimRef: z.string().min(1).optional(),
    ref: z.string().min(1).optional(),
    sessionId: z.string().min(1).nullable(),
    projectId: z.string().min(1),
    canvasId: z.string().min(1),
    ownerLeaseId: z.string().uuid(),
    ownerGeneration: z.number().int().positive(),
    controlAvailable: agentRunControlAvailabilitySummarySchema.shape.controlAvailable.optional(),
    controlProtocolVersion:
      agentRunControlAvailabilitySummarySchema.shape.controlProtocolVersion.optional(),
    controlOwnerPid: agentRunControlAvailabilitySummarySchema.shape.controlOwnerPid.optional(),
    controlUnavailableReason:
      agentRunControlAvailabilitySummarySchema.shape.controlUnavailableReason.optional(),
    status: z.enum(["running", "completed", "failed", "cancelled", "timed_out"])
  })
  .passthrough();
export type RunnerInteractionRunMetadata = z.infer<typeof runnerInteractionRunMetadataSchema>;

export const runnerOwnerHeartbeatSchema = z
  .object({
    status: z.enum(["running", "completed", "failed", "cancelled", "timed_out"]),
    pid: z.number().int().nullable(),
    startedAt: z.string().datetime(),
    lastHeartbeatAt: z.string().datetime(),
    finishedAt: z.string().datetime().nullable(),
    ownerLeaseId: z.string().uuid(),
    ownerGeneration: z.number().int().positive(),
    runnerLifecycle: z.enum(["running", "waiting_interaction", "terminal"]),
    pendingInteractionIds: z.array(z.string().min(1).max(256)),
    controlAvailable: agentRunControlAvailabilitySummarySchema.shape.controlAvailable.optional(),
    controlProtocolVersion:
      agentRunControlAvailabilitySummarySchema.shape.controlProtocolVersion.optional(),
    controlOwnerPid: agentRunControlAvailabilitySummarySchema.shape.controlOwnerPid.optional(),
    controlUnavailableReason:
      agentRunControlAvailabilitySummarySchema.shape.controlUnavailableReason.optional()
  })
  .passthrough();
export type RunnerOwnerHeartbeat = z.infer<typeof runnerOwnerHeartbeatSchema>;

export type RunnerInteractionAvailability = {
  available: boolean;
  reason: RunnerInteractionAvailabilityReason | null;
  snapshot: RunnerInteractionSnapshot | null;
};

export type RunnerInteractionAvailabilityScope = {
  projectId: string;
  canvasId: string;
};

export type RunnerInteractionMailboxProjection = {
  interactions: RunnerInteractionAvailability[];
  requestIds: ReadonlySet<string>;
  suppressAllRegistryPermissions: boolean;
  diagnostic: RunnerInteractionContractDiagnostic | null;
};

function contractDiagnostic(
  issues: RunnerInteractionContractDiagnostic["issues"]
): RunnerInteractionContractDiagnostic {
  return runnerInteractionContractDiagnosticSchema.parse({
    code: "contract_invalid",
    message: "Persisted runner interaction contract is invalid.",
    issues
  });
}

function unavailable(
  reason: RunnerInteractionAvailabilityReason,
  snapshot: RunnerInteractionSnapshot | null
): RunnerInteractionAvailability {
  return { available: false, reason, snapshot };
}

function heartbeatIsFresh(
  heartbeat: RunnerOwnerHeartbeat,
  options: { now?: () => Date; thresholdMs?: number }
): boolean {
  const thresholdMs = options.thresholdMs ?? RUNNER_OWNER_FRESHNESS_THRESHOLD_MS;
  if (!Number.isFinite(thresholdMs) || thresholdMs < 0) {
    throw new Error("Runner owner freshness threshold must be a non-negative finite number.");
  }
  return (
    (options.now ?? (() => new Date()))().getTime() - Date.parse(heartbeat.lastHeartbeatAt) <=
    thresholdMs
  );
}

export function projectRunnerInteractionAvailability(options: {
  scope: RunnerInteractionAvailabilityScope;
  metadata: unknown;
  heartbeat: unknown;
  snapshot: unknown | null;
  runTerminal?: boolean;
  now?: () => Date;
  thresholdMs?: number;
}): RunnerInteractionAvailability {
  if (options.snapshot === null) return unavailable("legacy_history", null);
  const snapshotResult = runnerInteractionSnapshotSchema.safeParse(options.snapshot);
  if (!snapshotResult.success) return unavailable("contract_invalid", null);
  const snapshot = snapshotResult.data;
  const metadataResult = runnerInteractionRunMetadataSchema.safeParse(options.metadata);
  const heartbeatResult = runnerOwnerHeartbeatSchema.safeParse(options.heartbeat);
  if (!metadataResult.success || !heartbeatResult.success) {
    return unavailable("contract_invalid", snapshot);
  }
  const metadata = metadataResult.data;
  const heartbeat = heartbeatResult.data;
  if (snapshot.status === "answered") return unavailable("answered", snapshot);
  if (snapshot.status === "expired") return unavailable("expired", snapshot);
  const identity = snapshot.request.identity;
  const claimRef = metadata.claimRef ?? metadata.ref;
  const identityMatches =
    options.scope.projectId === identity.projectId &&
    options.scope.canvasId === identity.canvasId &&
    metadata.projectId === identity.projectId &&
    metadata.canvasId === identity.canvasId &&
    metadata.runId === identity.executorRunId &&
    (metadata.executorRunId == null || metadata.executorRunId === identity.executorRunId) &&
    claimRef === identity.claimRef &&
    metadata.sessionId === identity.sessionId;
  if (!identityMatches) return unavailable("contract_invalid", snapshot);
  const ownerMatches =
    metadata.ownerLeaseId === identity.ownerLeaseId &&
    metadata.ownerGeneration === identity.ownerGeneration &&
    heartbeat.ownerLeaseId === identity.ownerLeaseId &&
    heartbeat.ownerGeneration === identity.ownerGeneration;
  if (!ownerMatches) return unavailable("owner_replaced", snapshot);
  if (
    options.runTerminal === true ||
    metadata.status !== "running" ||
    heartbeat.status !== "running" ||
    heartbeat.runnerLifecycle === "terminal"
  ) {
    return unavailable("run_terminal", snapshot);
  }
  if (
    !heartbeat.pendingInteractionIds.includes(identity.requestId) ||
    !heartbeatIsFresh(heartbeat, { now: options.now, thresholdMs: options.thresholdMs })
  ) {
    return unavailable("owner_unavailable", snapshot);
  }
  return { available: true, reason: null, snapshot };
}

export async function readRunnerInteractionMailboxProjection(options: {
  runDir: string;
  scope: RunnerInteractionAvailabilityScope;
  metadata: unknown;
  runTerminal?: boolean;
  now?: () => Date;
  thresholdMs?: number;
}): Promise<RunnerInteractionMailboxProjection> {
  let snapshots: RunnerInteractionSnapshot[] = [];
  const issues: RunnerInteractionContractDiagnostic["issues"] = [];
  try {
    snapshots = await new PersistentRunnerInteractionStore(options.runDir).listSnapshots();
  } catch {
    issues.push({ source: "mailbox", message: "Mailbox snapshot JSON or schema is invalid." });
  }
  if (snapshots.length === 0 && issues.length === 0) {
    return {
      interactions: [],
      requestIds: new Set(),
      suppressAllRegistryPermissions: false,
      diagnostic: null
    };
  }
  let metadataInput = options.metadata;
  try {
    const rawMetadata = await readFile(join(options.runDir, "metadata.json"), "utf8");
    try {
      metadataInput = JSON.parse(rawMetadata);
    } catch {
      issues.push({ source: "metadata", message: "Run metadata JSON is invalid." });
      metadataInput = null;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      issues.push({ source: "metadata", message: "Run metadata JSON could not be read." });
      metadataInput = null;
    }
  }
  const metadataResult = runnerInteractionRunMetadataSchema.safeParse(metadataInput);
  if (!metadataResult.success) {
    if (!issues.some(({ source }) => source === "metadata")) {
      issues.push({ source: "metadata", message: "Run metadata schema is invalid." });
    }
  }
  let heartbeatInput: unknown;
  try {
    heartbeatInput = JSON.parse(await readFile(join(options.runDir, "heartbeat.json"), "utf8"));
  } catch {
    issues.push({ source: "heartbeat", message: "Owner heartbeat JSON is invalid." });
    heartbeatInput = null;
  }
  const heartbeatResult = runnerOwnerHeartbeatSchema.safeParse(heartbeatInput);
  if (!heartbeatResult.success && !issues.some(({ source }) => source === "heartbeat")) {
    issues.push({ source: "heartbeat", message: "Owner heartbeat schema is invalid." });
  }
  const metadata = metadataResult.success ? metadataResult.data : metadataInput;
  const heartbeat = heartbeatResult.success ? heartbeatResult.data : heartbeatInput;
  const interactions = snapshots.map((snapshot) =>
    projectRunnerInteractionAvailability({
      scope: options.scope,
      metadata,
      heartbeat,
      snapshot,
      runTerminal: options.runTerminal,
      now: options.now,
      thresholdMs: options.thresholdMs
    })
  );
  if (interactions.some(({ reason }) => reason === "contract_invalid") && issues.length === 0) {
    issues.push({ source: "mailbox", message: "Mailbox identity contract is invalid." });
  }
  return {
    interactions,
    requestIds: new Set(snapshots.map((snapshot) => snapshot.request.identity.requestId)),
    suppressAllRegistryPermissions: issues.length > 0,
    diagnostic: issues.length > 0 ? contractDiagnostic(issues) : null
  };
}
