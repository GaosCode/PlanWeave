import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { activeAgentRunRegistry } from "./activeAgentRunRegistry.js";
import { acpEventReadModels } from "./acpEventReadModel.js";
import type { AcpEventSubscription } from "./acpEventPublisher.js";
import type { AcpEventReadModel } from "./acpEventReadModel.js";
import {
  acpConversationItemSchema,
  projectAcpConversation
} from "./acpConversationProjection.js";
import { normalizedRunnerEventSchema, type NormalizedRunnerEvent } from "./normalizedEventContract.js";
import { redactRunnerEventText, safeRunnerEventTextSchema } from "./runnerEventRedaction.js";
import {
  replayNormalizedRunnerEvents,
  runnerEventCursorSchema,
  runnerEventReplayDiagnosticSchema,
  type RunnerEventCursor,
  type RunnerEventReplayDiagnostic
} from "./runnerEventReplay.js";
import {
  acpSessionIdSchema,
  blockIdSchema,
  canvasIdSchema,
  claimRefSchema,
  desktopRunIdSchema,
  executorRunIdSchema,
  projectIdSchema,
  runnerRequestActionIdentitySchema,
  runnerRunIdSchema,
  runnerSessionActionIdentitySchema,
  runSessionIdSchema,
  taskIdSchema
} from "./runnerContractSchemas.js";

const runnerActionAvailabilitySchema = z
  .object({
    available: z.boolean(),
    reason: z.string().min(1).max(512).nullable()
  })
  .strict();

const runnerRecordActiveInteractionBaseSchema = z
  .object({
    requestId: z.string().min(1).max(256),
    interactionId: z.string().min(1).max(256),
    requestedAt: z.string().datetime(),
    summary: safeRunnerEventTextSchema(4_096, "Active interaction summary").refine(
      (value) => value.length > 0,
      "Active interaction summary must not be empty."
    ),
    identity: runnerRequestActionIdentitySchema,
    availability: runnerActionAvailabilitySchema
  })
  .strict();

const runnerRecordActiveInteractionSchema = z.discriminatedUnion("kind", [
  runnerRecordActiveInteractionBaseSchema.extend({
    kind: z.literal("permission"),
    permissionOptions: z.array(z.object({
      optionId: z.string().min(1).max(256),
      label: safeRunnerEventTextSchema(512, "Permission option label"),
      decision: z.enum(["approve", "deny"])
    }).strict()).min(1)
  }).strict(),
  runnerRecordActiveInteractionBaseSchema.extend({
    kind: z.literal("elicitation"),
    elicitationSchema: z.json()
  }).strict(),
  runnerRecordActiveInteractionBaseSchema.extend({
    kind: z.literal("authentication")
  }).strict()
]);

export const runnerRecordReadModelSchema = z
  .object({
    events: z.array(normalizedRunnerEventSchema),
    conversation: z.array(acpConversationItemSchema),
    diagnostics: z.array(runnerEventReplayDiagnosticSchema),
    cursor: runnerEventCursorSchema,
    terminal: z.boolean(),
    intervention: z.object({
      cancel: runnerActionAvailabilitySchema.extend({
        identity: runnerSessionActionIdentitySchema.nullable()
      }).strict()
    }).strict(),
    interaction: z
      .object({
        persisted: z.boolean(),
        active: z.boolean(),
        stale: z.boolean(),
        activeRequests: z.array(runnerRecordActiveInteractionSchema)
      })
      .strict()
  })
  .strict();
export type RunnerRecordReadModel = z.infer<typeof runnerRecordReadModelSchema>;

export type RunnerRecordReadConsumer = {
  snapshot: RunnerRecordReadModel | null;
  subscription: AcpEventSubscription | null;
};

export type RunnerRecordReadSubscriber = (
  snapshot: RunnerRecordReadModel
) => void | Promise<void>;

function diagnostic(code: RunnerEventReplayDiagnostic["code"], message: string): RunnerEventReplayDiagnostic {
  return { code, line: null, message };
}

export async function readRunnerRecordReadModel(options: {
  runDir: string;
  metadata: Record<string, unknown>;
}): Promise<RunnerRecordReadModel | null> {
  return (await consumeRunnerRecordReadModel(options)).snapshot;
}

const runnerRecordMetadataSchema = z
  .object({
    runId: runnerRunIdSchema,
    claimRef: claimRefSchema.optional(),
    ref: claimRefSchema.optional(),
    projectId: projectIdSchema.optional(),
    canvasId: canvasIdSchema.optional(),
    taskId: taskIdSchema.optional(),
    blockId: blockIdSchema.optional(),
    runSessionId: runSessionIdSchema.nullable().optional(),
    desktopRunId: desktopRunIdSchema.nullable().optional(),
    executorRunId: executorRunIdSchema.nullable().optional(),
    sessionId: acpSessionIdSchema.nullable().optional()
  })
  .passthrough();

type SelectedRecordIdentity = z.infer<typeof runnerRecordMetadataSchema> & {
  claimRef: z.infer<typeof claimRefSchema>;
  taskId: z.infer<typeof taskIdSchema>;
  blockId: z.infer<typeof blockIdSchema>;
};

function selectedRecordIdentity(metadata: Record<string, unknown>): SelectedRecordIdentity {
  const parsed = runnerRecordMetadataSchema.parse(metadata);
  if (parsed.claimRef && parsed.ref && parsed.claimRef !== parsed.ref) {
    throw new Error("ACP run metadata claimRef and ref must match.");
  }
  const claimRef = parsed.claimRef ?? parsed.ref;
  if (!claimRef) throw new Error("ACP run metadata requires a canonical claimRef/ref.");
  const [rawTaskId, rawBlockId] = claimRef.split("#");
  const taskId = taskIdSchema.parse(rawTaskId);
  const blockId = blockIdSchema.parse(rawBlockId);
  if (
    (parsed.taskId !== undefined && parsed.taskId !== taskId) ||
    (parsed.blockId !== undefined && parsed.blockId !== blockId) ||
    (parsed.executorRunId !== undefined &&
      parsed.executorRunId !== null &&
      String(parsed.executorRunId) !== String(parsed.runId))
  ) {
    throw new Error("ACP run metadata identity fields are inconsistent.");
  }
  return { ...parsed, claimRef, taskId, blockId };
}

function identityMismatch(
  events: readonly NormalizedRunnerEvent[],
  selected: SelectedRecordIdentity,
  cursor: RunnerEventCursor
): RunnerEventReplayDiagnostic | null {
  const canonical = cursor.canonicalIdentity?.identity;
  if (
    canonical &&
    (canonical.runId !== selected.runId ||
      canonical.claimRef !== selected.claimRef ||
      canonical.taskId !== selected.taskId ||
      canonical.blockId !== selected.blockId ||
      (selected.projectId !== undefined && canonical.projectId !== selected.projectId) ||
      (selected.canvasId !== undefined && canonical.canvasId !== selected.canvasId) ||
      (selected.runSessionId !== undefined && canonical.runSessionId !== selected.runSessionId) ||
      (selected.desktopRunId !== undefined && canonical.desktopRunId !== selected.desktopRunId) ||
      (selected.executorRunId !== undefined && canonical.executorRunId !== selected.executorRunId))
  ) {
    return diagnostic(
      "identity_mismatch",
      `Runner event identity does not match selected record '${selected.claimRef}'/'${selected.runId}'.`
    );
  }
  const mismatch = events.find((event) =>
    event.identity.runId !== selected.runId ||
    event.identity.claimRef !== selected.claimRef ||
    event.identity.taskId !== selected.taskId ||
    event.identity.blockId !== selected.blockId ||
    (selected.projectId !== undefined && event.identity.projectId !== selected.projectId) ||
    (selected.canvasId !== undefined && event.identity.canvasId !== selected.canvasId) ||
    (selected.runSessionId !== undefined && event.identity.runSessionId !== selected.runSessionId) ||
    (selected.desktopRunId !== undefined && event.identity.desktopRunId !== selected.desktopRunId) ||
    (selected.executorRunId !== undefined && event.identity.executorRunId !== selected.executorRunId) ||
    (selected.sessionId !== undefined &&
      event.correlation !== undefined &&
      event.correlation.sessionId !== selected.sessionId)
  );
  return mismatch
    ? diagnostic(
        "identity_mismatch",
        `Runner event identity does not match selected record '${selected.claimRef}'/'${selected.runId}'.`
      )
    : null;
}

function failedIdentitySnapshot(options: {
  diagnostics?: readonly RunnerEventReplayDiagnostic[];
  cursor?: RunnerEventCursor;
  terminal?: boolean;
  message: string;
}): RunnerRecordReadConsumer {
  return {
    snapshot: {
      events: [],
      conversation: [],
      diagnostics: [
        ...(options.diagnostics ?? []),
        diagnostic("identity_mismatch", options.message)
      ],
      cursor: options.cursor ?? {
        version: "planweave.runner-event-cursor/v1",
        runId: "invalid",
        afterSequence: 0,
        canonicalIdentity: null,
        terminal: false
      },
      terminal: options.terminal ?? false,
      intervention: {
        cancel: {
          available: false,
          reason: "Exact live Desktop ACP session identity is unavailable.",
          identity: null
        }
      },
      interaction: { persisted: false, active: false, stale: false, activeRequests: [] }
    },
    subscription: null
  };
}

function interactionState(
  runDir: string,
  selected: SelectedRecordIdentity,
  cursor: RunnerEventCursor,
  events: readonly NormalizedRunnerEvent[]
): Pick<RunnerRecordReadModel, "interaction" | "intervention"> {
  const persistedRequestIds = new Set<string>(
    events.flatMap((event) => event.body.kind === "interaction"
      ? [event.body.interaction.requestId]
      : [])
  );
  const persisted = persistedRequestIds.size > 0;
  const canonical = cursor.canonicalIdentity?.identity;
  if (!canonical?.executorRunId) {
    return unavailableIntervention(persisted, "Exact runner identity is unavailable.");
  }
  const sessionIds = new Set(
    events.flatMap((event) => event.correlation?.sessionId ? [event.correlation.sessionId] : [])
  );
  const sessionId = selected.sessionId ?? (sessionIds.size === 1 ? [...sessionIds][0] : undefined);
  if (!sessionId) return unavailableIntervention(persisted, "Exact ACP session identity is unavailable.");
  try {
    const registered = activeAgentRunRegistry.lookupExact({
      scope: runDir,
      executorRunId: canonical.executorRunId,
      claimRef: canonical.claimRef,
      ...(canonical.desktopRunId ? { desktopRunId: canonical.desktopRunId } : {}),
      ...(canonical.runSessionId ? { runSessionId: canonical.runSessionId } : {}),
      sessionId
    });
    if (!registered) return unavailableIntervention(persisted, "No live owned ACP session is available.");
    if (
      (registered.identity.runSessionId ?? null) !== canonical.runSessionId ||
      (registered.identity.desktopRunId ?? null) !== canonical.desktopRunId
    ) {
      return unavailableIntervention(persisted, "Live ACP session identity does not match the selected record.");
    }
    if (!canonical.desktopRunId || !canonical.runSessionId) {
      return unavailableIntervention(persisted, "Exact Desktop run/session identity is unavailable.");
    }
    const sessionIdentity = runnerSessionActionIdentitySchema.parse({
      scope: runDir,
      executorRunId: canonical.executorRunId,
      desktopRunId: canonical.desktopRunId,
      runSessionId: canonical.runSessionId,
      claimRef: canonical.claimRef,
      sessionId
    });
    const activeRequests = [...registered.control.pendingRequests.values()]
      .filter((request) => persistedRequestIds.has(request.requestId))
      .map((request) => {
        const identity = runnerRequestActionIdentitySchema.parse({
          ...sessionIdentity,
          requestId: request.requestId
        });
        const base = {
          requestId: request.requestId,
          interactionId: request.interactionId,
          requestedAt: request.requestedAt,
          summary: redactRunnerEventText(request.summary).text,
          identity
        };
        if (request.kind === "permission") {
          const available = registered.control.interventionCapabilities.permission;
          return {
            ...base,
            kind: request.kind,
            permissionOptions: [...request.permissionOptions],
            availability: {
              available,
              reason: available ? null : "Permission intervention is not negotiated for this Desktop ACP session."
            }
          };
        }
        if (request.kind === "elicitation") {
          const available = registered.control.interventionCapabilities.elicitationPreview;
          return {
            ...base,
            kind: request.kind,
            elicitationSchema: request.elicitationSchema,
            availability: {
              available,
              reason: available ? null : "Preview elicitation is not negotiated for this Desktop ACP session."
            }
          };
        }
        return {
          ...base,
          kind: request.kind,
          availability: {
            available: false,
            reason: "Authentication intervention is not supported by the Desktop runner."
          }
        };
      });
    const cancelAvailable =
      registered.control.interventionCapabilities.cancel &&
      (registered.lifecycleState === "running" || registered.lifecycleState === "waiting_interaction");
    return {
      intervention: {
        cancel: {
          available: cancelAvailable,
          reason: cancelAvailable
            ? null
            : registered.control.interventionCapabilities.cancel
              ? `ACP session is not cancellable in state '${registered.lifecycleState}'.`
              : "ACP session cancellation is not negotiated for this Desktop session.",
          identity: sessionIdentity
        }
      },
      interaction: {
        persisted,
        active: activeRequests.length > 0,
        stale: persisted && activeRequests.length === 0,
        activeRequests
      }
    };
  } catch {
    return unavailableIntervention(persisted, "Live ACP session identity could not be verified.");
  }
}

function unavailableIntervention(
  persisted: boolean,
  reason: string
): Pick<RunnerRecordReadModel, "interaction" | "intervention"> {
  return {
    intervention: {
      cancel: { available: false, reason, identity: null }
    },
    interaction: {
      persisted,
      active: false,
      stale: persisted,
      activeRequests: []
    }
  };
}

function activeSnapshot(options: {
  model: AcpEventReadModel;
  runDir: string;
  selected: SelectedRecordIdentity;
  cursor?: RunnerEventCursor;
}): RunnerRecordReadModel {
  const replay = options.model.replay(options.cursor ?? 0);
  const completeReplay = options.cursor ? options.model.replay(0) : replay;
  const mismatch = identityMismatch(completeReplay.events, options.selected, completeReplay.cursor);
  if (mismatch || completeReplay.diagnostics.some((item) => item.code === "identity_mismatch")) {
    throw new Error(mismatch?.message ?? "Runner event stream contains inconsistent identities.");
  }
  return runnerRecordReadModelSchema.parse({
    ...replay,
    ...interactionState(
      options.runDir,
      options.selected,
      completeReplay.cursor,
      completeReplay.events
    )
  });
}

function subscribeActiveModel(options: {
  model: AcpEventReadModel;
  runDir: string;
  selected: SelectedRecordIdentity;
  cursor?: RunnerEventCursor;
  afterSequence: number;
  subscriber: RunnerRecordReadSubscriber;
}): AcpEventSubscription {
  let updateChain = Promise.resolve();
  const emit = (): Promise<void> => {
    updateChain = updateChain.then(() =>
      options.subscriber(activeSnapshot(options))
    );
    return updateChain;
  };
  const eventSubscription = options.model.subscribe(options.afterSequence, emit);
  const unsubscribeInteraction = activeAgentRunRegistry.subscribeInteractionChanges((handle) => {
    if (
      handle.identity.scope !== options.runDir ||
      handle.identity.executorRunId !== options.selected.runId ||
      handle.identity.claimRef !== options.selected.claimRef
    ) {
      return;
    }
    void emit().catch(() => eventSubscription.unsubscribe());
  });
  return {
    unsubscribe: () => {
      unsubscribeInteraction();
      eventSubscription.unsubscribe();
    },
    closed: eventSubscription.closed.then(async () => {
      unsubscribeInteraction();
      await updateChain.catch(() => undefined);
    })
  };
}

export async function consumeRunnerRecordReadModel(options: {
  runDir: string;
  metadata: Record<string, unknown>;
  cursor?: RunnerEventCursor;
  subscriber?: RunnerRecordReadSubscriber;
}): Promise<RunnerRecordReadConsumer> {
  if (options.metadata.runnerKind !== "acp") {
    return { snapshot: null, subscription: null };
  }
  let selected: SelectedRecordIdentity;
  try {
    selected = selectedRecordIdentity(options.metadata);
  } catch {
    return failedIdentitySnapshot({
      message: "ACP run metadata identity is invalid or internally inconsistent."
    });
  }

  const activeModel = acpEventReadModels.get(options.runDir);
  if (activeModel) {
    let snapshot: RunnerRecordReadModel;
    try {
      snapshot = activeSnapshot({
        model: activeModel,
        runDir: options.runDir,
        selected,
        ...(options.cursor ? { cursor: options.cursor } : {})
      });
    } catch {
      return failedIdentitySnapshot({
        cursor: typeof options.cursor === "object" ? options.cursor : undefined,
        message: "Runner event cursor identity does not match the active record."
      });
    }
    if (!options.subscriber || snapshot.terminal) {
      return { snapshot, subscription: null };
    }
    const subscription = subscribeActiveModel({
      model: activeModel,
      runDir: options.runDir,
      selected,
      ...(options.cursor ? { cursor: options.cursor } : {}),
      afterSequence: snapshot.cursor.afterSequence,
      subscriber: options.subscriber
    });
    let authoritativeSnapshot: RunnerRecordReadModel;
    try {
      authoritativeSnapshot = activeSnapshot({
        model: activeModel,
        runDir: options.runDir,
        selected,
        ...(options.cursor ? { cursor: options.cursor } : {})
      });
    } catch {
      subscription.unsubscribe();
      return failedIdentitySnapshot({
        cursor: snapshot.cursor,
        message: "Runner event identity changed during subscription registration."
      });
    }
    if (authoritativeSnapshot.terminal) {
      subscription.unsubscribe();
      return { snapshot: authoritativeSnapshot, subscription: null };
    }
    return { snapshot: authoritativeSnapshot, subscription };
  }

  let content = "";
  const boundaryDiagnostics: RunnerEventReplayDiagnostic[] = [];
  try {
    content = await readFile(join(options.runDir, "events.ndjson"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      boundaryDiagnostics.push(diagnostic("missing_log", "Normalized ACP event log does not exist."));
    } else {
      throw error;
    }
  }
  const replay = replayNormalizedRunnerEvents({
    content,
    runId: selected.runId,
    ...(options.cursor ? { cursor: options.cursor } : {})
  });
  const mismatch = identityMismatch(replay.events, selected, replay.nextCursor);
  if (mismatch || replay.diagnostics.some((item) => item.code === "identity_mismatch")) {
    return failedIdentitySnapshot({
      diagnostics: [...boundaryDiagnostics, ...replay.diagnostics],
      cursor: replay.nextCursor,
      terminal: replay.terminal,
      message: mismatch?.message ?? "Runner event stream contains inconsistent identities."
    });
  }
  const completeReplay = options.cursor
    ? replayNormalizedRunnerEvents({ content, runId: selected.runId })
    : replay;
  return {
    snapshot: runnerRecordReadModelSchema.parse({
      events: replay.events,
      conversation: projectAcpConversation(replay.events),
      diagnostics: [...boundaryDiagnostics, ...replay.diagnostics],
      cursor: replay.nextCursor,
      terminal: replay.terminal,
      ...interactionState(
        options.runDir,
        selected,
        completeReplay.nextCursor,
        completeReplay.events
      )
    }),
    subscription: null
  };
}

export async function readRunnerRecordReadModelForArtifact(
  artifactPath: string | null
): Promise<RunnerRecordReadModel | null> {
  if (!artifactPath) return null;
  const runDir = dirname(artifactPath);
  const metadata = JSON.parse(await readFile(join(runDir, "metadata.json"), "utf8")) as unknown;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw new Error(`Runner metadata at '${join(runDir, "metadata.json")}' must be an object.`);
  }
  return readRunnerRecordReadModel({ runDir, metadata: metadata as Record<string, unknown> });
}
