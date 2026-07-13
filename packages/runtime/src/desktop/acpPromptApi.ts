import { basename, dirname } from "node:path";
import { z } from "zod";
import { acpConversationTurns } from "../autoRun/acpConversationTurn.js";
import { acpEventReadModels } from "../autoRun/acpEventReadModel.js";
import { builtinAgentProfiles, resolveAgentDefinition } from "../autoRun/agentRegistry.js";
import { requireAcpLaunch } from "../autoRun/acpLaunch.js";
import {
  DEFAULT_EXECUTOR_TIMEOUT_MS,
  workspaceExecutionCwd
} from "../autoRun/executorShared.js";
import {
  consumeRunnerRecordReadModel,
  desktopAgentPromptIdentitySchema,
  type DesktopAgentPromptIdentity,
  type RunnerRecordReadConsumer,
  type RunnerRecordReadSubscriber
} from "../autoRun/runnerRecordReadModel.js";
import {
  acpCorrelationSchema,
  runnerIdentitySchema,
  runnerRunIdentitySchema
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

const completedAcpMetadataSchema = z
  .object({
    runId: z.string().min(1).max(256),
    executorRunId: z.string().min(1).max(256),
    claimRef: z.string().min(3).max(513),
    sessionId: z.string().min(1).max(256),
    agentId: agentFamilySchema,
    runnerKind: z.literal("acp"),
    status: z.literal("completed"),
    outcome: z.literal("succeeded"),
    executor: z.string().min(1).max(256),
    runSessionId: z.string().min(1).max(256).nullable().optional(),
    desktopRunId: z.string().min(1).max(256).nullable().optional(),
    capabilities: z.object({ loadSession: z.literal(true) }).passthrough()
  })
  .passthrough();

export type CompletedAcpMetadata = z.infer<typeof completedAcpMetadataSchema>;

export type AcpPromptContext =
  | {
      available: true;
      runDir: string;
      metadata: CompletedAcpMetadata;
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
  if (!options.blockRef || !options.runId || !options.runDir) {
    return {
      available: false,
      reason: "ACP conversation turns are only available for block run records."
    };
  }
  const parsedMetadata = completedAcpMetadataSchema.safeParse(options.metadata);
  if (!parsedMetadata.success) {
    return {
      available: false,
      reason: "This record is not a completed ACP run with session/load capability."
    };
  }
  const metadata = parsedMetadata.data;
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
  return {
    available: true,
    runDir: options.runDir,
    metadata,
    identity: desktopAgentPromptIdentitySchema.parse({
      ref: {
        projectRoot: options.workspace.rootPath,
        canvasId: basename(dirname(options.workspace.packageDir))
      },
      recordId: options.recordId,
      executorRunId: metadata.executorRunId,
      claimRef: metadata.claimRef,
      sessionId: metadata.sessionId
    })
  };
}

export function acpPromptReadOptions(context: AcpPromptContext) {
  return context.available
    ? {
        promptIdentity: context.identity,
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
  if (
    JSON.stringify(canonical.runner) !== JSON.stringify(authority.runner)
  ) {
    throw new Error("ACP event log runner does not match the persisted run metadata.");
  }
  const events = model.replay(0).events;
  const sessionIds = new Set(
    events.flatMap((event) => event.correlation?.sessionId ? [event.correlation.sessionId] : [])
  );
  if (sessionIds.size !== 1 || !sessionIds.has(expectedSessionId)) {
    throw new Error("ACP event log session does not match the persisted run metadata.");
  }
  const agentIds = new Set(events.map((event) => event.runner.agentId));
  if (
    agentIds.size !== 1 ||
    !agentIds.has(options.context.metadata.agentId)
  ) {
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
    throw new Error(
      "ACP event log is not a successfully completed run with a validated artifact."
    );
  }
  return model.store;
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

export async function consumeAcpPromptRunRecord(options: {
  context: AcpPromptContext;
  runDir: string;
  metadata: Record<string, unknown>;
  cursor: RunnerEventCursor | undefined;
  subscriber: RunnerRecordReadSubscriber;
}, dependencies: {
  consume: typeof consumeRunnerRecordReadModel;
  subscribeTurn: (
    key: string,
    subscriber: () => void | Promise<void>
  ) => () => void;
} = {
  consume: consumeRunnerRecordReadModel,
  subscribeTurn: (key, subscriber) => acpConversationTurns.subscribe(key, subscriber)
}): Promise<RunnerRecordReadConsumer> {
  const consumer = await dependencies.consume({
    runDir: options.runDir,
    metadata: options.metadata,
    cursor: options.cursor,
    subscriber: options.subscriber,
    ...acpPromptReadOptions(options.context)
  });
  if (!options.context.available) return consumer;
  let closed = false;
  let resolveClosed = (): void => undefined;
  let refreshTail = Promise.resolve();
  const closedPromise = new Promise<void>((resolve) => {
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
  const close = (): void => {
    if (closed) return;
    closed = true;
    unsubscribeTurn();
    consumer.subscription?.unsubscribe();
    const underlyingClosed = consumer.subscription?.closed ?? Promise.resolve();
    void Promise.allSettled([underlyingClosed, refreshTail]).then(() => resolveClosed());
  };
  if (consumer.subscription) void consumer.subscription.closed.then(close);
  return {
    snapshot: consumer.snapshot,
    subscription: { unsubscribe: close, closed: closedPromise }
  };
}

export async function continueAcpPrompt(options: {
  workspace: ProjectWorkspace;
  context: Extract<AcpPromptContext, { available: true }>;
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
    text: options.text,
    timeoutMs: profile.timeoutMs ?? DEFAULT_EXECUTOR_TIMEOUT_MS,
    eventStore: async () => verifiedPromptEventStore(options)
  });
}
