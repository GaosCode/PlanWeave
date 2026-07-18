import { basename, dirname } from "node:path";
import { z } from "zod";
import { acpConversationTurns } from "../autoRun/acpConversationTurn.js";
import { acpEventReadModels } from "../autoRun/acpEventReadModel.js";
import {
  createAcpEventSubscriptionCloseResult,
  type AcpEventSubscriptionCloseResult
} from "../autoRun/acpEventPublisher.js";
import { builtinAgentProfiles, resolveAgentDefinition } from "../autoRun/agentRegistry.js";
import { requireAcpLaunch } from "../autoRun/acpLaunch.js";
import { DEFAULT_EXECUTOR_TIMEOUT_MS, workspaceExecutionCwd } from "../autoRun/executorShared.js";
import {
  consumeRunnerRecordReadModel,
  desktopAgentPromptIdentitySchema,
  type DesktopAgentPromptIdentity,
  type RunnerRecordReadConsumer,
  type RunnerRecordReadSubscriber
} from "../autoRun/runnerRecordReadModel.js";
import {
  acpSessionIdSchema,
  acpCorrelationSchema,
  claimRefSchema,
  desktopRunIdSchema,
  executorRunIdSchema,
  runSessionIdSchema,
  runnerIdentitySchema,
  runnerRunIdentitySchema,
  runnerSessionActionIdentitySchema
} from "../autoRun/runnerContractSchemas.js";
import type { RunnerEventCursor } from "../autoRun/runnerEventReplay.js";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { loadPackage } from "../package/loadPackage.js";
import {
  agentFamilySchema,
  type AgentExecutorProfile,
  type ExecutorProfile,
  type ProjectWorkspace
} from "../types.js";
import {
  assertDesktopAgentRunControlAccepted,
  executeDesktopAgentRunControl
} from "./agentRunControlApi.js";

const acpPromptMetadataBaseSchema = z
  .object({
    runId: z.string().min(1).max(256),
    executorRunId: executorRunIdSchema,
    claimRef: claimRefSchema,
    sessionId: acpSessionIdSchema,
    agentId: agentFamilySchema,
    runnerKind: z.literal("acp"),
    executor: z.string().min(1).max(256),
    runSessionId: runSessionIdSchema.nullable().optional(),
    desktopRunId: desktopRunIdSchema.nullable().optional()
  })
  .passthrough();

const completedAcpMetadataSchema = acpPromptMetadataBaseSchema.extend({
  status: z.literal("completed"),
  outcome: z.literal("succeeded"),
  capabilities: z.object({ loadSession: z.literal(true) }).passthrough()
});

const liveAcpMetadataSchema = acpPromptMetadataBaseSchema.extend({
  status: z.literal("running"),
  desktopRunId: desktopRunIdSchema,
  runSessionId: runSessionIdSchema
});

export type CompletedAcpMetadata = z.infer<typeof completedAcpMetadataSchema>;
export type LiveAcpMetadata = z.infer<typeof liveAcpMetadataSchema>;

export type AcpPromptContext =
  | {
      available: true;
      mode: "completed";
      runDir: string;
      metadata: CompletedAcpMetadata;
      identity: DesktopAgentPromptIdentity;
    }
  | {
      available: true;
      mode: "live";
      runDir: string;
      metadata: LiveAcpMetadata;
      identity: DesktopAgentPromptIdentity;
    }
  | { available: false; reason: string };

export function resolveAcpPromptContext(options: {
  workspace: ProjectWorkspace;
  recordId: string;
  blockRef: string | null;
  runId: string | null;
  runDir: string | null;
  metadata: Record<string, unknown>;
}): AcpPromptContext {
  if (!(options.blockRef && options.runId && options.runDir)) {
    return {
      available: false,
      reason: "ACP conversation turns are only available for block run records."
    };
  }
  const completedMetadata = completedAcpMetadataSchema.safeParse(options.metadata);
  const liveMetadata = liveAcpMetadataSchema.safeParse(options.metadata);
  if (!(completedMetadata.success || liveMetadata.success)) {
    return {
      available: false,
      reason: "This record is not a completed ACP run with session/load capability."
    };
  }
  const metadata = completedMetadata.success
    ? completedMetadata.data
    : liveMetadata.success
      ? liveMetadata.data
      : null;
  if (!metadata) {
    return {
      available: false,
      reason: "This record is not a completed or live ACP run with prompt capability."
    };
  }
  if (
    metadata.runId !== options.runId ||
    metadata.executorRunId !== options.runId ||
    metadata.claimRef !== options.blockRef
  ) {
    return {
      available: false,
      reason: "ACP record identity does not match its persisted metadata."
    };
  }
  const identity = desktopAgentPromptIdentitySchema.parse({
    ref: {
      projectRoot: options.workspace.rootPath,
      canvasId: basename(dirname(options.workspace.packageDir))
    },
    recordId: options.recordId,
    executorRunId: metadata.executorRunId,
    claimRef: metadata.claimRef,
    sessionId: metadata.sessionId
  });
  if (liveMetadata.success) {
    return {
      available: true,
      mode: "live",
      runDir: options.runDir,
      metadata: liveMetadata.data,
      identity
    };
  }
  if (completedMetadata.success) {
    return {
      available: true,
      mode: "completed",
      runDir: options.runDir,
      metadata: completedMetadata.data,
      identity
    };
  }
  return {
    available: false,
    reason: "This record is not a completed or live ACP run with prompt capability."
  };
}

export function acpPromptReadOptions(context: AcpPromptContext) {
  return context.available
    ? {
        promptIdentity: context.identity,
        promptContinuationAvailable: context.mode === "completed",
        promptInFlight: acpConversationTurns.isInFlight(context.runDir)
      }
    : {};
}

async function promptEventModel(options: {
  workspace: ProjectWorkspace;
  context: Extract<AcpPromptContext, { available: true }>;
}) {
  const existing = acpEventReadModels.get(options.context.runDir);
  if (existing) return existing;
  const authority = promptEventAuthority(options);
  return acpEventReadModels.create({
    runDir: options.context.runDir,
    ...authority
  });
}

function promptEventAuthority(options: {
  workspace: ProjectWorkspace;
  context: Extract<AcpPromptContext, { available: true }>;
}) {
  const { taskId, blockId } = parseBlockRef(options.context.metadata.claimRef);
  return {
    identity: runnerRunIdentitySchema.parse({
      projectId: options.workspace.id,
      canvasId: basename(dirname(options.workspace.packageDir)),
      taskId,
      blockId,
      claimRef: options.context.metadata.claimRef,
      runId: options.context.metadata.executorRunId,
      runOwner: "executor",
      runSessionId: options.context.metadata.runSessionId ?? null,
      desktopRunId: options.context.metadata.desktopRunId ?? null,
      executorRunId: options.context.metadata.executorRunId
    }),
    runner: runnerIdentitySchema.parse({
      version: "planweave.runner/v1",
      runnerKind: "acp",
      agentId: options.context.metadata.agentId
    })
  };
}

async function verifiedPromptEventStore(options: {
  workspace: ProjectWorkspace;
  context: Extract<AcpPromptContext, { available: true }>;
}) {
  const model = await promptEventModel(options);
  const expectedSessionId = acpCorrelationSchema.parse({
    sessionId: options.context.metadata.sessionId
  }).sessionId;
  const authority = promptEventAuthority(options);
  const canonical = model.store.canonicalIdentity();
  if (JSON.stringify(canonical.identity) !== JSON.stringify(authority.identity)) {
    throw new Error("ACP event log identity does not match the persisted run record.");
  }
  if (JSON.stringify(canonical.runner) !== JSON.stringify(authority.runner)) {
    throw new Error("ACP event log runner does not match the persisted run metadata.");
  }
  const events = model.replay(0).events;
  const sessionIds = new Set(
    events.flatMap((event) => (event.correlation?.sessionId ? [event.correlation.sessionId] : []))
  );
  if (sessionIds.size !== 1 || !sessionIds.has(expectedSessionId)) {
    throw new Error("ACP event log session does not match the persisted run metadata.");
  }
  const agentIds = new Set(events.map((event) => event.runner.agentId));
  if (agentIds.size !== 1 || !agentIds.has(options.context.metadata.agentId)) {
    throw new Error("ACP event log agent does not match the persisted run metadata.");
  }
  const terminalEvents = events.filter((event) => event.body.kind === "terminal");
  if (terminalEvents.length !== 1) {
    throw new Error("ACP event log must contain exactly one durable terminal event.");
  }
  const terminal = terminalEvents[0];
  if (
    terminal.correlation?.sessionId !== expectedSessionId ||
    terminal.body.kind !== "terminal" ||
    terminal.body.outcome.state !== "succeeded" ||
    terminal.body.outcome.artifactValidated !== true
  ) {
    throw new Error("ACP event log is not a successfully completed run with a validated artifact.");
  }
  return model.store.completedConversationWriter(expectedSessionId);
}

function assertAcpPromptProfile(
  name: string,
  profile: ExecutorProfile | undefined,
  metadata: CompletedAcpMetadata
): AgentExecutorProfile {
  if (!profile) {
    throw new Error(`ACP executor profile '${name}' is no longer available.`);
  }
  if (
    profile.adapter !== "agent" ||
    profile.runner.transport !== "acp" ||
    profile.agent !== metadata.agentId
  ) {
    throw new Error(
      `Executor profile '${name}' does not match the completed ${metadata.agentId} ACP run.`
    );
  }
  return profile;
}

function resolveAcpPromptProfile(
  manifestExecutors: Readonly<Record<string, ExecutorProfile>> | undefined,
  metadata: CompletedAcpMetadata
): AgentExecutorProfile {
  if (manifestExecutors && Object.hasOwn(manifestExecutors, metadata.executor)) {
    return assertAcpPromptProfile(
      metadata.executor,
      manifestExecutors[metadata.executor],
      metadata
    );
  }
  const builtins = builtinAgentProfiles();
  const exact = builtins[metadata.executor];
  if (exact?.runner.transport === "acp") {
    return assertAcpPromptProfile(metadata.executor, exact, metadata);
  }
  if (metadata.executor === metadata.agentId) {
    const canonicalAcpName = `${metadata.agentId}-acp`;
    return assertAcpPromptProfile(canonicalAcpName, builtins[canonicalAcpName], metadata);
  }
  throw new Error(`ACP executor profile '${metadata.executor}' is no longer available.`);
}

export async function consumeAcpPromptRunRecord(
  options: {
    context: AcpPromptContext;
    runDir: string;
    metadata: Record<string, unknown>;
    cursor: RunnerEventCursor | undefined;
    subscriber: RunnerRecordReadSubscriber;
  },
  dependencies: {
    consume: typeof consumeRunnerRecordReadModel;
    subscribeTurn: (key: string, subscriber: () => void | Promise<void>) => () => void;
  } = {
    consume: consumeRunnerRecordReadModel,
    subscribeTurn: (key, subscriber) => acpConversationTurns.subscribe(key, subscriber)
  }
): Promise<RunnerRecordReadConsumer> {
  const consumer = await dependencies.consume({
    runDir: options.runDir,
    metadata: options.metadata,
    cursor: options.cursor,
    subscriber: options.subscriber,
    ...acpPromptReadOptions(options.context)
  });
  if (!options.context.available) return consumer;
  let closed = false;
  let resolveClosed = (_result: AcpEventSubscriptionCloseResult): void => undefined;
  let refreshTail = Promise.resolve();
  const closedPromise = new Promise<AcpEventSubscriptionCloseResult>((resolve) => {
    resolveClosed = resolve;
  });
  const unsubscribeTurn = dependencies.subscribeTurn(options.context.runDir, () => {
    const refresh = refreshTail.then(async () => {
      if (closed) return;
      const refreshed = await dependencies.consume({
        runDir: options.runDir,
        metadata: options.metadata,
        cursor: options.cursor,
        ...acpPromptReadOptions(options.context)
      });
      if (closed) return;
      if (refreshed.snapshot) await options.subscriber(refreshed.snapshot);
    });
    refreshTail = refresh.catch(() => undefined);
    return refresh;
  });
  const settleClosed = async (
    preferred: AcpEventSubscriptionCloseResult | undefined
  ): Promise<void> => {
    const fallback = preferred ?? createAcpEventSubscriptionCloseResult("explicit_unsubscribe", 0);
    const underlyingClosed = consumer.subscription?.closed ?? Promise.resolve(fallback);
    const [underlying] = await Promise.allSettled([underlyingClosed, refreshTail]);
    if (preferred) {
      resolveClosed(preferred);
      return;
    }
    if (
      underlying.status === "fulfilled" &&
      underlying.value &&
      typeof underlying.value === "object"
    ) {
      resolveClosed(underlying.value);
      return;
    }
    resolveClosed(fallback);
  };
  const close = (preferred?: AcpEventSubscriptionCloseResult): void => {
    if (closed) return;
    closed = true;
    unsubscribeTurn();
    // Prefer the publisher close reason when the underlying subscription ended first.
    // Explicit outer unsubscribe still calls underlying unsubscribe, which resolves the same reason.
    if (!preferred) {
      consumer.subscription?.unsubscribe();
    } else if (consumer.subscription) {
      // Underlying already closed; still invoke unsubscribe for idempotent cleanup.
      consumer.subscription.unsubscribe();
    }
    void settleClosed(preferred);
  };
  if (consumer.subscription) {
    void consumer.subscription.closed.then((result) => close(result));
  }
  return {
    snapshot: consumer.snapshot,
    subscription: { unsubscribe: () => close(), closed: closedPromise }
  };
}

export async function continueAcpPrompt(options: {
  workspace: ProjectWorkspace;
  context: Extract<AcpPromptContext, { available: true }> & { mode: "completed" };
  text: string;
}): Promise<void> {
  const definition = resolveAgentDefinition(options.context.metadata.agentId);
  const launch = requireAcpLaunch(definition);
  const { manifest } = await loadPackage(options.workspace);
  const profile = resolveAcpPromptProfile(manifest.executors, options.context.metadata);
  await acpConversationTurns.send({
    key: options.context.runDir,
    cwd: workspaceExecutionCwd(options.workspace),
    sessionId: options.context.metadata.sessionId,
    agentId: options.context.metadata.agentId,
    launch: { command: launch.command, args: launch.args },
    authenticationHints: definition.acp.authentication,
    text: options.text,
    timeoutMs: profile.timeoutMs ?? DEFAULT_EXECUTOR_TIMEOUT_MS,
    eventStore: async () => verifiedPromptEventStore(options)
  });
}

export async function queueLiveAcpPrompt(options: {
  context: Extract<AcpPromptContext, { available: true }> & { mode: "live" };
  text: string;
}): Promise<void> {
  const metadata = options.context.metadata;
  if (!(metadata.desktopRunId && metadata.runSessionId)) {
    return Promise.reject(
      new Error("Live ACP prompt requires exact Desktop run/session identity.")
    );
  }
  const response = await executeDesktopAgentRunControl({
    ref: options.context.identity.ref,
    recordId: options.context.identity.recordId,
    action: {
      kind: "follow_up",
      identity: runnerSessionActionIdentitySchema.parse({
        scope: options.context.runDir,
        executorRunId: metadata.executorRunId,
        desktopRunId: metadata.desktopRunId,
        runSessionId: metadata.runSessionId,
        claimRef: metadata.claimRef,
        sessionId: metadata.sessionId
      }),
      prompt: options.text
    }
  });
  assertDesktopAgentRunControlAccepted(response);
}
