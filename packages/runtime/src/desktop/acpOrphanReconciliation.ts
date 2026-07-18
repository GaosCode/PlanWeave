import { dirname, join } from "node:path";
import { createConnection } from "node:net";
import { z } from "zod";
import { AcpEventStore } from "../autoRun/acpEventStore.js";
import { AcpOwnerWriteFence } from "../autoRun/acpOwnerWriteFence.js";
import { activeAgentRunRegistry } from "../autoRun/activeAgentRunRegistry.js";
import { readAgentRunControlDescriptor } from "../autoRun/agentRunControlEndpoint.js";
import { unavailableAgentRunControlSummary } from "../autoRun/agentRunControlAvailability.js";
import { PersistentRunnerInteractionStore } from "../autoRun/runnerInteractionStore.js";
import {
  RUNNER_OWNER_FRESHNESS_THRESHOLD_MS,
  runnerInteractionRunMetadataSchema,
  runnerOwnerHeartbeatSchema
} from "../autoRun/runnerInteractionAvailability.js";
import { runnerIdentitySchema } from "../autoRun/runnerContractSchemas.js";
import { projectRunnerNextActions } from "../autoRun/runnerNextActions.js";
import { withCanvasLock } from "../fs/withCanvasLock.js";
import { readJsonFile, writeJsonFile } from "../json.js";
import { markBlockBlocked } from "../taskManager/blockStatusMutations.js";
import { resolveTaskCanvasWorkspace } from "./canvasApi.js";
import { getRunRecord, listBlockMainRunRecords } from "./recordsApi.js";
import { recoverPersistedAutoRunState } from "./runRecovery.js";
import { readRawPersistedAutoRunState, writePersistedAutoRunState } from "./runStatePersistence.js";
import { canonicalTaskWorkspaceRunIdentity } from "./taskWorkspaceRetry.js";
import type { ProjectWorkspace } from "../types.js";
import type { DesktopRunRecord } from "./types/recordsTypes.js";

const orphanMetadataSchema = runnerInteractionRunMetadataSchema
  .extend({
    agentId: z.string().min(1),
    capabilities: z.object({ loadSession: z.boolean() }).passthrough(),
    recoveryInterruptionReason: z
      .enum(["owner_lost", "transport_lost", "timed_out", "recoverable_cancel"])
      .nullable(),
    desktopRunId: z.string().min(1).nullable().optional(),
    runSessionId: z.string().min(1).nullable().optional()
  })
  .passthrough();

export type AcpOrphanReconciliationResult = {
  status: "not_applicable" | "owner_active" | "reconciled" | "already_reconciled";
  recordId: string;
};

function ownerIsStale(lastHeartbeatAt: string, now: Date, thresholdMs: number): boolean {
  if (!Number.isFinite(thresholdMs) || thresholdMs < 0) {
    throw new Error("Runner owner freshness threshold must be a non-negative finite number.");
  }
  return now.getTime() - Date.parse(lastHeartbeatAt) > thresholdMs;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function controlEndpointAcceptsConnections(address: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(address);
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(false), 250);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function ownerIsProvablyAbsent(options: {
  runDir: string;
  metadata: z.infer<typeof orphanMetadataSchema>;
  heartbeat: z.infer<typeof runnerOwnerHeartbeatSchema>;
  isPidAlive: (pid: number) => boolean;
  probeControlEndpoint: (address: string) => Promise<boolean>;
}): Promise<boolean> {
  let descriptor: Awaited<ReturnType<typeof readAgentRunControlDescriptor>>;
  try {
    descriptor = await readAgentRunControlDescriptor(options.runDir);
  } catch {
    return false;
  }
  const ownerPid = options.metadata.controlOwnerPid;
  if (
    descriptor === null ||
    options.metadata.controlAvailable !== true ||
    options.heartbeat.controlAvailable !== true ||
    ownerPid === undefined ||
    options.heartbeat.controlOwnerPid !== ownerPid ||
    descriptor.ownerPid !== ownerPid ||
    descriptor.leaseId !== options.metadata.ownerLeaseId
  ) {
    return false;
  }
  if (options.isPidAlive(ownerPid)) return false;
  return !(await options.probeControlEndpoint(descriptor.address));
}

async function synchronizeInterruptedAutoRun(
  workspace: ProjectWorkspace,
  record: DesktopRunRecord,
  desktopRunId: string | null | undefined
): Promise<void> {
  if (!desktopRunId) return;
  const autoRun = await readRawPersistedAutoRunState(workspace, desktopRunId);
  if (autoRun?.latestRecordId === record.recordId) {
    await writePersistedAutoRunState(recoverPersistedAutoRunState(autoRun, false));
  }
}

export async function reconcileOrphanedAcpRun(options: {
  projectRoot: string;
  canvasId: string;
  recordId: string;
  now?: Date;
  freshnessThresholdMs?: number;
}, dependencies: {
  isPidAlive?: (pid: number) => boolean;
  probeControlEndpoint?: (address: string) => Promise<boolean>;
  createEventStore?: (options: ConstructorParameters<typeof AcpEventStore>[0]) => AcpEventStore;
} = {}): Promise<AcpOrphanReconciliationResult> {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("ACP orphan reconciliation now is invalid.");
  const thresholdMs = options.freshnessThresholdMs ?? RUNNER_OWNER_FRESHNESS_THRESHOLD_MS;
  const workspace = await resolveTaskCanvasWorkspace(options.projectRoot, options.canvasId);
  return withCanvasLock(dirname(workspace.stateFile), async () => {
    const record = await getRunRecord(workspace, options.recordId);
    const latest = (await listBlockMainRunRecords(workspace, record.ref))[0];
    if (latest?.recordId !== record.recordId || record.runnerReadModel === null) {
      return { status: "not_applicable", recordId: record.recordId };
    }
    const metadataInput = await readJsonFile<unknown>(record.metadataPath);
    const metadataResult = orphanMetadataSchema.safeParse(metadataInput);
    if (!metadataResult.success) return { status: "not_applicable", recordId: record.recordId };
    const metadata = metadataResult.data;
    const continuing =
      metadata.status === "failed" && metadata.recoveryInterruptionReason === "owner_lost";
    if (metadata.status !== "running" && !continuing) {
      return { status: "not_applicable", recordId: record.recordId };
    }
    const runDir = dirname(record.metadataPath);
    const heartbeatPath = record.heartbeatPath ?? join(runDir, "heartbeat.json");
    const heartbeat = runnerOwnerHeartbeatSchema.parse(await readJsonFile<unknown>(heartbeatPath));
    if (
      heartbeat.ownerLeaseId !== metadata.ownerLeaseId ||
      heartbeat.ownerGeneration !== metadata.ownerGeneration
    ) {
      throw new Error("ACP orphan reconciliation rejected mismatched persisted owner identity.");
    }
    const identity = canonicalTaskWorkspaceRunIdentity({
      workspace,
      canvasId: options.canvasId,
      record
    });
    const active = activeAgentRunRegistry.lookupExact({
      scope: runDir,
      executorRunId: record.runId,
      claimRef: identity.claimRef,
      ...(identity.desktopRunId ? { desktopRunId: identity.desktopRunId } : {}),
      ...(identity.runSessionId ? { runSessionId: identity.runSessionId } : {}),
      ...(metadata.sessionId ? { sessionId: metadata.sessionId } : {})
    });
    if (
      active !== null ||
      (!continuing && !ownerIsStale(heartbeat.lastHeartbeatAt, now, thresholdMs))
    ) {
      return { status: "owner_active", recordId: record.recordId };
    }
    const fence = new AcpOwnerWriteFence(
      runDir,
      metadata.ownerLeaseId,
      metadata.ownerGeneration
    );
    if (continuing && !(await fence.isClaimed())) {
      return { status: "not_applicable", recordId: record.recordId };
    }
    if (!continuing) {
      const provablyAbsent = await ownerIsProvablyAbsent({
        runDir,
        metadata,
        heartbeat,
        isPidAlive: dependencies.isPidAlive ?? pidIsAlive,
        probeControlEndpoint: dependencies.probeControlEndpoint ?? controlEndpointAcceptsConnections
      });
      if (!provablyAbsent) return { status: "owner_active", recordId: record.recordId };
      const claimed = await fence.claimAfter(async () => {
        const currentMetadata = orphanMetadataSchema.safeParse(
          await readJsonFile<unknown>(record.metadataPath)
        );
        const currentHeartbeat = runnerOwnerHeartbeatSchema.safeParse(
          await readJsonFile<unknown>(heartbeatPath)
        );
        if (!currentMetadata.success || !currentHeartbeat.success) return false;
        if (
          currentMetadata.data.status !== "running" ||
          !ownerIsStale(currentHeartbeat.data.lastHeartbeatAt, now, thresholdMs)
        ) {
          return false;
        }
        return ownerIsProvablyAbsent({
          runDir,
          metadata: currentMetadata.data,
          heartbeat: currentHeartbeat.data,
          isPidAlive: dependencies.isPidAlive ?? pidIsAlive,
          probeControlEndpoint:
            dependencies.probeControlEndpoint ?? controlEndpointAcceptsConnections
        });
      }, now.toISOString());
      if (!claimed) return { status: "owner_active", recordId: record.recordId };
    }
    if (
      continuing &&
      record.runnerReadModel.events.some((event) => event.body.kind === "terminal")
    ) {
      await markBlockBlocked({
        projectRoot: workspace,
        ref: record.ref,
        reason: "ACP owner process was lost before the run reached a terminal state."
      });
      await synchronizeInterruptedAutoRun(workspace, record, metadata.desktopRunId);
      return { status: "already_reconciled", recordId: record.recordId };
    }

    const interactionStore = new PersistentRunnerInteractionStore(runDir);
    const pending = (await interactionStore.listSnapshots()).filter(
      (snapshot) => snapshot.status === "pending"
    );
    for (const snapshot of pending) {
      await interactionStore.settleOwnerResult({
        version: "planweave.runner-interaction-owner-result/v1",
        identity: snapshot.request.identity,
        outcome: "expired",
        reason: "terminal_cleanup",
        recordedAt: now.toISOString(),
        message: "The ACP owner process was lost; this interaction lease is no longer valid."
      });
    }
    const settledInteractions = (await interactionStore.listSnapshots()).filter(
      (snapshot) =>
        snapshot.status === "expired" && snapshot.ownerResult?.reason === "terminal_cleanup"
    );

    const terminalControl = unavailableAgentRunControlSummary("owner_terminal");
    const terminalOwner = {
      ownerLeaseId: metadata.ownerLeaseId,
      ownerGeneration: metadata.ownerGeneration,
      runnerLifecycle: "terminal" as const,
      pendingInteractionIds: [] as string[]
    };
    await writeJsonFile(record.metadataPath, {
      ...metadata,
      status: "failed",
      outcome: "failed",
      finishedAt: now.toISOString(),
      ...terminalOwner,
      ...terminalControl,
      failureReason: "ACP owner process heartbeat expired before the run reached a terminal state.",
      recoveryInterruptionReason: "owner_lost",
      exitCode: 1
    });
    await writeJsonFile(heartbeatPath, {
      ...heartbeat,
      status: "failed",
      finishedAt: now.toISOString(),
      lastHeartbeatAt: now.toISOString(),
      ...terminalOwner,
      ...terminalControl,
      failureReason: "ACP owner process heartbeat expired before the run reached a terminal state.",
      recoveryInterruptionReason: "owner_lost",
      exitCode: 1
    });

    const eventStore = (dependencies.createEventStore ?? ((storeOptions) => new AcpEventStore(storeOptions)))({
      runDir,
      identity,
      runner: runnerIdentitySchema.parse({
        version: "planweave.runner/v1",
        runnerKind: "acp",
        agentId: metadata.agentId
      })
    });
    await eventStore.open();
    const existingEvents = eventStore.snapshot().events;
    if (!existingEvents.some((event) => event.body.kind === "terminal")) {
      const recordedInteractionIds = new Set(
        existingEvents.flatMap((event) =>
          event.body.kind === "interaction_result" ? [event.body.interactionId] : []
        )
      );
      for (const snapshot of settledInteractions) {
        if (recordedInteractionIds.has(snapshot.interactionId)) continue;
        await eventStore.append({
          kind: "interaction_result",
          requestId: snapshot.request.identity.requestId,
          interactionId: snapshot.interactionId,
          interactionKind: snapshot.request.kind,
          outcome: "expired",
          message: "The source interaction expired when its ACP owner process was lost."
        });
      }
      const confirmedEvents = eventStore.snapshot().events;
      const confirmedInteractionIds = new Set(
        confirmedEvents.flatMap((event) =>
          event.body.kind === "interaction_result" ? [event.body.interactionId] : []
        )
      );
      if (settledInteractions.some((snapshot) => !confirmedInteractionIds.has(snapshot.interactionId))) {
        throw new Error("ACP orphan reconciliation cannot terminalize before all interaction results are durable.");
      }
      await eventStore.append({
        kind: "diagnostic",
        code: "terminal_cleanup",
        message: "ACP owner process heartbeat expired; PlanWeave reconciled the orphaned run."
      });
      await eventStore.append({
        kind: "terminal",
        outcome: {
          version: "planweave.runner/v1",
          state: "failed",
          reason: "failed",
          cleanup: { status: "succeeded" },
          exitCode: 1,
          finishedAt: now.toISOString(),
          diagnostic:
            "ACP owner process heartbeat expired before the run reached a terminal state.",
          artifactValidated: false,
          nextActions: projectRunnerNextActions({
            sourceRecordId: record.recordId,
            sourceRunId: record.runId,
            recoverAcpSession:
              metadata.sessionId !== null && metadata.capabilities.loadSession === true,
            retryNewSession: true
          })
        }
      });
      await eventStore.drain();
    }

    await markBlockBlocked({
      projectRoot: workspace,
      ref: record.ref,
      reason: "ACP owner process was lost before the run reached a terminal state."
    });
    await synchronizeInterruptedAutoRun(workspace, record, metadata.desktopRunId);
    return { status: continuing ? "already_reconciled" : "reconciled", recordId: record.recordId };
  });
}
