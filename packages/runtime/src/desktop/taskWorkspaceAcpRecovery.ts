import { dirname } from "node:path";
import { z } from "zod";
import {
  acpLaunchIdentitySchema,
  acpRecoveryInterruptionReasonSchema,
  acpRunRecoveryExecutionSchema,
  acpRunRecoveryLineageSchema,
  evaluateAcpRunRecovery,
  type AcpRunRecoveryUnavailableReason
} from "../autoRun/acpRunRecovery.js";
import { projectAcpRecoveryToolSummary } from "../autoRun/acpRecoveryToolSummary.js";
import { listExecutorProfiles, resolveExecutorAcpExecutionProfile } from "../autoRun/executors.js";
import { withCanvasLock } from "../fs/withCanvasLock.js";
import { unblockBlock } from "../taskManager/blockStatusMutations.js";
import { loadRuntimeReadonly } from "../taskManager/runtimeContext.js";
import {
  blockDependenciesCompleted,
  getBlock,
  requireBlockState
} from "../taskManager/selectors.js";
import { resolveTaskCanvasWorkspace } from "./canvasApi.js";
import { getRunRecord, listBlockMainRunRecords } from "./recordsApi.js";
import {
  hasNonTerminalAutoRunForTarget,
  initializeAutoRunUnderCanvasLock,
  launchInitializedAutoRun
} from "./runApi.js";
import { canonicalTaskWorkspaceRunIdentity } from "./taskWorkspaceRetry.js";
import { executionHostSchema, type ProjectWorkspace } from "../types.js";
import type { DesktopRunRecord } from "./types/recordsTypes.js";
import { AcpProfileResolutionError } from "../acpProfile/resolver.js";
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
    executionHost: executionHostSchema.optional(),
    acpLaunch: acpLaunchIdentitySchema.optional(),
    acpProfile: z
      .object({
        profileId: z.string().min(1),
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        source: z.enum(["builtin", "local-user"]),
        host: executionHostSchema,
        launch: acpLaunchIdentitySchema.optional()
      })
      .passthrough()
      .superRefine((profile, context) => {
        if (profile.source === "local-user" && profile.launch !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["launch"],
            message: "Local ACP recovery metadata must not contain launch details."
          });
        }
      }),
    capabilities: z.object({ loadSession: z.literal(true) }).passthrough(),
    recoveryInterruptionReason: acpRecoveryInterruptionReasonSchema.nullable(),
    recovery: acpRunRecoveryLineageSchema.nullable()
  })
  .passthrough()
  .superRefine((metadata, context) => {
    if (metadata.acpProfile.source === "local-user" && metadata.acpLaunch !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["acpLaunch"],
        message: "Local ACP recovery metadata must not contain launch details."
      });
    }
  });

const messages: Record<AcpRunRecoveryUnavailableReason, string> = {
  not_latest_main_run: "Recovery is available only for the latest primary Block run.",
  runner_not_acp: "Recovery requires an ACP source run.",
  source_not_terminal: "Recovery requires a terminal source run.",
  terminal_reason_not_recoverable: "The source run did not end for a recoverable interruption.",
  source_identity_invalid: "The source run identity is incomplete or inconsistent.",
  legacy_profile_identity_unavailable:
    "The source ACP run predates persisted profile identity and cannot be recovered safely.",
  profile_unavailable: "The source ACP profile is no longer registered.",
  profile_untrusted: "The source ACP profile command is not trusted for this project.",
  profile_environment_missing: "The source ACP profile is missing required environment variables.",
  profile_host_unavailable: "The source ACP profile execution host is unavailable.",
  profile_resolution_failed: "The source ACP profile could not be resolved safely.",
  session_unavailable: "The source ACP session id is unavailable.",
  agent_mismatch: "The configured Agent no longer matches the source run.",
  executor_profile_mismatch: "The effective executor profile no longer matches the source run.",
  profile_id_mismatch: "The configured ACP profile no longer matches the source run.",
  profile_fingerprint_mismatch:
    "The configured ACP profile changed after the source run was created.",
  execution_host_mismatch:
    "The configured execution host or WSL distribution no longer matches the source run.",
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

export function acpProfileResolutionRecoveryReason(
  error: unknown
): AcpRunRecoveryUnavailableReason {
  if (error instanceof AcpProfileResolutionError) {
    if (error.code === "profile_unavailable") return "profile_unavailable";
    if (error.code === "profile_untrusted") return "profile_untrusted";
    if (error.code === "profile_environment_missing") return "profile_environment_missing";
    if (error.code === "profile_host_unavailable") return "profile_host_unavailable";
    if (error.code === "profile_changed") return "profile_fingerprint_mismatch";
  }
  return "profile_resolution_failed";
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
  if (
    options.record.metadata.runnerKind === "acp" &&
    (!("acpProfile" in options.record.metadata) || options.record.metadata.acpProfile == null)
  ) {
    return unavailable("legacy_profile_identity_unavailable");
  }
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
  const source = metadata.success ? metadata.data : null;
  const profile = source?.executorProfile
    ? (await listExecutorProfiles({ projectRoot: options.workspace })).find(
        (candidate) => candidate.name === source.executorProfile
      )
    : undefined;
  let resolved: Awaited<ReturnType<typeof resolveExecutorAcpExecutionProfile>> | null = null;
  if (source?.executorProfile && profile?.runnerKind === "acp") {
    try {
      resolved = await resolveExecutorAcpExecutionProfile({
        projectRoot: options.workspace,
        executorName: source.executorProfile
      });
    } catch (error) {
      return unavailable(acpProfileResolutionRecoveryReason(error));
    }
  }
  const resolvedLaunch = resolved ? acpLaunchIdentitySchema.parse(resolved.profile.launch) : null;
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
    resolvedExecutorProfile: profile?.name ?? null,
    sourceProfileId: source?.acpProfile.profileId ?? null,
    resolvedProfileId: resolved?.profile.profileId ?? null,
    sourceProfileFingerprint: source?.acpProfile.fingerprint ?? null,
    resolvedProfileFingerprint: resolved?.profile.fingerprint ?? null,
    sourceExecutionHost: source?.executionHost ?? { kind: "native" },
    resolvedExecutionHost: resolved?.profile.host ?? null,
    sourceLaunch: source?.acpProfile.source === "builtin" ? (source.acpLaunch ?? null) : null,
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
      profileId: source.acpProfile.profileId,
      profileFingerprint: source.acpProfile.fingerprint,
      executorProfile: source.executorProfile
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
        // claimRef is graph-validated above; missing state is corruption, not planned.
        status: requireBlockState(context.state, identity.claimRef).status,
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
      profileId: identity.profileId,
      profileFingerprint: identity.profileFingerprint,
      executorProfile: identity.executorProfile,
      executionHost: metadata.executionHost ?? { kind: "native" },
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
          acpRecovery: recoveryExecution,
          executorOverride: identity.executorProfile
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
