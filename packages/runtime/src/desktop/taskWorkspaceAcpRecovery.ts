import { dirname } from "node:path";
import { z } from "zod";
import {
  acpLaunchIdentitySchema,
  acpRecoveryInterruptionReasonSchema,
  acpRunRecoveryExecutionSchema,
  acpRunRecoveryLineageSchema,
  evaluateAcpRunRecovery,
  type AcpLaunchIdentity,
  type AcpRunRecoveryUnavailableReason
} from "../autoRun/acpRunRecovery.js";
import { projectAcpRecoveryToolSummary } from "../autoRun/acpRecoveryToolSummary.js";
import { listExecutorProfiles } from "../autoRun/executors.js";
import { withCanvasLock } from "../fs/withCanvasLock.js";
import { unblockBlock } from "../taskManager/blockStatusMutations.js";
import { loadRuntimeReadonly } from "../taskManager/runtimeContext.js";
import { blockDependenciesCompleted, getBlock } from "../taskManager/selectors.js";
import { resolveTaskCanvasWorkspace } from "./canvasApi.js";
import { getRunRecord, listBlockMainRunRecords } from "./recordsApi.js";
import {
  hasNonTerminalAutoRunForTarget,
  initializeAutoRunUnderCanvasLock,
  launchInitializedAutoRun
} from "./runApi.js";
import { canonicalTaskWorkspaceRunIdentity } from "./taskWorkspaceRetry.js";
import type { ProjectWorkspace } from "../types.js";
import type { DesktopRunRecord } from "./types/recordsTypes.js";
import {
  taskWorkspaceAcpRecoveryIdentitySchema,
  type TaskWorkspaceAcpRecoveryCapability,
  type TaskWorkspaceAcpRecoveryIdentity
} from "./types/taskWorkspaceTypes.js";

const sourceMetadataSchema = z
  .object({
    runnerKind: z.literal("acp"),
    runId: z.string().min(1),
    sessionId: z.string().min(1),
    agentId: z.string().min(1),
    executorProfile: z.string().min(1),
    acpLaunch: acpLaunchIdentitySchema,
    capabilities: z.object({ loadSession: z.literal(true) }).passthrough(),
    recoveryInterruptionReason: acpRecoveryInterruptionReasonSchema.nullable(),
    recovery: acpRunRecoveryLineageSchema.nullable()
  })
  .passthrough();

const messages: Record<AcpRunRecoveryUnavailableReason, string> = {
  not_latest_main_run: "Recovery is available only for the latest primary Block run.",
  runner_not_acp: "Recovery requires an ACP source run.",
  source_not_terminal: "Recovery requires a terminal source run.",
  terminal_reason_not_recoverable: "The source run did not end for a recoverable interruption.",
  source_identity_invalid: "The source run identity is incomplete or inconsistent.",
  session_unavailable: "The source ACP session id is unavailable.",
  agent_mismatch: "The configured Agent no longer matches the source run.",
  executor_profile_mismatch: "The effective executor profile no longer matches the source run.",
  launch_mismatch: "The configured ACP launch no longer matches the source run.",
  load_session_unavailable: "The source or current Agent does not support session/load.",
  block_not_blocked: "Recovery requires the Block to remain blocked.",
  dependencies_incomplete: "Recovery requires every Block dependency to be completed.",
  active_run_exists: "Recovery is unavailable while an Auto Run is active or resumable.",
  newer_recovery_exists: "A newer recovery attempt already exists for this source run.",
  interactions_pending: "Source interactions must be settled before recovery."
};

function unavailable(code: AcpRunRecoveryUnavailableReason): TaskWorkspaceAcpRecoveryCapability {
  return { available: false, reason: { code, message: messages[code] }, identity: null };
}

function terminalMatchesInterruption(
  terminal: Extract<
    NonNullable<DesktopRunRecord["runnerReadModel"]>["events"][number]["body"],
    { kind: "terminal" }
  >,
  interruption: z.infer<typeof acpRecoveryInterruptionReasonSchema>
): boolean {
  if (interruption === "timed_out") return terminal.outcome.reason === "timed_out";
  if (interruption === "recoverable_cancel") return terminal.outcome.state === "cancelled";
  return terminal.outcome.state === "failed";
}

export async function evaluateTaskWorkspaceAcpRecovery(options: {
  workspace: ProjectWorkspace;
  canvasId: string;
  taskId: string;
  block: { ref: string; blockId: string; status: string; effectiveExecutor: string | null };
  record: DesktopRunRecord;
  selectedRecordId: string | null;
  latestRecordId: string | null;
  hasActiveRun: boolean;
  dependenciesSatisfied: boolean;
  newerRecoveryChild: boolean;
}): Promise<TaskWorkspaceAcpRecoveryCapability> {
  const metadata = sourceMetadataSchema.safeParse(options.record.metadata);
  const terminal = [...(options.record.runnerReadModel?.events ?? [])]
    .reverse()
    .find((event) => event.body.kind === "terminal");
  let sourceIdentityValid = true;
  try {
    canonicalTaskWorkspaceRunIdentity({
      workspace: options.workspace,
      canvasId: options.canvasId,
      record: options.record
    });
  } catch {
    sourceIdentityValid = false;
  }
  const profile = options.block.effectiveExecutor
    ? (await listExecutorProfiles({ projectRoot: options.workspace })).find(
        (candidate) => candidate.name === options.block.effectiveExecutor
      )
    : undefined;
  const resolvedLaunch =
    profile?.runnerKind === "acp" && profile.acpLaunch
      ? acpLaunchIdentitySchema.parse({
          command: profile.acpLaunch.command,
          args: profile.acpLaunch.args
        })
      : null;
  const source = metadata.success ? metadata.data : null;
  sourceIdentityValid =
    sourceIdentityValid &&
    (source === null ||
      terminal?.body.kind !== "terminal" ||
      source.recoveryInterruptionReason === null ||
      terminalMatchesInterruption(terminal.body, source.recoveryInterruptionReason));
  const eligibility = evaluateAcpRunRecovery({
    latestMainRun:
      options.record.recordId === options.selectedRecordId &&
      options.record.recordId === options.latestRecordId &&
      source?.recovery === null,
    runnerKind: source?.runnerKind ?? null,
    terminal: terminal?.body.kind === "terminal",
    interruptionReason: source?.recoveryInterruptionReason ?? null,
    sourceIdentityValid,
    sessionId: source?.sessionId ?? null,
    sourceAgentId: source?.agentId ?? null,
    resolvedAgentId: profile?.agentId ?? null,
    sourceExecutorProfile: source?.executorProfile ?? null,
    resolvedExecutorProfile: options.block.effectiveExecutor,
    sourceLaunch: source?.acpLaunch ?? null,
    resolvedLaunch,
    loadSessionAvailable:
      source?.capabilities.loadSession === true &&
      profile?.runnerKind === "acp" &&
      profile.optionalCapabilities?.includes("history-load") === true,
    blockStatus: options.block.status,
    dependenciesCompleted: options.dependenciesSatisfied,
    activeOrResumableRun: options.hasActiveRun,
    newerRecoveryChild: options.newerRecoveryChild,
    interactionsSettled:
      (options.record.runnerReadModel?.interaction.activeRequests.length ?? 0) === 0
  });
  if (!(eligibility.available && source && terminal) || terminal.body.kind !== "terminal") {
    return unavailable(eligibility.available ? "source_identity_invalid" : eligibility.reason);
  }
  return {
    available: true,
    reason: null,
    identity: taskWorkspaceAcpRecoveryIdentitySchema.parse({
      version: "planweave.task-workspace-acp-recovery/v1",
      projectId: options.workspace.id,
      projectRoot: options.workspace.rootPath,
      canvasId: options.canvasId,
      taskId: options.taskId,
      blockId: options.block.blockId,
      claimRef: options.block.ref,
      recordId: options.record.recordId,
      runId: options.record.runId,
      sessionId: source.sessionId,
      terminalEventSequence: terminal.sequence,
      agentId: source.agentId,
      executorProfile: source.executorProfile,
      launch: source.acpLaunch
    })
  };
}

function sameIdentity(
  left: TaskWorkspaceAcpRecoveryIdentity,
  right: TaskWorkspaceAcpRecoveryIdentity
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function recoverTaskWorkspaceAcpRun(
  rawIdentity: TaskWorkspaceAcpRecoveryIdentity,
  audit: { source: string; reason: string }
) {
  const identity = taskWorkspaceAcpRecoveryIdentitySchema.parse(rawIdentity);
  const requestedBy = z.string().min(1).max(128).parse(audit.source);
  const reason = z.string().min(1).max(4096).parse(audit.reason);
  const workspace = await resolveTaskCanvasWorkspace(identity.projectRoot, identity.canvasId);
  const state = await withCanvasLock(dirname(workspace.stateFile), async () => {
    const context = await loadRuntimeReadonly({ projectRoot: workspace });
    const block = getBlock(context.graph, identity.claimRef);
    if (
      context.workspace.id !== identity.projectId ||
      context.workspace.rootPath !== identity.projectRoot
    ) {
      throw new Error("ACP recovery identity no longer matches the requested workspace.");
    }
    if (
      context.graph.blockTaskByRef.get(identity.claimRef) !== identity.taskId ||
      block.id !== identity.blockId
    ) {
      throw new Error("ACP recovery identity no longer matches an existing Block.");
    }
    const summaries = await listBlockMainRunRecords(workspace, identity.claimRef);
    const record = await getRunRecord(workspace, identity.recordId);
    const newerRecoveryChild = summaries.some((summary) => {
      if (summary.recordId === identity.recordId) return false;
      return summary.runId.localeCompare(identity.runId, undefined, { numeric: true }) > 0;
    });
    const capability = await evaluateTaskWorkspaceAcpRecovery({
      workspace: context.workspace,
      canvasId: identity.canvasId,
      taskId: identity.taskId,
      block: {
        ref: identity.claimRef,
        blockId: identity.blockId,
        status: context.state.blocks[identity.claimRef]?.status ?? "planned",
        effectiveExecutor:
          block.executor ??
          context.graph.tasksById.get(identity.taskId)?.executor ??
          context.manifest.execution.defaultExecutor ??
          "default"
      },
      record,
      selectedRecordId: identity.recordId,
      latestRecordId: summaries[0]?.recordId ?? null,
      hasActiveRun: await hasNonTerminalAutoRunForTarget(identity.projectRoot, identity.canvasId),
      dependenciesSatisfied: blockDependenciesCompleted(
        context.graph,
        context.state,
        identity.claimRef
      ),
      newerRecoveryChild
    });
    if (!capability.available || capability.identity === null) {
      throw new Error(capability.reason?.message ?? "ACP recovery is unavailable.");
    }
    if (!sameIdentity(capability.identity, identity)) {
      throw new Error("ACP recovery capability identity no longer matches the source run.");
    }
    const metadata = sourceMetadataSchema.parse(record.metadata);
    const lineage = acpRunRecoveryLineageSchema.parse({
      version: "planweave.acp-recovery/v1",
      kind: "session_load",
      sourceRecordId: identity.recordId,
      sourceRunId: identity.runId,
      sourceSessionId: identity.sessionId,
      sourceTerminalEventSequence: identity.terminalEventSequence,
      requestedAt: new Date().toISOString(),
      requestedBy
    });
    const recoveryExecution = acpRunRecoveryExecutionSchema.parse({
      lineage,
      claimRef: identity.claimRef,
      agentId: identity.agentId,
      executorProfile: identity.executorProfile,
      launch: identity.launch,
      interruptionReason: metadata.recoveryInterruptionReason,
      lastToolStateSummary: projectAcpRecoveryToolSummary(record)
    });
    await unblockBlock({
      projectRoot: workspace,
      ref: identity.claimRef,
      reason: `ACP recovery requested by '${requestedBy}': ${reason}`
    });
    try {
      return await initializeAutoRunUnderCanvasLock(
        workspace,
        identity.projectRoot,
        identity.canvasId,
        { kind: "block", blockRef: identity.claimRef },
        20,
        {
          acpRecovery: recoveryExecution
        }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `ACP recovery unblocked '${identity.claimRef}', but starting the recovery Auto Run failed. The Block remains ready: ${message}`,
        { cause: error }
      );
    }
  });
  launchInitializedAutoRun(state.runId);
  return state;
}
