import type { TaskWorkspace, TaskWorkspaceBlock } from "@planweave-ai/runtime";
import { taskWorkspaceRunItemSchema } from "@planweave-ai/runtime/browser";

/** Synthetic run id prefix for an in-flight remote operation without local materialization yet. */
const REMOTE_LIVE_RUN_PREFIX = "remote-live-";

const AGENT_FAMILIES = new Set([
  "codex",
  "opencode",
  "claude-code",
  "pi",
  "grok",
  "codebuddy"
] as const);
type AgentFamily = "codex" | "opencode" | "claude-code" | "pi" | "grok" | "codebuddy";

export function remoteLiveRunId(operationId: string): string {
  return `${REMOTE_LIVE_RUN_PREFIX}${operationId}`;
}

export function remoteLiveRecordId(blockRef: string, operationId: string): string {
  return `${blockRef}::${remoteLiveRunId(operationId)}`;
}

export function isRemoteLiveRecordId(recordId: string | null | undefined): boolean {
  return typeof recordId === "string" && recordId.includes(`::${REMOTE_LIVE_RUN_PREFIX}`);
}

export function remoteLiveOperationIdFromRecordId(recordId: string): string | null {
  const marker = `::${REMOTE_LIVE_RUN_PREFIX}`;
  const index = recordId.indexOf(marker);
  if (index < 0) return null;
  const operationId = recordId.slice(index + marker.length);
  return operationId.length > 0 ? operationId : null;
}

/**
 * Strip synthetic remote-live selection before calling Runtime APIs that resolve disk run indexes.
 */
export function diskSelectedRecordId(recordId: string | null | undefined): string | null {
  if (!recordId || isRemoteLiveRecordId(recordId)) return null;
  return recordId;
}

/** Map executor / endpoint names to the agent family shown in the timeline. */
export function agentFamilyFromExecutorName(name: string | null | undefined): AgentFamily | null {
  if (!name) return null;
  if (AGENT_FAMILIES.has(name as AgentFamily)) return name as AgentFamily;
  const stripped = name
    .replace(/-acp$/i, "")
    .replace(/-auto$/i, "")
    .replace(/-exec$/i, "");
  if (AGENT_FAMILIES.has(stripped as AgentFamily)) return stripped as AgentFamily;
  if (stripped.startsWith("claude")) return "claude-code";
  return null;
}

export type RemoteLiveAgentHint = {
  executorName: string | null;
  agentId: AgentFamily | null;
};

/**
 * While a remote ACP attempt is preparing/active, inject a live timeline row so the left rail
 * shows 进行中 instead of sticking to the previous completed local run.
 */
export function withRemoteLiveTimelineRuns(
  workspace: TaskWorkspace,
  agentHintByBlockRef: ReadonlyMap<string, RemoteLiveAgentHint> = new Map()
): TaskWorkspace {
  return {
    ...workspace,
    blocks: workspace.blocks.map((block) =>
      injectRemoteLiveRun(block, agentHintByBlockRef.get(block.ref) ?? null)
    )
  };
}

const remoteLiveStartedAtByOperation = new Map<string, string>();

function startedAtForOperation(operationId: string): string {
  const existing = remoteLiveStartedAtByOperation.get(operationId);
  if (existing) return existing;
  const startedAt = new Date().toISOString();
  remoteLiveStartedAtByOperation.set(operationId, startedAt);
  return startedAt;
}

function injectRemoteLiveRun(
  block: TaskWorkspaceBlock,
  hint: RemoteLiveAgentHint | null
): TaskWorkspaceBlock {
  const remote = block.remoteExecution;
  if (!remote || remote.phase === "terminal") return block;
  const runId = remoteLiveRunId(remote.identity.operationId);
  const recordId = remoteLiveRecordId(block.ref, remote.identity.operationId);
  if (block.runs.some((item) => item.run.record.recordId === recordId)) return block;
  const retryIndex = Math.max(0, ...block.runs.map((item) => item.retryIndex), 0) + 1;
  const startedAt = startedAtForOperation(remote.identity.operationId);
  // Prefer explicit Endpoint/block executor — never invent a different agent via silent fallback.
  const executorName = hint?.executorName ?? block.executor ?? block.effectiveExecutor ?? null;
  const agentId =
    hint?.agentId ??
    agentFamilyFromExecutorName(executorName) ??
    agentFamilyFromExecutorName(block.effectiveExecutor);
  const item = taskWorkspaceRunItemSchema.parse({
    retryIndex,
    active: true,
    selected: false,
    waitingInteraction: { active: false, count: 0, kinds: [] },
    run: {
      version: "planweave.task-workspace-run/v1",
      kind: "block",
      record: {
        recordId,
        ref: block.ref,
        taskId: block.taskId,
        blockId: block.blockId,
        runId
      },
      runIdentity: {
        projectId: "project-remote",
        canvasId: "canvas-remote",
        taskId: block.taskId,
        blockId: block.blockId,
        claimRef: block.ref,
        runId,
        runOwner: "executor",
        runSessionId: null,
        desktopRunId: null,
        executorRunId: runId
      },
      metadata: {
        executor: executorName,
        adapter: executorName,
        runnerKind: "acp",
        agentId,
        executionCwd: null,
        projectRoot: null,
        agentSessionId: null,
        tmuxSessionId: null,
        exitCode: null,
        submittedAt: null,
        terminalState: null
      },
      executionWaveId: null,
      duration: {
        startedAt,
        finishedAt: null,
        calculatedAt: startedAt,
        wallClockMs: 0,
        unavailableReason: null
      },
      usage: {
        currentContext: null,
        runTokens: { available: false, totalTokens: null, reason: "Remote live attempt." },
        taskTokens: { available: false, totalTokens: null, reason: "Remote live attempt." }
      },
      actualConfiguration: {
        available: false,
        reason: "Remote live attempt has no local ACP configuration snapshot yet."
      },
      nextActions: { version: "planweave.runner-next-actions/v1", actions: [] },
      capabilities: {
        prompt: {
          available: false,
          reason: "Remote live attempt.",
          identity: null,
          inFlight: false
        },
        cancel: { available: false, reason: "Remote live attempt.", identity: null },
        retry: { available: false, reason: "Remote live attempt.", identity: null },
        recoverAcpSession: {
          available: false,
          reason: { code: "runner_not_acp", message: "Remote live attempt." },
          identity: null
        },
        resume: { available: false, reason: "Remote live attempt.", identity: null }
      }
    }
  });
  return { ...block, runs: [...block.runs, item] };
}
